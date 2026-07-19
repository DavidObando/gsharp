// <copyright file="MemberLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// PR-B-2: the binder-facing facade for "given a type T and a member name N,
/// return the candidates". Delegates low-level CLR member walks (including
/// inherited interfaces) to <see cref="ClrTypeUtilities"/> and user-symbol
/// scope lookups to <see cref="BoundScope"/> via <see cref="BinderContext"/>.
/// </summary>
/// <remarks>
/// <para>
/// This type is deliberately <em>pure</em>: it does not emit diagnostics,
/// it does not construct <c>BoundExpression</c> values, and it does not
/// mutate <see cref="BinderContext.NarrowedVariables"/> or
/// <see cref="BinderContext.LoopStack"/>. The cache fields on
/// <see cref="BinderContext"/> for imported <c>[Extension]</c> classes
/// (<see cref="BinderContext.CachedImportedExtensionClasses"/> and
/// <see cref="BinderContext.CachedImportedExtensionImportCount"/>) are
/// intentionally written by <see cref="GetImportedExtensionClasses"/> —
/// those fields exist on the context precisely so this facade can populate
/// them.
/// </para>
/// <para>
/// All decisions about "what to do with no candidate" — diagnostic emission
/// (e.g. <c>GS0159</c>, <c>GS0125</c>, <c>GS0187</c>), error-recovery
/// <c>BoundErrorExpression</c> construction, narrowing-state updates — live
/// on the caller in <see cref="Binder"/>.
/// </para>
/// </remarks>
internal sealed class MemberLookup
{
    private readonly BinderContext binderCtx;

    /// <summary>
    /// Process-wide memoization backing <see cref="SafeGetMethodsIncludingSelfAndInterfaces"/>,
    /// keyed on the CLR <see cref="Type"/> plus the probed method name.
    /// Cleared via <see cref="ClearCache"/> (wired into
    /// <see cref="ReferenceResolver.Dispose"/>) so entries keyed on a disposed
    /// <c>MetadataLoadContext</c>'s <see cref="Type"/> instances do not pin
    /// that context's memory for the process lifetime (#1622-style leak).
    /// </summary>
    private static ConditionalWeakTable<Type, System.Collections.Concurrent.ConcurrentDictionary<string, IReadOnlyList<MethodInfo>>> methodsIncludingSelfAndInterfacesCache = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="MemberLookup"/> class.
    /// </summary>
    /// <param name="binderCtx">The shared binder context that exposes the
    /// reference resolver, the root <see cref="BoundScope"/>, and the
    /// imported-extension cache fields.</param>
    public MemberLookup(BinderContext binderCtx)
    {
        this.binderCtx = binderCtx ?? throw new ArgumentNullException(nameof(binderCtx));
    }

    // ----- CLR-side type walks -----

    /// <summary>
    /// Enumerates <paramref name="t"/> followed by every interface it
    /// implements (direct and inherited). The common building block used by
    /// the dictionary/enumerable shape probes below — kept here so future
    /// fixes for #568/#572/#573 (which all need the same interface walk) can
    /// reuse one helper.
    /// </summary>
    /// <param name="t">The starting CLR type.</param>
    /// <returns>The type and its interfaces in walk order.</returns>
    public static IEnumerable<Type> EnumerateSelfAndInterfaces(Type t)
    {
        yield return t;
        foreach (var i in t.GetInterfaces())
        {
            yield return i;
        }
    }

    /// <summary>
    /// Returns source-declared instance methods visible on a receiver-like type.
    /// Keeps diagnostics/private-interface handling at the call site.
    /// </summary>
    /// <param name="receiverType">The receiver or constraint type to inspect.</param>
    /// <param name="methodName">The method name to match.</param>
    /// <returns>The source-declared method candidates in existing lookup order.</returns>
    public static ImmutableArray<FunctionSymbol> CollectSourceInstanceMethods(TypeSymbol receiverType, string methodName)
    {
        return receiverType switch
        {
            StructSymbol structRecv => TypeMemberModel.GetMethods(structRecv, methodName, MemberQuery.Instance(MemberKinds.Method)),
            InterfaceSymbol ifaceRecv => TypeMemberModel.GetMethods(ifaceRecv, methodName, MemberQuery.Instance(MemberKinds.Method)),
            TypeParameterSymbol { InterfaceConstraint: { } constraint } => TypeMemberModel.GetMethods(constraint, methodName, MemberQuery.Instance(MemberKinds.Method)),
            TypeParameterSymbol { ClassConstraint: StructSymbol classConstraint } => TypeMemberModel.GetMethods(classConstraint, methodName, MemberQuery.Instance(MemberKinds.Method)),
            _ => ImmutableArray<FunctionSymbol>.Empty,
        };
    }

    /// <summary>
    /// Walks <paramref name="clrType"/> and its transitive implemented interfaces
    /// looking for a public instance method whose name matches <paramref name="name"/>.
    /// Closes the post-#529 gap for *concrete* receivers — <c>*IncludingInterfaces</c>
    /// in <see cref="ClrTypeUtilities"/> only walks interfaces when the receiver is itself
    /// an interface; this helper extends the walk to concrete classes for the
    /// #568 / #572 family.
    /// </summary>
    /// <param name="clrType">The CLR type (concrete class or interface) to probe.</param>
    /// <param name="name">The method name to match.</param>
    /// <param name="parameterTypes">Optional parameter types for exact-match filtering.
    /// Pass <c>null</c> to match by name only (first hit).</param>
    /// <returns>The matching <see cref="MethodInfo"/>, or <c>null</c> when none is found.</returns>
    public static MethodInfo SafeGetMethodIncludingSelfAndInterfaces(Type clrType, string name, Type[] parameterTypes = null)
    {
        if (clrType == null)
        {
            return null;
        }

        foreach (var type in EnumerateSelfAndInterfaces(clrType))
        {
            MethodInfo method;
            try
            {
                method = parameterTypes != null
                    ? type.GetMethod(name, BindingFlags.Public | BindingFlags.Instance, binder: null, types: parameterTypes, modifiers: null)
                    : type.GetMethod(name, BindingFlags.Public | BindingFlags.Instance);
            }
            catch
            {
                continue;
            }

            if (method != null)
            {
                return method;
            }
        }

        return null;
    }

    /// <summary>
    /// Enumerates every public instance method on <paramref name="clrType"/>
    /// and its transitive implemented interfaces with the given <paramref name="name"/>.
    /// The overload-resolution-facing variant, used by call sites that need to
    /// pass a candidate set into <see cref="OverloadResolution.Resolve"/>.
    /// Hides base-method-with-same-signature shadowing the same way C# does
    /// (via the existing <c>IsHiddenByExisting</c> helper in <see cref="ClrTypeUtilities"/>).
    /// </summary>
    /// <param name="clrType">The CLR type (concrete class or interface) to probe.</param>
    /// <param name="name">The method name to match.</param>
    /// <returns>The candidate list with self-slot methods first.</returns>
    public static IReadOnlyList<MethodInfo> SafeGetMethodsIncludingSelfAndInterfaces(Type clrType, string name)
    {
        if (clrType == null)
        {
            return Array.Empty<MethodInfo>();
        }

        // Issue #1678: this result is recomputed identically at every call
        // site that probes the same (type, name) pair — e.g. the "does this
        // type have an accessible Add?" collection-initializer check runs once
        // per collection-literal expression against the same receiver type.
        // ClrTypeUtilities.SafeGetMethods/SafeGetInterfaces are themselves
        // memoized per Type now, but the name filter and the O(result ×
        // candidates) IsMethodHiddenByExisting dedup below still re-ran on
        // every call before this cache existed. Keyed on the CLR Type (not the
        // GSharp symbol) so it is naturally invalidated by
        // ClrTypeUtilities.ClearCache() clearing the caches it reads from.
        return methodsIncludingSelfAndInterfacesCache
            .GetValue(clrType, static _ => new System.Collections.Concurrent.ConcurrentDictionary<string, IReadOnlyList<MethodInfo>>(StringComparer.Ordinal))
            .GetOrAdd(name, n =>
        {
            var selfMethods = ClrTypeUtilities.SafeGetMethods(clrType, BindingFlags.Public | BindingFlags.Instance);
            var result = new List<MethodInfo>();
            foreach (var m in selfMethods)
            {
                if (string.Equals(m.Name, n, StringComparison.Ordinal))
                {
                    result.Add(m);
                }
            }

            // Walk transitive interfaces for DIMs not surfaced by the concrete type.
            foreach (var iface in ClrTypeUtilities.SafeGetInterfaces(clrType))
            {
                foreach (var m in ClrTypeUtilities.SafeGetMethods(iface, BindingFlags.Public | BindingFlags.Instance))
                {
                    if (!string.Equals(m.Name, n, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (!IsMethodHiddenByExisting(result, m))
                    {
                        result.Add(m);
                    }
                }
            }

            return result;
        });
    }

    /// <summary>
    /// Walks <paramref name="clrType"/> and its transitive implemented interfaces
    /// looking for a public instance property whose name matches <paramref name="name"/>.
    /// The concrete-receiver companion to <see cref="ClrTypeUtilities.SafeGetPropertyIncludingInterfaces"/>
    /// (which only walks interfaces when the receiver is itself an interface).
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="name">The property name to match.</param>
    /// <returns>The matching <see cref="PropertyInfo"/>, or <c>null</c> when none is found.</returns>
    public static PropertyInfo SafeGetPropertyIncludingSelfAndInterfaces(Type clrType, string name)
    {
        if (clrType == null)
        {
            return null;
        }

        var direct = ClrTypeUtilities.SafeGetProperty(clrType, name, BindingFlags.Public | BindingFlags.Instance);
        if (direct != null)
        {
            return direct;
        }

        foreach (var iface in ClrTypeUtilities.SafeGetInterfaces(clrType))
        {
            var prop = ClrTypeUtilities.SafeGetProperty(iface, name, BindingFlags.Public | BindingFlags.Instance);
            if (prop != null)
            {
                return prop;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #1181: collects the transitive closure of imported/BCL base
    /// interfaces declared on <paramref name="interfaceSymbol"/>. Delegates
    /// to <see cref="ClrTypeUtilities.GetTransitiveClrBaseInterfaces"/>.
    /// </summary>
    /// <param name="interfaceSymbol">The user interface whose imported base interfaces to collect.</param>
    /// <returns>The transitive CLR base interface <see cref="Type"/>s, each appearing once.</returns>
    public static IReadOnlyList<Type> GetTransitiveClrBaseInterfaces(InterfaceSymbol interfaceSymbol)
        => ClrTypeUtilities.GetTransitiveClrBaseInterfaces(interfaceSymbol);

    /// <summary>
    /// Issue #1181: returns whether <paramref name="candidate"/> already has a
    /// same-name, same-parameter-types entry in <paramref name="existing"/>
    /// (structural CLR comparison via <see cref="ClrTypeUtilities.AreSame"/>).
    /// Used to dedupe imported base-interface methods projected onto a user
    /// interface receiver so a signature surfaced by two related interfaces
    /// (e.g. <c>IEnumerable&lt;T&gt;</c> and <c>IEnumerable</c>) is not added
    /// twice into an overload set.
    /// </summary>
    /// <param name="existing">The methods collected so far.</param>
    /// <param name="candidate">The candidate method to test.</param>
    /// <returns>True when a structurally-equal signature is already present.</returns>
    public static bool HasSameSignature(IReadOnlyList<MethodInfo> existing, MethodInfo candidate)
    {
        foreach (var m in existing)
        {
            if (!string.Equals(m.Name, candidate.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var existingParams = m.GetParameters();
            var candidateParams = candidate.GetParameters();
            if (existingParams.Length != candidateParams.Length)
            {
                continue;
            }

            var match = true;
            for (var i = 0; i < existingParams.Length; i++)
            {
                if (!ClrTypeUtilities.AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType))
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns the G# field on <paramref name="structSymbol"/> that satisfies
    /// the property contract of <paramref name="clrProp"/>: same name, the
    /// field's type's CLR projection matches the property's PropertyType, and
    /// the field is publicly accessible. For read-write contracts (setter
    /// present), the field must additionally be mutable (not read-only).
    /// Returns <c>null</c> when no such field exists.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="clrProp">The CLR property whose contract to check.</param>
    /// <returns>The matching <see cref="FieldSymbol"/>, or <c>null</c>.</returns>
    public static FieldSymbol FindMatchingFieldForPropertyContract(StructSymbol structSymbol, PropertyInfo clrProp)
    {
        if (!structSymbol.TryGetField(clrProp.Name, out var field))
        {
            return null;
        }

        if (field.Accessibility != Accessibility.Public)
        {
            return null;
        }

        if (!ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(field.Type), clrProp.PropertyType))
        {
            return null;
        }

        // A read-only field cannot satisfy a read-write property contract.
        if (clrProp.SetMethod != null && field.IsReadOnly)
        {
            return null;
        }

        return field;
    }

    /// <summary>
    /// Probes <paramref name="type"/> for an
    /// <c>IAsyncEnumerable&lt;T&gt;</c> implementation, OR (issue #2280,
    /// parallel to the sync <c>GetEnumerator()</c> pattern support for
    /// #939/#990) the fully duck-typed <c>await foreach</c> pattern — a
    /// public instance <c>GetAsyncEnumerator(...)</c> method independent of
    /// any interface — and returns the element type when either shape is
    /// present. The interface path is tried first (fast path, and it is the
    /// only path that recovers a same-compilation user element type through
    /// the symbolic <see cref="ImportedTypeSymbol"/> machinery); the pattern
    /// path is the fallback used for CLR wrapper types that implement no
    /// interfaces at all, such as
    /// <c>System.Runtime.CompilerServices.ConfiguredCancelableAsyncEnumerable&lt;T&gt;</c>
    /// (the type produced by <c>IAsyncEnumerable&lt;T&gt;.ConfigureAwait(bool)</c>).
    /// </summary>
    /// <param name="type">The <see cref="TypeSymbol"/> to probe.</param>
    /// <param name="elementType">The bound element type symbol, on success.</param>
    /// <returns><see langword="true"/> when the type implements
    /// <c>IAsyncEnumerable&lt;T&gt;</c> or exposes the pattern-based
    /// <c>await foreach</c> shape.</returns>
    public static bool TryGetAsyncEnumerableElementType(TypeSymbol type, out TypeSymbol elementType)
    {
        elementType = null;

        // Issue #1002 (parallel to #939 / #990 for sync `for-in`): an
        // `IAsyncEnumerable[Shape]` whose `Shape` is a same-compilation
        // user `class` / `data struct` is modelled as an
        // `ImportedTypeSymbol` carrying `Shape` symbolically in
        // `TypeArguments` while its `ClrType` is the erased
        // `IAsyncEnumerable<object>` (user types have no ClrType yet, so
        // `MakeGenericType` falls back to `object`). Walking only the CLR
        // type below would type the `await for s in seq` loop variable as
        // `object` and member access (`s.Tag()`) would fail to bind.
        // Honour the symbolic argument first so the loop variable
        // recovers the member-bearing user `Shape` symbol.
        if (type is ImportedTypeSymbol importedSym
            && importedSym.OpenDefinition != null
            && importedSym.HasSubstitutableTypeArgument)
        {
            if (importedSym.OpenDefinition.FullName == "System.Collections.Generic.IAsyncEnumerable`1"
                && importedSym.TypeArguments.Length == 1)
            {
                elementType = importedSym.TypeArguments[0];
                return true;
            }

            // The receiver may be a user/BCL type that implements
            // `IAsyncEnumerable[Shape]`; probe the OpenDefinition for the
            // interface and substitute the symbolic argument back.
            foreach (var iface in EnumerateSelfAndInterfaces(importedSym.OpenDefinition))
            {
                if (iface.IsGenericType
                    && !iface.IsGenericTypeDefinition
                    && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
                {
                    elementType = MapOpenClrTypeToSymbolic(iface.GetGenericArguments()[0], importedSym);
                    return true;
                }
            }
        }

        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        foreach (var iface in EnumerateSelfAndInterfaces(clr))
        {
            if (iface.IsGenericType &&
                !iface.IsGenericTypeDefinition &&
                iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IAsyncEnumerable`1")
            {
                elementType = TypeSymbol.FromClrType(iface.GetGenericArguments()[0]);
                return true;
            }
        }

        // Issue #2280: neither `type` nor its OpenDefinition (when
        // symbolic) implements `IAsyncEnumerable[T]`. Fall back to the
        // duck-typed `await foreach` pattern before giving up — this is
        // what makes `ConfiguredCancelableAsyncEnumerable[T]` (returned by
        // `IAsyncEnumerable[T].ConfigureAwait(false)`) and other
        // fully-pattern-based async enumerables iterable.
        if (TryResolveClrPatternAsyncEnumerator(clr, out _, out _, out var currentMember))
        {
            elementType = TypeSymbol.FromClrType(GetClrMemberValueType(currentMember));
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #2280: resolves the C# spec's duck-typed <c>await foreach</c>
    /// pattern directly on <paramref name="clrType"/> — a public instance
    /// <c>GetAsyncEnumerator(...)</c> method (accepting zero arguments, or a
    /// single optional argument such as <c>CancellationToken</c>), whose
    /// return type in turn exposes a parameterless <c>MoveNextAsync()</c>
    /// method and a <c>Current</c> member — all independent of any
    /// interface. Mirrors <see cref="TryGetClrPatternEnumerableElementType"/>
    /// (the sync <c>GetEnumerator()</c> pattern probe for #939/#990) for the
    /// async shape.
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="getAsyncEnumerator">The resolved <c>GetAsyncEnumerator</c> method, on success.</param>
    /// <param name="moveNextAsync">The resolved <c>MoveNextAsync</c> method on the enumerator type, on success.</param>
    /// <param name="currentMember">The resolved <c>Current</c> property or field on the enumerator type, on success.</param>
    /// <returns><see langword="true"/> when the pattern-based shape matches.</returns>
    public static bool TryResolveClrPatternAsyncEnumerator(
        Type clrType,
        out MethodInfo getAsyncEnumerator,
        out MethodInfo moveNextAsync,
        out MemberInfo currentMember)
    {
        getAsyncEnumerator = null;
        moveNextAsync = null;
        currentMember = null;

        if (clrType == null)
        {
            return false;
        }

        // Prefer a parameterless `GetAsyncEnumerator()` (the shape produced
        // by `ConfiguredCancelableAsyncEnumerable[T]`) over a single-argument
        // overload (the shape produced by `IAsyncEnumerable[T]` itself, which
        // takes an optional `CancellationToken`) when a type happens to
        // expose both — matching how the interface fast path always wins
        // when present, so the pattern probe's own preference order rarely
        // matters in practice.
        MethodInfo zeroArgCandidate = null;
        MethodInfo oneArgCandidate = null;
        foreach (var candidate in ClrTypeUtilities.SafeGetMethods(clrType, BindingFlags.Public | BindingFlags.Instance))
        {
            if (!string.Equals(candidate.Name, "GetAsyncEnumerator", StringComparison.Ordinal))
            {
                continue;
            }

            var parameters = candidate.GetParameters();
            if (parameters.Length == 0 && zeroArgCandidate == null)
            {
                zeroArgCandidate = candidate;
            }
            else if (parameters.Length == 1 && oneArgCandidate == null)
            {
                oneArgCandidate = candidate;
            }
        }

        var resolved = zeroArgCandidate ?? oneArgCandidate;
        if (resolved == null)
        {
            return false;
        }

        var enumeratorType = resolved.ReturnType;
        var moveNext = SafeGetMethodIncludingSelfAndInterfaces(enumeratorType, "MoveNextAsync", Type.EmptyTypes);
        if (moveNext == null)
        {
            return false;
        }

        if (!TryGetClrCurrentMemberIncludingSelfAndInterfaces(enumeratorType, out var current))
        {
            return false;
        }

        getAsyncEnumerator = resolved;
        moveNextAsync = moveNext;
        currentMember = current;
        return true;
    }

    /// <summary>
    /// Looks up the <c>Current</c> member on a duck-typed CLR enumerator —
    /// preferring a property over a field — walking the type's transitive
    /// implemented interfaces in addition to the type itself. The async
    /// counterpart to <see cref="TryGetClrCurrentMemberType"/>, which only
    /// probes the type directly (sufficient for the sync pattern, whose
    /// enumerator is always concrete); kept separate so that call site is
    /// left untouched.
    /// </summary>
    /// <param name="enumeratorType">The duck-typed enumerator type.</param>
    /// <param name="currentMember">The resolved <c>Current</c> property or field, on success.</param>
    /// <returns><see langword="true"/> when a <c>Current</c> member exists.</returns>
    public static bool TryGetClrCurrentMemberIncludingSelfAndInterfaces(Type enumeratorType, out MemberInfo currentMember)
    {
        var currentProperty = SafeGetPropertyIncludingSelfAndInterfaces(enumeratorType, "Current");
        if (currentProperty != null)
        {
            currentMember = currentProperty;
            return true;
        }

        var currentField = ClrTypeUtilities.SafeGetField(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public);
        if (currentField != null)
        {
            currentMember = currentField;
            return true;
        }

        currentMember = null;
        return false;
    }

    /// <summary>
    /// Probes <paramref name="clrType"/> for a member-mapping shape and returns
    /// the key/value type arguments when present. Recognizes the broader
    /// read-only mapping family: any interface whose generic type definition is
    /// <c>IDictionary&lt;TKey, TValue&gt;</c> or
    /// <c>IReadOnlyDictionary&lt;TKey, TValue&gt;</c> — mirroring how the
    /// enumerable probe accepts the whole <c>IEnumerable&lt;T&gt;</c> family
    /// rather than one concrete type (issue #1483). This lets
    /// <c>for k, v in d</c> key/value destructure receivers that surface only
    /// through the read-only contract (e.g. immutable dictionaries or user
    /// types implementing only <c>IReadOnlyDictionary&lt;,&gt;</c>).
    /// <para>
    /// When a type implements BOTH interfaces (e.g. <c>Dictionary&lt;K, V&gt;</c>),
    /// the writable <c>IDictionary&lt;,&gt;</c> is preferred. This is enforced
    /// with a two-pass probe — the first pass scans for <c>IDictionary&lt;,&gt;</c>
    /// and only when none is found does the second pass scan for
    /// <c>IReadOnlyDictionary&lt;,&gt;</c> — so enumeration order can never pick
    /// the read-only interface over an available writable one (they may even
    /// carry different type arguments in pathological types).
    /// </para>
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="keyType">The dictionary's key type, on success.</param>
    /// <param name="valueType">The dictionary's value type, on success.</param>
    /// <returns><see langword="true"/> when the type implements
    /// <c>IDictionary&lt;,&gt;</c> or <c>IReadOnlyDictionary&lt;,&gt;</c>.</returns>
    public static bool TryGetClrDictionaryTypes(Type clrType, out Type keyType, out Type valueType)
    {
        // First pass: prefer the writable IDictionary<,> (write scenarios) when
        // a type implements both contracts.
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IDictionary`2")
            {
                var args = iface.GetGenericArguments();
                keyType = args[0];
                valueType = args[1];
                return true;
            }
        }

        // Second pass: only when no writable IDictionary<,> was found, accept the
        // read-only IReadOnlyDictionary<,> mapping family.
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IReadOnlyDictionary`2")
            {
                var args = iface.GetGenericArguments();
                keyType = args[0];
                valueType = args[1];
                return true;
            }
        }

        keyType = null;
        valueType = null;
        return false;
    }

    /// <summary>
    /// Probes <paramref name="clrType"/> for an
    /// <c>IEnumerable&lt;T&gt;</c> implementation (preferred) or a
    /// non-generic <see cref="System.Collections.IEnumerable"/> (fallback
    /// with element type <see cref="object"/>).
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="elementType">The element CLR type, on success.</param>
    /// <returns><see langword="true"/> when the type is enumerable.</returns>
    public static bool TryGetClrEnumerableElementType(Type clrType, out Type elementType)
    {
        foreach (var iface in EnumerateSelfAndInterfaces(clrType))
        {
            if (iface.IsGenericType && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1")
            {
                elementType = iface.GetGenericArguments()[0];
                return true;
            }
        }

        // Non-generic IEnumerable falls back to object.
        if (typeof(System.Collections.IEnumerable).IsAssignableFrom(clrType))
        {
            elementType = typeof(object);
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Probes <paramref name="clrType"/> for the C#-style "duck-typed"
    /// enumerable shape: a public instance <c>GetEnumerator()</c> returning
    /// a type that exposes a <c>bool MoveNext()</c> and a <c>Current</c>
    /// property/field.
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="elementType">The element CLR type, on success.</param>
    /// <returns><see langword="true"/> when the duck-typed shape matches.</returns>
    public static bool TryGetClrPatternEnumerableElementType(Type clrType, out Type elementType)
    {
        var getEnumerator = clrType.GetMethod(
            "GetEnumerator",
            BindingFlags.Instance | BindingFlags.Public,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null);
        if (getEnumerator == null)
        {
            elementType = null;
            return false;
        }

        var enumeratorType = getEnumerator.ReturnType;
        var moveNext = enumeratorType.GetMethod(
            "MoveNext",
            BindingFlags.Instance | BindingFlags.Public,
            binder: null,
            types: Type.EmptyTypes,
            modifiers: null);
        if (moveNext?.ReturnType.IsSameAs(typeof(bool)) != true)
        {
            elementType = null;
            return false;
        }

        if (TryGetClrCurrentMemberType(enumeratorType, out elementType))
        {
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Looks up the <c>Current</c> member on a duck-typed CLR enumerator —
    /// preferring a property over a field, matching the canonical pattern.
    /// </summary>
    /// <param name="enumeratorType">The duck-typed enumerator type.</param>
    /// <param name="elementType">The <c>Current</c> member's CLR type, on success.</param>
    /// <returns><see langword="true"/> when a <c>Current</c> member exists.</returns>
    public static bool TryGetClrCurrentMemberType(Type enumeratorType, out Type elementType)
    {
        var currentProperty = ClrTypeUtilities.SafeGetProperty(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public);
        if (currentProperty != null)
        {
            elementType = currentProperty.PropertyType;
            return true;
        }

        var currentField = ClrTypeUtilities.SafeGetField(enumeratorType, "Current", BindingFlags.Instance | BindingFlags.Public);
        if (currentField != null)
        {
            elementType = currentField.FieldType;
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Issue #774: maps an open generic CLR <see cref="Type"/> (such as the
    /// element type extracted from <c>IEnumerable&lt;TParam&gt;</c>) back to
    /// the symbolic <see cref="TypeSymbol"/> carried on
    /// <paramref name="openImp"/>'s <see cref="ImportedTypeSymbol.TypeArguments"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// For a generic parameter declared on <see cref="ImportedTypeSymbol.OpenDefinition"/>,
    /// the result is the symbolic argument at the same ordinal — e.g. the
    /// <c>T</c> in <c>IEnumerable[T]</c> becomes the function-level
    /// <see cref="TypeParameterSymbol"/> <c>T</c>.
    /// </para>
    /// <para>
    /// For a constructed generic type whose arguments transitively reference
    /// open parameters (e.g. <c>KeyValuePair&lt;TKey, TValue&gt;</c> on
    /// <c>Dictionary&lt;TKey, TValue&gt;</c>), the helper recurses and
    /// reconstructs the closed shape via <see cref="ImportedTypeSymbol.GetConstructed"/>
    /// so downstream emit keeps the symbolic projection.
    /// </para>
    /// <para>
    /// For anything else (closed primitive, unrelated CLR type, unmapped
    /// parameter), falls back to <see cref="TypeSymbol.FromClrType"/>.
    /// </para>
    /// </remarks>
    /// <param name="openClr">The open CLR type to map.</param>
    /// <param name="openImp">The receiver carrying symbolic type arguments.</param>
    /// <returns>The symbolic <see cref="TypeSymbol"/> projection.</returns>
    public static TypeSymbol MapOpenClrTypeToSymbolic(Type openClr, ImportedTypeSymbol openImp)
        => MapOpenClrTypeToSymbolic(openClr, openImp?.OpenDefinition, openImp?.TypeArguments ?? ImmutableArray<TypeSymbol>.Empty);

    /// <summary>
    /// Generalised entry point for <see cref="MapOpenClrTypeToSymbolic(Type, ImportedTypeSymbol)"/>
    /// that accepts the open definition and symbolic arguments directly so
    /// callers can pull them from any container shape
    /// (<see cref="ImportedTypeSymbol"/>, <see cref="SequenceTypeSymbol"/>,
    /// <see cref="AsyncSequenceTypeSymbol"/>).
    /// </summary>
    /// <param name="openClr">The open CLR type to map.</param>
    /// <param name="openDefinition">The open generic definition that <paramref name="openClr"/>'s parameters bind against.</param>
    /// <param name="typeArguments">The symbolic arguments at the same ordinals as <paramref name="openDefinition"/>'s generic parameters.</param>
    /// <returns>The symbolic <see cref="TypeSymbol"/> projection.</returns>
    public static TypeSymbol MapOpenClrTypeToSymbolic(Type openClr, Type openDefinition, ImmutableArray<TypeSymbol> typeArguments)
        => MapOpenClrTypeToSymbolic(openClr, openDefinition, typeArguments, openMethodDefinition: null, methodTypeArguments: default);

    /// <summary>
    /// Issue #833: extended mapping entry point that also substitutes
    /// <em>method</em> generic parameters (<c>MVar(idx)</c>) using the
    /// symbolic arguments at the corresponding ordinals on
    /// <paramref name="openMethodDefinition"/>. This is the call-site
    /// sibling of the open-receiver substitution from #794: it allows
    /// <c>Enumerable.Empty[T]()</c> to surface its open <c>IEnumerable&lt;TResult&gt;</c>
    /// return as the symbolic <c>IEnumerable[T]</c> (rather than the
    /// type-erased <c>IEnumerable&lt;object&gt;</c>) and <c>[]T{}.ToArray()</c>
    /// to surface its open <c>TSource[]</c> return as <c>[]T</c>.
    /// </summary>
    /// <param name="openClr">The open CLR type to map.</param>
    /// <param name="openDefinition">The open generic <em>type</em> definition the parameters of <paramref name="openClr"/> may bind against. May be <see langword="null"/>.</param>
    /// <param name="typeArguments">The symbolic arguments at the same ordinals as <paramref name="openDefinition"/>'s generic parameters; may be default/empty.</param>
    /// <param name="openMethodDefinition">The open generic <em>method</em> definition the parameters of <paramref name="openClr"/> may bind against. May be <see langword="null"/>.</param>
    /// <param name="methodTypeArguments">The symbolic arguments at the same ordinals as <paramref name="openMethodDefinition"/>'s generic parameters; may be default/empty.</param>
    /// <returns>The symbolic <see cref="TypeSymbol"/> projection.</returns>
    public static TypeSymbol MapOpenClrTypeToSymbolic(
        Type openClr,
        Type openDefinition,
        ImmutableArray<TypeSymbol> typeArguments,
        MethodInfo openMethodDefinition,
        ImmutableArray<TypeSymbol> methodTypeArguments)
    {
        if (openClr == null)
        {
            return TypeSymbol.Error;
        }

        if (openClr.IsGenericParameter)
        {
            // Type-level parameter (declared on a generic type): map through
            // the receiver/container's symbolic TypeArguments.
            //
            // Issue #2375 follow-up: `Type.DeclaringType` for a *method*-level
            // generic parameter (e.g. `TRelated` of `Builder<TEntity>
            // .HasOneRequired<TRelated>(...)`) returns the METHOD's declaring
            // type (`Builder<TEntity>`), not `null` — only `DeclaringMethod`
            // distinguishes a method-level parameter from a type-level one.
            // Because a single-type-parameter type and a single-method-type-
            // parameter method both report `GenericParameterPosition == 0`,
            // this branch — guarded only by `DeclaringType`/`openDefinition`
            // matching — previously matched `TRelated` too and returned
            // `typeArguments[0]` (the receiver's `TEntity` argument, e.g.
            // `Book`) instead of falling through to the method-level branch
            // below. That silently substituted the wrong closed type for a
            // deferred lambda's `Expression<Func<TEntity,TRelated>>`
            // conversion target, producing invalid IL (`Func<Book,Book>`
            // instead of `Func<Book,Conversion>`) that ILVerify rejected as
            // `StackUnexpected`. Require `IsGenericTypeParameter` (equivalently
            // `DeclaringMethod == null`) so a method-level parameter always
            // falls through to its own (method-scoped) substitution below.
            var declaring = openClr.IsGenericTypeParameter ? openClr.DeclaringType : null;
            if (declaring != null && openDefinition != null && !typeArguments.IsDefaultOrEmpty)
            {
                var declaringDef = declaring.IsGenericTypeDefinition ? declaring : (declaring.IsGenericType ? declaring.GetGenericTypeDefinition() : declaring);
                if (ClrTypeUtilities.AreSame(declaringDef, openDefinition))
                {
                    var pos = openClr.GenericParameterPosition;
                    if ((uint)pos < (uint)typeArguments.Length)
                    {
                        return typeArguments[pos];
                    }
                }
            }

            // Issue #833: method-level parameter (declared on a generic
            // method). `DeclaringMethod` is the only reliable discriminator —
            // `DeclaringType` is set for these too (to the method's own
            // declaring type, issue #2375 follow-up above) — so substitute via
            // the parallel method-type-args slot whenever `DeclaringMethod` is
            // present, regardless of `DeclaringType`.
            if (openClr.DeclaringMethod != null && !methodTypeArguments.IsDefaultOrEmpty)
            {
                if (openMethodDefinition == null
                    || ReferenceEquals(openClr.DeclaringMethod, openMethodDefinition)
                    || openClr.DeclaringMethod.MetadataToken == openMethodDefinition.MetadataToken)
                {
                    var pos = openClr.GenericParameterPosition;
                    if ((uint)pos < (uint)methodTypeArguments.Length)
                    {
                        var mapped = methodTypeArguments[pos];
                        if (mapped != null)
                        {
                            return mapped;
                        }
                    }
                }
            }

            return TypeSymbol.FromClrType(openClr);
        }

        // Issue #794: an open generic type's instance member can return an
        // array of an open parameter (e.g. `List<T>.ToArray()` → `T[]`). The
        // CLR `Type` reports `IsArray` for those, not `IsGenericType`. Recurse
        // on the element type and surface a G# slice (`[]T`) so the call site
        // sees the symbolic projection rather than the erased `object[]`.
        // Issue #833 extends the recursion to method-level parameters so
        // `Enumerable.ToArray[T](IEnumerable[T]) → T[]` surfaces as `[]T`.
        if (openClr.IsArray && openClr.GetArrayRank() == 1)
        {
            var openElement = openClr.GetElementType();
            var mappedElement = MapOpenClrTypeToSymbolic(openElement, openDefinition, typeArguments, openMethodDefinition, methodTypeArguments);

            // Issue #1216: a method-level parameter may be substituted by a
            // same-compilation user type (e.g. `GC.AllocateArray[Foo]` /
            // `Array.Empty[Foo]` whose open return is `T[]`). The closed CLR
            // method erased `Foo` to `object`, so without surfacing the
            // symbolic slice here the call's return would collapse to the
            // erased `object[]` and fail to convert to `[]Foo` (GS0155). Mirror
            // the generic-type branch below, which already honours #903.
            if (TypeSymbol.RequiresSymbolicProjection(mappedElement))
            {
                return SliceTypeSymbol.Get(mappedElement);
            }

            return TypeSymbol.FromClrType(openClr);
        }

        // Issue #794: a managed pointer return (e.g. `List<T>.this[int]` on
        // `Span<T>`) reports `IsByRef`. Recurse on the pointee and wrap with
        // `ByRefTypeSymbol` to mirror the open-shape's contract.
        if (openClr.IsByRef)
        {
            var openPointee = openClr.GetElementType();
            var mappedPointee = MapOpenClrTypeToSymbolic(openPointee, openDefinition, typeArguments, openMethodDefinition, methodTypeArguments);
            if (TypeSymbol.RequiresSymbolicProjection(mappedPointee))
            {
                return ByRefTypeSymbol.Get(mappedPointee);
            }

            return TypeSymbol.FromClrType(openClr);
        }

        // Issue #2391: keep substituted Nullable<T> positions in the
        // canonical G# nullable shape. The generic reconstruction below is
        // appropriate for ordinary imported generics, but using it for an
        // interface member such as IRepo<T>.Echo(T?) previously produced an
        // ImportedTypeSymbol for System.Nullable<Color>. The matching return
        // position was then distinct from the source Color? symbol even
        // though both came from the same receiver substitution.
        if (NullableLifting.IsValueTypeNullableClr(openClr))
        {
            var openUnderlying = openClr.GetGenericArguments()[0];
            var mappedUnderlying = MapOpenClrTypeToSymbolic(
                openUnderlying,
                openDefinition,
                typeArguments,
                openMethodDefinition,
                methodTypeArguments);

            if (TypeSymbol.RequiresSymbolicProjection(mappedUnderlying))
            {
                return NullableTypeSymbol.Get(mappedUnderlying);
            }

            return TypeSymbol.FromClrType(openClr);
        }

        if (openClr.IsGenericType && !openClr.IsGenericTypeDefinition)
        {
            var openArgs = openClr.GetGenericArguments();
            var symbolic = ImmutableArray.CreateBuilder<TypeSymbol>(openArgs.Length);
            var anyParam = false;
            foreach (var a in openArgs)
            {
                var mapped = MapOpenClrTypeToSymbolic(a, openDefinition, typeArguments, openMethodDefinition, methodTypeArguments);
                symbolic.Add(mapped);

                // Issue #833 surfaced this projection for in-scope type
                // parameters. Issue #903 extends it to same-compilation user
                // types: a constructed return like `IEnumerable<TSource>` over
                // a `List[Check]` must surface `IEnumerable[Check]` so a
                // chained call (`Where(…).ToList()`) and the consuming
                // receiver keep the `Check` element identity instead of
                // collapsing to the type-erased `IEnumerable<object>` (which
                // for a value-type element is not even a legal up-cast).
                // A type parameter can substitute to a concrete symbol (for
                // example Action<T> on IBase<string>). The original open CLR
                // shape still cannot be used as the projected member type, so
                // reconstruct it even when the mapped argument itself does
                // not require symbolic projection.
                if (TypeSymbol.RequiresSymbolicProjection(mapped) || a.ContainsGenericParameters)
                {
                    anyParam = true;
                }
            }

            var openDef = openClr.GetGenericTypeDefinition();
            if (!anyParam)
            {
                return TypeSymbol.FromClrType(openClr);
            }

            // Construct the type-erased closed shape (`<object, object, …>`) so
            // the resulting symbol mirrors the existing convention used by
            // ImportedTypeSymbol.GetConstructed callers (#313 / #671): ClrType
            // remains a real closed `Type` that reflection can probe for
            // members, while TypeArguments carries the symbolic projection.
            //
            // Issue #1305: when this projection runs over a method-level
            // return type (e.g. `Where<TSource>(…) → IEnumerable<TSource>`)
            // whose `openDef` was loaded by the references' MetadataLoadContext,
            // a live `typeof(object)` cannot close it ("type was not loaded by
            // the MetadataLoadContext"). The construction then fell into the
            // catch below and surfaced the *open* `IEnumerable<TSource>` as the
            // result's ClrType, so the next chained extension lookup
            // (`e.Where(…).Where(…)`) matched against an unbound method type
            // parameter and reported GS0159. Erase using an `object` resolved
            // in the same context as `openDef`.
            var openParams = openDef.GetGenericArguments();
            var contextObject = ResolveErasedObjectInContext(openDef);

            // Issue #1422: preserve the *nested* generic structure of each
            // symbolic argument when erasing. A chained projection such as
            // `xs.Select(e -> e.GetEnumerator())` yields an element type that is
            // itself a constructed generic interface (`IEnumerator[T]`). Flatly
            // erasing every top-level argument to `object` would collapse the
            // result's ClrType to `IEnumerable<object>`, so the next chained
            // extension (`.Select((e IEnumerator[T]) -> …)`) would infer
            // `TSource = object` and reject the typed selector with GS0159.
            // Recurse through each symbolic argument's own open definition so
            // the erased closed shape becomes `IEnumerable<IEnumerator<object>>`
            // — matching the (identically erased) selector parameter type — and
            // generic inference recovers the right `TSource`. Leaf type
            // parameters and concrete arguments still erase to `object`, which
            // mirrors how the selector's parameter type is erased, keeping the
            // two shapes structurally aligned.
            var symbolicArgs = symbolic.ToImmutable();
            Type erasedClosed =
                TryBuildErasedClosedGeneric(openDef, openParams, symbolicArgs, contextObject)
                ?? openClr;

            return ImportedTypeSymbol.GetConstructed(erasedClosed, openDef, symbolicArgs);
        }

        return TypeSymbol.FromClrType(openClr);
    }

    /// <summary>
    /// Issue #833: structural unification that recovers the symbolic
    /// type-argument vector for an open generic CLR method when the call
    /// site did <em>not</em> supply an explicit <c>[T1, T2]</c> list.
    /// Walks every <c>(openParameter, symbolicArgument)</c> pair in
    /// parallel and records the symbolic shape sitting at each
    /// <c>MVar(idx)</c> slot, then returns the per-ordinal vector. When
    /// some slot is still missing the corresponding entry is <see langword="null"/>
    /// — callers must treat <see langword="null"/> as "no symbolic
    /// override; fall back to the closed-CLR projection".
    /// </summary>
    /// <param name="openMethod">The open generic method definition.</param>
    /// <param name="symbolicArgTypes">Symbolic argument types in call order (receiver included as slot 0 for extension methods).</param>
    /// <returns>An array sized to the open method's generic-parameter arity, with one entry per ordinal (<see langword="null"/> when unrecovered).</returns>
    public static TypeSymbol[] InferSymbolicMethodTypeArguments(
        MethodInfo openMethod,
        ImmutableArray<TypeSymbol> symbolicArgTypes)
    {
        if (openMethod == null || !openMethod.IsGenericMethodDefinition)
        {
            return Array.Empty<TypeSymbol>();
        }

        var arity = openMethod.GetGenericArguments().Length;
        var result = new TypeSymbol[arity];

        var openParams = openMethod.GetParameters();
        var pairs = Math.Min(openParams.Length, symbolicArgTypes.IsDefault ? 0 : symbolicArgTypes.Length);
        for (int i = 0; i < pairs; i++)
        {
            UnifyForMethodTypeArgs(openParams[i].ParameterType, symbolicArgTypes[i], openMethod, result);
        }

        return result;
    }

    /// <summary>
    /// Issue #833 (sibling to #794 on the call-site argument side): when the
    /// imported generic method's open return type <em>contains</em> a method
    /// type parameter that maps to an in-scope G# type parameter, substitute
    /// the open return with the symbolic projection so the call site surfaces
    /// e.g. <c>IEnumerable[T]</c> rather than the type-erased
    /// <c>IEnumerable&lt;object&gt;</c>. <paramref name="symbolicMethodTypeArgs"/>
    /// carries the resolved symbolic arguments at MVar ordinals (explicit-list
    /// or inferred via <see cref="InferSymbolicMethodTypeArguments"/>).
    /// Returns <see langword="null"/> when no symbolic substitution applies, so
    /// callers keep their existing return-type derivation.
    /// </summary>
    /// <param name="closed">The closed generic method selected by overload resolution.</param>
    /// <param name="symbolicMethodTypeArgs">Per-MVar symbolic type arguments; entries may be <see langword="null"/>.</param>
    /// <param name="receiverType">The receiver's static type symbol (for type-level Var substitution); may be <see langword="null"/>.</param>
    /// <returns>The override return type symbol, or <see langword="null"/>.</returns>
    public static TypeSymbol ResolveCallReturnTypeFromSymbolicTypeArgs(
        MethodInfo closed,
        ImmutableArray<TypeSymbol> symbolicMethodTypeArgs,
        TypeSymbol receiverType)
    {
        if (closed == null || !closed.IsGenericMethod)
        {
            return null;
        }

        if (symbolicMethodTypeArgs.IsDefaultOrEmpty || !symbolicMethodTypeArgs.Any(s => s != null))
        {
            return null;
        }

        var openMethod = closed.IsGenericMethodDefinition ? closed : closed.GetGenericMethodDefinition();

        Type receiverOpenDef = null;
        ImmutableArray<TypeSymbol> receiverTypeArgs = default;
        if (receiverType is ImportedTypeSymbol imp && imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty)
        {
            receiverOpenDef = imp.OpenDefinition;
            receiverTypeArgs = imp.TypeArguments;

            // Issue #2375: `closed.GetGenericMethodDefinition()` only opens the
            // METHOD's own generic parameters — it leaves the DECLARING TYPE's
            // type arguments exactly as closed on `closed` (e.g. `object` when
            // the receiver's own type argument was erased during overload
            // resolution). For an instance method whose return type references
            // BOTH a method-level parameter (e.g. `TRelated`) and the
            // declaring type's own parameter (e.g. `TEntity`, as in
            // `Builder<TEntity>.WithOne<TRelated>() : DependentBuilder<TRelated,
            // TEntity>`), this left the second slot permanently erased to
            // `object` even though the method-level slot recovered correctly.
            // Re-resolve the truly-open method (both type- and method-level
            // parameters unbound) from the receiver's OWN open declaring type by
            // metadata-token match — the same recovery already used by
            // `ExpressionBinder.Calls.TryGetOpenInstanceMethod` /
            // `ResolveInstanceReturnTypeFromReceiver`.
            var reopened = TryGetOpenMethodOnDeclaringType(receiverOpenDef, openMethod);
            if (reopened != null)
            {
                openMethod = reopened;
            }
        }

        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return null;
        }

        var mapped = MapOpenClrTypeToSymbolic(openReturn, receiverOpenDef, receiverTypeArgs, openMethod, symbolicMethodTypeArgs);

        // Issue #833 surfaces the override when the projection still contains an
        // in-scope type parameter. Issue #903 extends this to same-compilation
        // user element types: when the receiver is e.g. `List[Check]` and
        // `Check` is a struct/class still being compiled, the closed CLR method
        // erased `TSource` to `object`, so a generic return like `Single() →
        // TSource` would otherwise surface as `object` and lose the `Check`
        // identity (breaking `net.Id`). The symbolic projection recovers it.
        return TypeSymbol.RequiresSymbolicProjection(mapped)
            ? mapped
            : null;
    }

    /// <summary>
    /// Issue #833: build the per-MVar symbolic type-argument vector for an
    /// imported generic-method call. When the call site supplied an explicit
    /// <c>[T1, T2]</c> list (<paramref name="explicitTypeArgSymbols"/> is
    /// non-default), those symbols are used directly. Otherwise the vector
    /// is inferred from the call's symbolic argument types
    /// (<paramref name="symbolicArgTypes"/>) via structural unification.
    /// Returns <see langword="default"/> when the method is not generic or
    /// no symbolic information can be recovered.
    /// </summary>
    /// <param name="closed">The closed generic method selected by overload resolution.</param>
    /// <param name="explicitTypeArgSymbols">The explicit symbols, or default when none were supplied.</param>
    /// <param name="symbolicArgTypes">Symbolic argument types in call order (receiver first when applicable).</param>
    /// <returns>The per-MVar vector (length == open arity), or default when nothing recoverable.</returns>
    public static ImmutableArray<TypeSymbol> BuildSymbolicMethodTypeArgs(
        MethodInfo closed,
        ImmutableArray<TypeSymbol> explicitTypeArgSymbols,
        ImmutableArray<TypeSymbol> symbolicArgTypes)
    {
        if (closed == null || !closed.IsGenericMethod)
        {
            return default;
        }

        var openMethod = closed.IsGenericMethodDefinition ? closed : closed.GetGenericMethodDefinition();
        var arity = openMethod.GetGenericArguments().Length;
        if (arity == 0)
        {
            return default;
        }

        var inferred = !symbolicArgTypes.IsDefault && symbolicArgTypes.Length > 0
            ? InferSymbolicMethodTypeArguments(openMethod, symbolicArgTypes)
            : new TypeSymbol[arity];

        // Explicit list takes precedence at each slot when present.
        if (!explicitTypeArgSymbols.IsDefaultOrEmpty)
        {
            for (int i = 0; i < arity && i < explicitTypeArgSymbols.Length; i++)
            {
                if (explicitTypeArgSymbols[i] != null)
                {
                    inferred[i] = explicitTypeArgSymbols[i];
                }
            }
        }

        var anySymbolic = false;
        for (int i = 0; i < inferred.Length; i++)
        {
            // Issue #833: an in-scope type parameter requires the symbolic
            // vector. Issue #903: a same-compilation user type (e.g. `Check`
            // recovered from a `List[Check]` receiver) does too — the closed
            // CLR method erased it to `object`, so without the symbolic vector
            // the call's return type / lambda parameter type would be `object`.
            if (TypeSymbol.RequiresSymbolicProjection(inferred[i]))
            {
                anySymbolic = true;
                break;
            }
        }

        if (!anySymbolic)
        {
            return default;
        }

        return ImmutableArray.Create(inferred);
    }

    /// <summary>
    /// Issue #833: convenience helper that builds the
    /// (receiver, arguments) → symbolic-type vector consumed by
    /// <see cref="InferSymbolicMethodTypeArguments"/>.
    /// </summary>
    /// <param name="receiverType">The receiver's symbolic type (for instance/extension calls); may be <see langword="null"/> for static calls.</param>
    /// <param name="argumentTypes">The bound arguments' symbolic types.</param>
    /// <returns>An immutable array with receiver-first ordering when present.</returns>
    public static ImmutableArray<TypeSymbol> BuildSymbolicArgTypeVector(TypeSymbol receiverType, ImmutableArray<TypeSymbol> argumentTypes)
    {
        var argCount = argumentTypes.IsDefault ? 0 : argumentTypes.Length;
        var count = (receiverType != null ? 1 : 0) + argCount;
        if (count == 0)
        {
            return ImmutableArray<TypeSymbol>.Empty;
        }

        var b = ImmutableArray.CreateBuilder<TypeSymbol>(count);
        if (receiverType != null)
        {
            b.Add(receiverType);
        }

        if (argCount > 0)
        {
            foreach (var a in argumentTypes)
            {
                b.Add(a);
            }
        }

        return b.MoveToImmutable();
    }

    /// <summary>
    /// Issue #2494: removes imported method candidates that are applicable only
    /// because a same-compilation enum was projected to its temporary CLR
    /// <c>int32</c> representation. The projection is a lookup aid; it is not a
    /// source-language enum-to-integer conversion. Open generic parameter
    /// positions remain eligible so the existing symbolic substitution path can
    /// recover the enum identity for the selected method and its return type.
    /// </summary>
    /// <param name="candidates">The imported candidates to filter.</param>
    /// <param name="symbolicArgTypes">Symbolic argument types in candidate parameter order.</param>
    /// <param name="argumentNames">Optional source argument names aligned with <paramref name="symbolicArgTypes"/>.</param>
    /// <param name="symbolicReceiverType">The symbolic instance receiver, used to reopen an erased constructed declaring type.</param>
    /// <returns>Candidates that do not require an enum-erasure-only match.</returns>
    public static IEnumerable<MethodInfo> ExcludeErasureOnlyEnumCandidates(
        IEnumerable<MethodInfo> candidates,
        ImmutableArray<TypeSymbol> symbolicArgTypes,
        IReadOnlyList<string> argumentNames = null,
        TypeSymbol symbolicReceiverType = null)
    {
        if (candidates == null || symbolicArgTypes.IsDefaultOrEmpty)
        {
            return candidates ?? Enumerable.Empty<MethodInfo>();
        }

        return candidates.Where(candidate => !HasErasureOnlyEnumParameterMatch(
            candidate,
            symbolicArgTypes,
            argumentNames,
            symbolicReceiverType));

        static bool HasErasureOnlyEnumParameterMatch(
            MethodInfo candidate,
            ImmutableArray<TypeSymbol> symbolicArgTypes,
            IReadOnlyList<string> argumentNames,
            TypeSymbol symbolicReceiverType)
        {
            if (candidate == null)
            {
                return false;
            }

            MethodInfo openCandidate = candidate.IsGenericMethod && !candidate.IsGenericMethodDefinition
                ? candidate.GetGenericMethodDefinition()
                : candidate;
            Type declaringType = openCandidate.DeclaringType;
            if (declaringType?.IsConstructedGenericType == true
                && symbolicReceiverType is ImportedTypeSymbol symbolicReceiver
                && symbolicReceiver.OpenDefinition != null)
            {
                var declaringDefinition = declaringType.GetGenericTypeDefinition();
                var receiverCarriesSymbolicType = ClrTypeUtilities.AreSame(
                        symbolicReceiver.OpenDefinition,
                        declaringDefinition)
                    && TypeSymbol.ContainsSameCompilationUserType(symbolicReceiverType);
                if (!receiverCarriesSymbolicType
                    && TryMapThroughImplemented(
                        symbolicReceiver,
                        declaringDefinition,
                        out var liftedReceiverArguments))
                {
                    receiverCarriesSymbolicType = liftedReceiverArguments.Any(
                        TypeSymbol.ContainsSameCompilationUserType);
                }

                if (receiverCarriesSymbolicType)
                {
                    MethodInfo reopened = TryGetOpenMethodOnDeclaringType(
                        declaringDefinition,
                        openCandidate);
                    if (reopened != null)
                    {
                        openCandidate = reopened;
                    }
                }
            }

            ParameterInfo[] parameters;
            try
            {
                parameters = openCandidate.GetParameters();
            }
            catch
            {
                return false;
            }

            var hasParams = parameters.Length > 0
                && OverloadResolution.IsParamsArrayParameter(parameters[parameters.Length - 1]);
            var nextPositionalParameter = 0;
            for (var i = 0; i < symbolicArgTypes.Length; i++)
            {
                var argumentName = argumentNames != null && i < argumentNames.Count
                    ? argumentNames[i]
                    : null;
                var parameterIndex = -1;
                if (!string.IsNullOrEmpty(argumentName))
                {
                    for (var p = 0; p < parameters.Length; p++)
                    {
                        if (string.Equals(parameters[p].Name, argumentName, StringComparison.Ordinal))
                        {
                            parameterIndex = p;
                            break;
                        }
                    }
                }
                else if (nextPositionalParameter < parameters.Length)
                {
                    parameterIndex = nextPositionalParameter++;
                }
                else if (hasParams)
                {
                    parameterIndex = parameters.Length - 1;
                }

                if (parameterIndex < 0 || parameterIndex >= parameters.Length)
                {
                    continue;
                }

                var parameterType = parameters[parameterIndex].ParameterType;
                if (hasParams
                    && parameterIndex == parameters.Length - 1
                    && string.IsNullOrEmpty(argumentName)
                    && parameterType.IsArray
                    && symbolicArgTypes[i] is not SliceTypeSymbol
                    && symbolicArgTypes[i] is not ArrayTypeSymbol)
                {
                    parameterType = parameterType.GetElementType();
                    nextPositionalParameter = parameterIndex;
                }

                if (IsErasureOnlyEnumMatch(parameterType, symbolicArgTypes[i]))
                {
                    return true;
                }
            }

            return false;
        }

        static bool IsErasureOnlyEnumMatch(Type openParameterType, TypeSymbol symbolicArgumentType)
        {
            if (openParameterType == null || symbolicArgumentType == null)
            {
                return false;
            }

            if (openParameterType.IsByRef)
            {
                openParameterType = openParameterType.GetElementType();
            }

            if (symbolicArgumentType is ByRefTypeSymbol byRefArgument)
            {
                symbolicArgumentType = byRefArgument.PointeeType;
            }

            // A generic slot captures the symbolic enum and is repaired downstream
            // by BuildSymbolicMethodTypeArgs/ResolveCallReturnTypeFromSymbolicTypeArgs.
            if (openParameterType == null || openParameterType.IsGenericParameter)
            {
                return false;
            }

            if (symbolicArgumentType is EnumSymbol)
            {
                return string.Equals(openParameterType.FullName, typeof(int).FullName, StringComparison.Ordinal);
            }

            if (symbolicArgumentType is NullableTypeSymbol nullable)
            {
                if (TryGetNullableTypeArgument(openParameterType, out var nullableParameter))
                {
                    return IsErasureOnlyEnumMatch(nullableParameter, nullable.UnderlyingType);
                }

                // Reference-type nullability is an annotation, not a distinct
                // CLR generic wrapper. Continue matching the underlying symbolic
                // shape against the same formal parameter.
                return IsErasureOnlyEnumMatch(openParameterType, nullable.UnderlyingType);
            }

            if (symbolicArgumentType is FunctionTypeSymbol functionType)
            {
                MethodInfo invoke;
                try
                {
                    invoke = openParameterType.GetMethod("Invoke");
                }
                catch
                {
                    return false;
                }

                if (invoke == null)
                {
                    return false;
                }

                var invokeParameters = invoke.GetParameters();
                var parameterCount = Math.Min(invokeParameters.Length, functionType.ParameterTypes.Length);
                for (var i = 0; i < parameterCount; i++)
                {
                    if (IsErasureOnlyEnumMatch(invokeParameters[i].ParameterType, functionType.ParameterTypes[i]))
                    {
                        return true;
                    }
                }

                return !FunctionTypeSymbol.IsVoidReturn(functionType.ReturnType)
                    && IsErasureOnlyEnumMatch(invoke.ReturnType, functionType.ReturnType);
            }

            if (symbolicArgumentType is TupleTypeSymbol tuple
                && openParameterType.IsGenericType)
            {
                var tupleDefinition = openParameterType.GetGenericTypeDefinition();
                var tupleArguments = openParameterType.GetGenericArguments();
                if (tupleDefinition.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true
                    && tupleArguments.Length == tuple.ElementTypes.Length)
                {
                    for (var i = 0; i < tupleArguments.Length; i++)
                    {
                        if (IsErasureOnlyEnumMatch(tupleArguments[i], tuple.ElementTypes[i]))
                        {
                            return true;
                        }
                    }

                    return false;
                }
            }

            if (openParameterType.IsArray && openParameterType.GetArrayRank() == 1)
            {
                TypeSymbol symbolicElement = TryGetElementType(symbolicArgumentType);
                return symbolicElement != null
                    && IsErasureOnlyEnumMatch(openParameterType.GetElementType(), symbolicElement);
            }

            if (openParameterType.IsGenericType)
            {
                var openArguments = openParameterType.GetGenericArguments();
                if (symbolicArgumentType is ImportedTypeSymbol implemented
                    && TryMapThroughImplemented(
                        implemented,
                        openParameterType.GetGenericTypeDefinition(),
                        out var liftedArguments)
                    && liftedArguments.Length == openArguments.Length)
                {
                    for (var i = 0; i < openArguments.Length; i++)
                    {
                        if (IsErasureOnlyEnumMatch(openArguments[i], liftedArguments[i]))
                        {
                            return true;
                        }
                    }

                    return false;
                }

                if (openArguments.Length == 1)
                {
                    TypeSymbol symbolicElement = TryGetElementType(symbolicArgumentType);
                    if (symbolicElement != null)
                    {
                        return IsErasureOnlyEnumMatch(openArguments[0], symbolicElement);
                    }
                }

                if (symbolicArgumentType is ImportedTypeSymbol imported
                    && !imported.TypeArguments.IsDefaultOrEmpty
                    && imported.TypeArguments.Length == openArguments.Length)
                {
                    for (var i = 0; i < openArguments.Length; i++)
                    {
                        if (IsErasureOnlyEnumMatch(openArguments[i], imported.TypeArguments[i]))
                        {
                            return true;
                        }
                    }
                }
            }

            return false;
        }

        static bool TryGetNullableTypeArgument(Type type, out Type argument)
        {
            argument = null;
            if (type == null || !type.IsGenericType)
            {
                return false;
            }

            Type definition;
            try
            {
                definition = type.GetGenericTypeDefinition();
            }
            catch
            {
                return false;
            }

            if (!string.Equals(definition.FullName, typeof(Nullable<>).FullName, StringComparison.Ordinal))
            {
                return false;
            }

            argument = type.GetGenericArguments()[0];
            return true;
        }
    }

    /// <summary>
    /// Issue #833: projects a <see cref="TypeSymbol"/> that may contain
    /// open type/method parameters to a CLR <see cref="System.Type"/>
    /// using <c>object</c> as the erasure placeholder. This lets
    /// overload resolution match the open generic candidate (the real
    /// symbolic substitution is recovered downstream via
    /// <see cref="BuildSymbolicMethodTypeArgs"/> +
    /// <see cref="ResolveCallReturnTypeFromSymbolicTypeArgs"/>).
    /// </summary>
    /// <param name="t">The argument's bound type.</param>
    /// <param name="erased">On success, an erased CLR projection.</param>
    /// <returns><see langword="true"/> when an erasure projection exists.</returns>
    public static bool TryProjectErasedClrType(TypeSymbol t, out Type erased)
    {
        erased = null;
        if (t == null)
        {
            return false;
        }

        if (t.ClrType != null)
        {
            erased = t.ClrType;
            return true;
        }

        switch (t)
        {
            case TypeParameterSymbol:
                erased = typeof(object);
                return true;
            case SliceTypeSymbol slice:
                if (TryProjectErasedClrType(slice.ElementType, out var sliceElement))
                {
                    erased = sliceElement.MakeArrayType();
                    return true;
                }

                return false;
            case ArrayTypeSymbol array:
                if (TryProjectErasedClrType(array.ElementType, out var arrayElement))
                {
                    erased = arrayElement.MakeArrayType();
                    return true;
                }

                return false;
            case SequenceTypeSymbol seq:
                // Issue #1320: `sequence[T]` (an iterator return, alias for
                // `IEnumerable<T>`) over a same-compilation user element type has
                // a null ClrType during binding. Erase the element so the
                // constructed enumerable still passes the ClrType gate; the
                // symbolic-argument recovery downstream re-derives the real
                // element type for the member's return projection.
                if (TryProjectErasedClrType(seq.ElementType, out var seqElement))
                {
                    erased = typeof(System.Collections.Generic.IEnumerable<>).MakeGenericType(seqElement);
                    return true;
                }

                return false;
            case AsyncSequenceTypeSymbol aseq:
                // Issue #1320: the async-iterator counterpart, alias for
                // `IAsyncEnumerable<T>`.
                if (TryProjectErasedClrType(aseq.ElementType, out var aseqElement))
                {
                    erased = typeof(System.Collections.Generic.IAsyncEnumerable<>).MakeGenericType(aseqElement);
                    return true;
                }

                return false;
            case NullableTypeSymbol nullable when nullable.UnderlyingType != null:
                if (!TryProjectErasedClrType(nullable.UnderlyingType, out var erasedUnderlying))
                {
                    return false;
                }

                if (!erasedUnderlying.IsValueType || Nullable.GetUnderlyingType(erasedUnderlying) != null)
                {
                    erased = erasedUnderlying;
                    return true;
                }

                try
                {
                    var nullableDefinition = erasedUnderlying.Assembly == typeof(object).Assembly
                        ? typeof(Nullable<>)
                        : erasedUnderlying.Assembly.GetType(typeof(Nullable<>).FullName, throwOnError: false);
                    erased = nullableDefinition?.MakeGenericType(erasedUnderlying) ?? erasedUnderlying;
                    return true;
                }
                catch
                {
                    erased = erasedUnderlying;
                    return true;
                }

            case FunctionTypeSymbol fn:
                // Issue #932: a func/arrow literal whose natural delegate type
                // closes over a same-compilation user class (whose ClrType is
                // still null during binding) has a null FunctionType.ClrType, so
                // overload resolution would otherwise reject every candidate
                // (GS0159) before even classifying the delegate parameter — e.g.
                // `Assert.DoesNotContain(items, func(i LibraryItem) bool { ... })`
                // where `items : List[LibraryItem]`. Erase the literal's natural
                // Func<...>/Action<...> shape, mapping each symbolic component the
                // same way the generic-argument erasure does (user class → its
                // imported base or `object`, enum → int32), so the produced
                // delegate's parameter/return types line up with the inferred
                // (erased) element type and the structural delegate conversion
                // applies.
                return TryProjectErasedDelegateClrType(fn, out erased);
            case StructSymbol { IsClass: true } userClass:
                // Issue #1162: a slice/array element that is a same-compilation
                // user type has a null ClrType during binding, so projecting
                // `[]Segment` previously failed at the element and aborted the
                // whole slice projection — blocking IEnumerable<T> extension
                // (LINQ) candidate gating with GS0159. Erase user types just
                // enough to pass the ClrType gate (mirroring the delegate-
                // component eraser); the symbolic-argument recovery downstream
                // re-derives the real element type for inference.
                erased = userClass.ImportedBaseType?.ClrType ?? typeof(object);
                return true;
            case TupleTypeSymbol tuple:
                // Issue #1902: a query's transparent-identifier tuple
                // (`(x1, x2)`) carrying a same-compilation user element (e.g. a
                // `data class` range variable) has a null ClrType — same root
                // cause as the slice/array case above, `TupleTypeSymbol.
                // BuildClrType` refuses to build `ValueTuple<...>` when any
                // element's ClrType is null. Left unhandled, a LINQ method
                // taking or returning such a tuple (`Select`, `Join`,
                // `GroupJoin`, …) had no ClrType to gate on and fell through to
                // GS0159 "Cannot find function" even though the same tuple
                // shape with only built-in element types (e.g. `(int32,
                // int32)`) resolved fine. Erase each element (recursively, so a
                // nested tuple/array/user-type element still projects) and
                // rebuild the closed `ValueTuple<...>` shape from the erased
                // elements; symbolic-argument recovery downstream re-derives
                // the real element types for inference same as the other
                // erasure cases.
                {
                    ImmutableArray<TypeSymbol> elementTypes = tuple.ElementTypes;
                    var erasedElements = new Type[elementTypes.Length];
                    for (int i = 0; i < elementTypes.Length; i++)
                    {
                        if (!TryProjectErasedClrType(elementTypes[i], out Type erasedElement))
                        {
                            return false;
                        }

                        erasedElements[i] = erasedElement;
                    }

                    Type tupleOpenDefinition = erasedElements.Length switch
                    {
                        2 => typeof(ValueTuple<,>),
                        3 => typeof(ValueTuple<,,>),
                        4 => typeof(ValueTuple<,,,>),
                        5 => typeof(ValueTuple<,,,,>),
                        6 => typeof(ValueTuple<,,,,,>),
                        7 => typeof(ValueTuple<,,,,,,>),
                        _ => null,
                    };
                    if (tupleOpenDefinition == null)
                    {
                        return false;
                    }

                    erased = tupleOpenDefinition.MakeGenericType(erasedElements);
                    return true;
                }

            case StructSymbol:
                erased = typeof(object);
                return true;
            case EnumSymbol:
                erased = typeof(int);
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Probes a user-defined <see cref="StructSymbol"/> for the
    /// duck-typed enumerable shape (<c>GetEnumerator() → MoveNext() / Current</c>).
    /// </summary>
    /// <param name="type">The user struct symbol to probe.</param>
    /// <param name="elementType">The element <see cref="TypeSymbol"/>, on success.</param>
    /// <returns><see langword="true"/> when the duck-typed shape matches.</returns>
    public static bool TryGetUserPatternEnumerableElementType(StructSymbol type, out TypeSymbol elementType)
    {
        if (TypeMemberModel.TryGetMethodIncludingInherited(type, "GetEnumerator", out var getEnumerator) &&
            getEnumerator.Parameters.Length == 0 &&
            getEnumerator.Type is StructSymbol enumeratorType &&
            TypeMemberModel.TryGetMethodIncludingInherited(enumeratorType, "MoveNext", out var moveNext) &&
            moveNext.Parameters.Length == 0 &&
            moveNext.Type == TypeSymbol.Bool &&
            enumeratorType.TryGetField("Current", out var currentField))
        {
            elementType = currentField.Type;
            return true;
        }

        elementType = null;
        return false;
    }

    /// <summary>
    /// Issue #889: resolves the <see cref="FunctionTypeSymbol"/> shape of any
    /// delegate-like target type — a native G# function type, a user-declared
    /// named delegate (<see cref="DelegateTypeSymbol"/>), or an imported CLR
    /// delegate (<c>System.Action</c>/<c>System.Func</c>/named delegates).
    /// Used to target-type lambda/func literals against delegate parameters
    /// and variable slots.
    /// </summary>
    /// <param name="type">The candidate delegate-like target type.</param>
    /// <param name="functionType">The matching function-type symbol, on success.</param>
    /// <returns><see langword="true"/> when the type is delegate-like.</returns>
    public static bool TryGetDelegateFunctionTypeFromSymbol(TypeSymbol type, out FunctionTypeSymbol functionType)
    {
        functionType = null;
        switch (type)
        {
            case null:
                return false;
            case FunctionTypeSymbol fn:
                functionType = fn;
                return true;
            case DelegateTypeSymbol del:
                functionType = del.EquivalentFunctionType;
                return functionType != null;

            // Issue #2375: a constructed `Func`/`Action`/named-delegate
            // `ImportedTypeSymbol` closed over a same-compilation class or
            // struct (e.g. `Func[Book, Conversion]`) carries a deliberately
            // type-erased closed CLR shape in `ClrType` (#313/#939: the
            // same-compilation argument is projected onto `object` because
            // the real CLR type may not exist yet — it can still be a
            // `TypeBuilder`). Reflecting on `ClrType` via
            // `TryGetDelegateFunctionType(Type, ...)` below therefore widens
            // that argument to `object`. When the symbolic
            // `OpenDefinition`/`TypeArguments` shape (#313 construction) is
            // available and every argument is fully resolved (no leftover
            // open <see cref="TypeParameterSymbol"/>), build the
            // `FunctionTypeSymbol` directly from that symbolic shape instead,
            // preserving the real argument types. Falls through to the
            // reflection-based path below for anything that isn't a simple
            // `Invoke(...)` shape mapping directly onto the delegate's own
            // generic parameters (e.g. an Invoke signature that nests a type
            // parameter inside another generic), and for genuinely-open
            // generic parameters (still-unresolved method type parameters),
            // which keep their existing (deliberate) `object`-widening
            // behavior unchanged.
            case ImportedTypeSymbol imported
                when imported.OpenDefinition != null
                    && !imported.TypeArguments.IsDefaultOrEmpty
                    && !imported.TypeArguments.Any(TypeSymbol.ContainsTypeParameter)
                    && TryGetDelegateFunctionTypeFromOpenDefinition(imported.OpenDefinition, imported.TypeArguments, out functionType):
                return true;
            default:
                return type.ClrType != null && TryGetDelegateFunctionType(type.ClrType, out functionType);
        }
    }

    /// <summary>
    /// Issue #2130: resolves the effective lambda target shape for any target
    /// type that may consume a source lambda — a native function type, a
    /// delegate, or <c>System.Linq.Expressions.Expression&lt;TDelegate&gt;</c>.
    /// Returns the underlying delegate/function signature that should be used
    /// for target-typed lambda parameter/return binding.
    /// </summary>
    /// <param name="type">The candidate lambda target type.</param>
    /// <param name="functionType">The effective function-type shape, on success.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> is a valid lambda target.</returns>
    public static bool TryGetLambdaTargetFunctionTypeFromSymbol(TypeSymbol type, out FunctionTypeSymbol functionType)
    {
        if (TryGetDelegateFunctionTypeFromSymbol(type, out functionType))
        {
            return true;
        }

        if (!TryGetExpressionTreeDelegateTypeFromSymbol(type, out var delegateType) || delegateType == null)
        {
            functionType = null;
            return false;
        }

        return TryGetDelegateFunctionTypeFromSymbol(delegateType, out functionType);
    }

    /// <summary>
    /// Issue #2130: resolves the effective lambda target shape for a CLR
    /// delegate or expression-tree type.
    /// </summary>
    /// <param name="type">The candidate lambda target CLR type.</param>
    /// <param name="functionType">The effective function-type shape, on success.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> is a valid lambda target.</returns>
    public static bool TryGetLambdaTargetFunctionType(Type type, out FunctionTypeSymbol functionType)
    {
        if (TryGetDelegateFunctionType(type, out functionType))
        {
            return true;
        }

        if (!TryGetExpressionTreeDelegateType(type, out var delegateType) || delegateType == null)
        {
            functionType = null;
            return false;
        }

        return TryGetDelegateFunctionType(delegateType, out functionType);
    }

    /// <summary>
    /// Issue #2130: returns the delegate type argument of a
    /// <c>System.Linq.Expressions.Expression&lt;TDelegate&gt;</c> target.
    /// </summary>
    /// <param name="type">The candidate expression-tree target type.</param>
    /// <param name="delegateType">The delegate type argument, on success.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> is an expression-tree target.</returns>
    public static bool TryGetExpressionTreeDelegateTypeFromSymbol(TypeSymbol type, out TypeSymbol delegateType)
    {
        delegateType = null;
        if (type == null)
        {
            return false;
        }

        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && string.Equals(imported.OpenDefinition.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal)
            && imported.TypeArguments.Length == 1)
        {
            delegateType = imported.TypeArguments[0];
            return true;
        }

        if (type.ClrType == null || !TryGetExpressionTreeDelegateType(type.ClrType, out var delegateClrType))
        {
            return false;
        }

        delegateType = TypeSymbol.FromClrType(delegateClrType);
        return true;
    }

    /// <summary>
    /// Issue #2130: returns the delegate type argument of a CLR
    /// <c>Expression&lt;TDelegate&gt;</c> target.
    /// </summary>
    /// <param name="type">The candidate CLR expression-tree target type.</param>
    /// <param name="delegateType">The delegate type argument, on success.</param>
    /// <returns><see langword="true"/> when <paramref name="type"/> is an expression-tree target.</returns>
    public static bool TryGetExpressionTreeDelegateType(Type type, out Type delegateType)
    {
        delegateType = null;
        if (type == null || !type.IsGenericType)
        {
            return false;
        }

        var open = type.IsGenericTypeDefinition ? type : type.GetGenericTypeDefinition();
        if (!string.Equals(open.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal))
        {
            return false;
        }

        var args = type.GetGenericArguments();
        if (args.Length != 1)
        {
            return false;
        }

        delegateType = args[0];
        return true;
    }

    /// <summary>
    /// Probes <paramref name="delegateType"/> for the canonical delegate
    /// shape (<see cref="System.MulticastDelegate"/>-derived, or
    /// <c>System.Func`N</c>/<c>System.Action`N</c>) and exposes the
    /// corresponding <see cref="FunctionTypeSymbol"/>.
    /// </summary>
    /// <param name="delegateType">The candidate delegate CLR type.</param>
    /// <param name="functionType">The matching function-type symbol, on success.</param>
    /// <returns><see langword="true"/> when the type is a delegate shape.</returns>
    public static bool TryGetDelegateFunctionType(Type delegateType, out FunctionTypeSymbol functionType)
    {
        functionType = null;
        if (!ClrTypeUtilities.IsDelegateType(delegateType)
            && !string.Equals(delegateType?.BaseType?.FullName, "System.MulticastDelegate", StringComparison.Ordinal)
            && !(delegateType?.FullName?.StartsWith("System.Func`", StringComparison.Ordinal) == true)
            && !(delegateType?.FullName?.StartsWith("System.Action`", StringComparison.Ordinal) == true))
        {
            return false;
        }

        var invoke = delegateType.GetMethodSafe("Invoke");
        if (invoke == null)
        {
            return false;
        }

        var parameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(parameters.Length);
        var variadicBuilder = ImmutableArray.CreateBuilder<bool>(parameters.Length);
        var anyVariadic = false;
        foreach (var parameter in parameters)
        {
            parameterTypes.Add(parameter.ParameterType.ContainsGenericParameters
                ? TypeSymbol.Object
                : TypeSymbol.FromClrType(parameter.ParameterType));

            // ADR-0102 follow-up / issue #818: a delegate whose CLR Invoke
            // parameter carries [ParamArrayAttribute] is variadic from the
            // G# perspective too — the call-site pack / pass-through rules
            // mirror what direct method calls already do for params methods.
            var paramArray = parameter.GetCustomAttributesData()
                .Any(a => string.Equals(a.AttributeType.FullName, "System.ParamArrayAttribute", StringComparison.Ordinal));
            variadicBuilder.Add(paramArray);
            anyVariadic |= paramArray;
        }

        var returnType = invoke.ReturnType.IsSameAs(typeof(void))
            ? TypeSymbol.Void
            : invoke.ReturnType.ContainsGenericParameters
                ? TypeSymbol.Object
                : TypeSymbol.FromClrType(invoke.ReturnType);
        var variadicFlags = anyVariadic ? variadicBuilder.ToImmutable() : default;
        functionType = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), variadicFlags, returnType);
        return true;
    }

    /// <summary>
    /// Collects the parameter-name set of every overload of
    /// <paramref name="methodName"/> on <paramref name="receiverClrType"/>.
    /// Used to surface "did you mean X" diagnostics for unknown named
    /// arguments; this helper itself does not emit diagnostics.
    /// </summary>
    /// <param name="receiverClrType">The receiver CLR type.</param>
    /// <param name="methodName">The method simple name.</param>
    /// <param name="bindingFlags">The binding flags to use for the
    /// reflection probe.</param>
    /// <returns>The union of parameter names across matching overloads.
    /// Empty when reflection failed.</returns>
    public static HashSet<string> CollectClrParameterNames(Type receiverClrType, string methodName, BindingFlags bindingFlags)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        MethodInfo[] methods;
        try
        {
            methods = receiverClrType.GetMethods(bindingFlags);
        }
        catch
        {
            return names;
        }

        foreach (var method in methods)
        {
            if (!string.Equals(method.Name, methodName, StringComparison.Ordinal))
            {
                continue;
            }

            foreach (var parameter in method.GetParameters())
            {
                if (parameter.Name != null)
                {
                    names.Add(parameter.Name);
                }
            }
        }

        return names;
    }

    /// <summary>
    /// Collects the parameter-name set across every public instance
    /// constructor of <paramref name="clrType"/>. Used in the same way as
    /// <see cref="CollectClrParameterNames"/>, for constructor call sites.
    /// </summary>
    /// <param name="clrType">The CLR type whose constructors to inspect.</param>
    /// <returns>The union of parameter names across matching constructors.
    /// Empty when reflection failed.</returns>
    public static HashSet<string> CollectClrConstructorParameterNames(Type clrType)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        ConstructorInfo[] ctors;
        try
        {
            ctors = ClrTypeUtilities.SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance);
        }
        catch
        {
            return names;
        }

        foreach (var ctor in ctors)
        {
            foreach (var parameter in ctor.GetParameters())
            {
                if (parameter.Name != null)
                {
                    names.Add(parameter.Name);
                }
            }
        }

        return names;
    }

    // ----- User-symbol member walks -----

    /// <summary>
    /// Walks <paramref name="structSymbol"/> and its base-class chain looking
    /// for an instance method overload whose CLR-projected signature matches
    /// <paramref name="clrMethod"/>. Used by the interface-implementation
    /// check to decide whether the user struct supplies a given CLR contract
    /// member.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="clrMethod">The CLR method whose signature to match.</param>
    /// <returns><see langword="true"/> when a matching overload exists.</returns>
    public static bool HasMatchingMethodForClrSignature(StructSymbol structSymbol, MethodInfo clrMethod)
    {
        var clrParams = clrMethod.GetParameters();

        // Issue #2230: an imported (metadata) interface method may itself be
        // generic (e.g. `ILogger.BeginScope<TState>(TState state)`). Those
        // method-own generic parameters need to be matched positionally
        // against the implementer's method type parameters — the same way
        // `TryBuildMethodTypeParameterMap` already does for source-declared
        // interfaces (issue #1007) — because an unbound G# type parameter
        // carries no `ClrType` and the plain `ClrTypeUtilities.AreSame`
        // comparison below can never succeed for it.
        var methodGenericParams = clrMethod.IsGenericMethodDefinition
            ? clrMethod.GetGenericArguments()
            : System.Array.Empty<Type>();

        foreach (var candidate in structSymbol.GetMethodsIncludingInherited(clrMethod.Name))
        {
            var callable = GetCallableParameters(candidate);
            if (callable.Length != clrParams.Length)
            {
                continue;
            }

            var candidateTypeParams = candidate.TypeParameters.IsDefaultOrEmpty
                ? ImmutableArray<TypeParameterSymbol>.Empty
                : candidate.TypeParameters;
            if (methodGenericParams.Length != candidateTypeParams.Length)
            {
                // Generic-arity mismatch: not a viable implementor of this
                // interface method overload (mirrors issue #1007).
                continue;
            }

            // Issue #1071: an `async func` implementing a CLR interface method
            // declared with an explicit `Task` / `Task[T]` return type has a
            // declared (awaited) return of void / T. Compare the contract's
            // unwrapped awaited result against the candidate's declared type.
            if (candidate.IsAsync
                && AsyncReturnTypeNormalizer.TryUnwrapTaskClrType(clrMethod.ReturnType, out var awaitedReturnClr))
            {
                if (!ClrParamTypeMatchesGenericMethodParam(candidate.Type, awaitedReturnClr, methodGenericParams, candidateTypeParams))
                {
                    continue;
                }
            }
            else if (!ClrParamTypeMatchesGenericMethodParam(candidate.Type, clrMethod.ReturnType, methodGenericParams, candidateTypeParams))
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < callable.Length; i++)
            {
                var clrParamType = clrParams[i].ParameterType;
                var gsParam = callable[i];

                if (clrParamType.IsByRef)
                {
                    // The CLR parameter is by-ref (out/ref/in) — compare the
                    // element type and require the G# parameter's RefKind to be
                    // non-None (Out, Ref, or In).
                    if (gsParam.RefKind == RefKind.None)
                    {
                        allMatch = false;
                        break;
                    }

                    var elementType = clrParamType.GetElementType();
                    if (!ClrParamTypeMatchesGenericMethodParam(gsParam.Type, elementType, methodGenericParams, candidateTypeParams))
                    {
                        allMatch = false;
                        break;
                    }
                }
                else
                {
                    // Non-by-ref CLR parameter — the G# side must also be pass-by-value.
                    if (gsParam.RefKind != RefKind.None)
                    {
                        allMatch = false;
                        break;
                    }

                    if (!ClrParamTypeMatchesGenericMethodParam(gsParam.Type, clrParamType, methodGenericParams, candidateTypeParams))
                    {
                        allMatch = false;
                        break;
                    }
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #949: detects a CLR generic interface constructed over at least
    /// one user-defined G# type argument (e.g. <c>IEquatable[Shape]</c>,
    /// including the self-referential <c>class Shape : IEquatable[Shape]</c>
    /// pattern). Such an interface is represented as an
    /// <see cref="ImportedTypeSymbol"/> whose <c>ClrType</c> is the type-erased
    /// closed shape (<c>IEquatable&lt;object&gt;</c>) but whose
    /// <see cref="ImportedTypeSymbol.TypeArguments"/> preserve the real,
    /// symbolic arguments. Matching against the erased shape would demand
    /// <c>Equals(object)</c>; we must instead substitute the symbolic
    /// arguments into the OPEN definition's method signatures.
    /// </summary>
    /// <param name="ifaceSym">The implemented interface type symbol.</param>
    /// <param name="openDefinition">The open generic CLR definition (e.g. <c>IEquatable`1</c>) on success.</param>
    /// <param name="symbolicArgs">The symbolic type arguments (e.g. <c>[Shape]</c>) on success.</param>
    /// <returns><see langword="true"/> when the interface is a symbolic constructed CLR generic.</returns>
    public static bool TryGetSymbolicClrGenericInterface(
        TypeSymbol ifaceSym,
        out Type openDefinition,
        out ImmutableArray<TypeSymbol> symbolicArgs)
    {
        openDefinition = null;
        symbolicArgs = default;

        if (ifaceSym is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && imported.OpenDefinition.IsInterface
            && !imported.TypeArguments.IsDefaultOrEmpty
            && imported.TypeArguments.Any(IsSymbolicTypeArgument))
        {
            openDefinition = imported.OpenDefinition;
            symbolicArgs = imported.TypeArguments;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #949: walks <paramref name="structSymbol"/> (and its base chain)
    /// for an instance method that satisfies <paramref name="openMethod"/> from
    /// a CLR generic interface's OPEN definition, with the interface's
    /// generic parameters substituted by <paramref name="symbolicArgs"/>. A
    /// generic-parameter position in the contract (e.g. the <c>T</c> in
    /// <c>IEquatable&lt;T&gt;.Equals(T)</c>) is matched against the symbolic
    /// type argument (e.g. <c>Shape</c>) using G# type-symbol identity;
    /// non-generic positions fall back to CLR-projected comparison.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="openMethod">The interface method from the open definition.</param>
    /// <param name="symbolicArgs">The symbolic type arguments closing the interface.</param>
    /// <returns><see langword="true"/> when a matching overload exists.</returns>
    public static bool HasMatchingMethodForSymbolicClrInterface(
        StructSymbol structSymbol,
        MethodInfo openMethod,
        ImmutableArray<TypeSymbol> symbolicArgs)
    {
        var clrParams = openMethod.GetParameters();
        foreach (var candidate in structSymbol.GetMethodsIncludingInherited(openMethod.Name))
        {
            var callable = GetCallableParameters(candidate);
            if (callable.Length != clrParams.Length)
            {
                continue;
            }

            if (!ReturnTypeMatchesSubstituted(candidate.Type, openMethod.ReturnType, symbolicArgs))
            {
                continue;
            }

            var allMatch = true;
            for (var i = 0; i < callable.Length; i++)
            {
                var clrParamType = clrParams[i].ParameterType;
                var gsParam = callable[i];

                if (clrParamType.IsByRef)
                {
                    if (gsParam.RefKind == RefKind.None)
                    {
                        allMatch = false;
                        break;
                    }

                    if (!ParameterTypeMatchesSubstituted(gsParam.Type, clrParamType.GetElementType(), symbolicArgs))
                    {
                        allMatch = false;
                        break;
                    }
                }
                else
                {
                    if (gsParam.RefKind != RefKind.None)
                    {
                        allMatch = false;
                        break;
                    }

                    if (!ParameterTypeMatchesSubstituted(gsParam.Type, clrParamType, symbolicArgs))
                    {
                        allMatch = false;
                        break;
                    }
                }
            }

            if (allMatch)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #985: enumerates every abstract instance method slot contributed by
    /// a CLR interface listed in a type's base-type clause, INCLUDING the
    /// methods of every interface it transitively inherits. The declared
    /// interface's slots are reported with <see cref="ClrInterfaceSlot.IsInherited"/>
    /// = <see langword="false"/>; inherited base-interface slots with
    /// <see langword="true"/>. Generic-parameter positions in each slot's
    /// signature resolve against the declared interface's symbolic type
    /// arguments (the base interfaces obtained from the open definition carry
    /// those same generic parameters position-aligned).
    /// </summary>
    /// <param name="ifaceSym">A CLR interface type symbol from the base clause.</param>
    /// <returns>The slots, or an empty sequence when the symbol is not a CLR interface.</returns>
    public static IEnumerable<ClrInterfaceSlot> EnumerateClrInterfaceSlots(TypeSymbol ifaceSym)
    {
        Type declared;
        ImmutableArray<TypeSymbol> symbolicArgs;
        if (TryGetSymbolicClrGenericInterface(ifaceSym, out var openDefinition, out var args))
        {
            declared = openDefinition;
            symbolicArgs = args;
        }
        else if (ifaceSym?.ClrType is Type clr && clr.IsInterface)
        {
            declared = clr;
            symbolicArgs = ImmutableArray<TypeSymbol>.Empty;
        }
        else
        {
            yield break;
        }

        foreach (var slot in MethodsOf(declared, symbolicArgs, isInherited: false))
        {
            yield return slot;
        }

        foreach (var baseIface in declared.GetInterfaces())
        {
            foreach (var slot in MethodsOf(baseIface, symbolicArgs, isInherited: true))
            {
                yield return slot;
            }
        }

        static IEnumerable<ClrInterfaceSlot> MethodsOf(Type iface, ImmutableArray<TypeSymbol> symbolicArgs, bool isInherited)
        {
            foreach (var method in iface.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (method.IsSpecialName || !method.IsAbstract)
                {
                    continue;
                }

                yield return new ClrInterfaceSlot(method, symbolicArgs, isInherited);
            }
        }
    }

    /// <summary>
    /// Issue #985: tests whether a single G# method satisfies a CLR interface
    /// slot — same parameter count, matching ref-kinds, and return/parameter
    /// types equal after substituting the interface's symbolic type arguments
    /// into any generic-parameter positions.
    /// </summary>
    /// <param name="method">The candidate G# method.</param>
    /// <param name="slot">The interface slot to satisfy.</param>
    /// <returns><see langword="true"/> when the method satisfies the slot.</returns>
    public static bool MethodSatisfiesClrSlot(FunctionSymbol method, in ClrInterfaceSlot slot)
    {
        var clrParams = slot.Method.GetParameters();
        var callable = GetCallableParameters(method);
        if (callable.Length != clrParams.Length)
        {
            return false;
        }

        if (!ReturnTypeMatchesSubstituted(method.Type, slot.Method.ReturnType, slot.SymbolicArgs))
        {
            return false;
        }

        for (var i = 0; i < callable.Length; i++)
        {
            var clrParamType = clrParams[i].ParameterType;
            var gsParam = callable[i];

            if (clrParamType.IsByRef)
            {
                if (gsParam.RefKind == RefKind.None
                    || !ParameterTypeMatchesSubstituted(gsParam.Type, clrParamType.GetElementType(), slot.SymbolicArgs))
                {
                    return false;
                }
            }
            else
            {
                if (gsParam.RefKind != RefKind.None
                    || !ParameterTypeMatchesSubstituted(gsParam.Type, clrParamType, slot.SymbolicArgs))
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #985: recognises a covariant-return interface bridge — two
    /// same-name, same-parameter methods that differ ONLY by return type and
    /// satisfy two DIFFERENT CLR interface slots. The canonical case is a
    /// generic collection implementing <c>IEnumerable[T]</c> with both the
    /// generic <c>GetEnumerator() IEnumerator[T]</c> (satisfying
    /// <c>IEnumerable&lt;T&gt;.GetEnumerator</c>) and the non-generic
    /// <c>GetEnumerator() IEnumerator</c> (satisfying the inherited
    /// <c>IEnumerable.GetEnumerator</c>). Such a pair is legal IL even though
    /// G# overload rules (and C#) otherwise reject methods differing only by
    /// return type.
    ///
    /// On success, <paramref name="bridgeMethod"/> is the method bound to an
    /// inherited base-interface slot (the one that, being private or otherwise
    /// non-implicitly-matchable, needs an explicit <c>MethodImpl</c> row) and
    /// <paramref name="bridgeSlot"/> is that slot's CLR method.
    /// </summary>
    /// <param name="implementedClrInterfaces">The CLR interfaces from the type's base clause.</param>
    /// <param name="first">The already-declared method.</param>
    /// <param name="second">The new same-signature method.</param>
    /// <param name="bridgeMethod">The method that explicitly bridges an inherited slot.</param>
    /// <param name="bridgeSlot">The inherited CLR interface slot to bind via MethodImpl.</param>
    /// <returns><see langword="true"/> when the pair forms a valid covariant interface bridge.</returns>
    public static bool TryResolveCovariantInterfaceBridge(
        ImmutableArray<TypeSymbol> implementedClrInterfaces,
        FunctionSymbol first,
        FunctionSymbol second,
        out FunctionSymbol bridgeMethod,
        out MethodInfo bridgeSlot)
    {
        bridgeMethod = null;
        bridgeSlot = null;

        if (first == null || second == null || implementedClrInterfaces.IsDefaultOrEmpty)
        {
            return false;
        }

        // Identical return types are a genuine duplicate, never a bridge.
        if (ReturnTypeSignaturesEqual(first.Type, second.Type))
        {
            return false;
        }

        var slots = new List<ClrInterfaceSlot>();
        foreach (var ifaceSym in implementedClrInterfaces)
        {
            slots.AddRange(EnumerateClrInterfaceSlots(ifaceSym));
        }

        if (slots.Count == 0)
        {
            return false;
        }

        // Find a distinct slot for each method: the pair is a valid bridge only
        // when `first` satisfies a slot that `second` does not, and vice versa.
        ClrInterfaceSlot? firstOnly = null;
        ClrInterfaceSlot? secondOnly = null;
        foreach (var slot in slots)
        {
            var firstOk = MethodSatisfiesClrSlot(first, slot);
            var secondOk = MethodSatisfiesClrSlot(second, slot);
            if (firstOk && !secondOk && firstOnly == null)
            {
                firstOnly = slot;
            }
            else if (secondOk && !firstOk && secondOnly == null)
            {
                secondOnly = slot;
            }
        }

        if (firstOnly == null || secondOnly == null)
        {
            return false;
        }

        // The bridge method is the one bound to an inherited base-interface slot
        // (e.g. the non-generic IEnumerable.GetEnumerator). That slot is the one
        // a private/covariant method cannot implicitly implement, so it needs the
        // explicit MethodImpl row. Prefer an inherited slot; if both are
        // inherited, bridge whichever the second method covers.
        if (secondOnly.Value.IsInherited)
        {
            bridgeMethod = second;
            bridgeSlot = secondOnly.Value.Method;
            return true;
        }

        if (firstOnly.Value.IsInherited)
        {
            bridgeMethod = first;
            bridgeSlot = firstOnly.Value.Method;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Issue #985: renders a short, human-readable signature for a CLR
    /// interface slot method, used in GS0187 diagnostics for inherited
    /// interface members.
    /// </summary>
    /// <param name="method">The interface slot method.</param>
    /// <returns>A signature such as <c>GetEnumerator</c> or <c>CompareTo(T)</c>.</returns>
    public static string FormatClrSlotSignature(MethodInfo method)
    {
        var ps = method.GetParameters();
        if (ps.Length == 0)
        {
            return method.Name;
        }

        var names = new string[ps.Length];
        for (var i = 0; i < ps.Length; i++)
        {
            names[i] = ps[i].ParameterType.Name;
        }

        return $"{method.Name}({string.Join(", ", names)})";
    }

    /// <summary>
    /// Issue #949: tests whether a candidate G# property satisfies an open
    /// CLR interface property whose type may be a generic parameter, with
    /// <paramref name="symbolicArgs"/> substituted in.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="openProp">The interface property from the open definition.</param>
    /// <param name="symbolicArgs">The symbolic type arguments closing the interface.</param>
    /// <returns>The matching <see cref="PropertySymbol"/>, or <see langword="null"/>.</returns>
    public static PropertySymbol FindMatchingPropertyForSymbolicClrInterface(
        StructSymbol structSymbol,
        PropertyInfo openProp,
        ImmutableArray<TypeSymbol> symbolicArgs)
    {
        foreach (var implProp in structSymbol.Properties)
        {
            if (implProp.Name == openProp.Name
                && ParameterTypeMatchesSubstituted(implProp.Type, openProp.PropertyType, symbolicArgs))
            {
                return implProp;
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #949: a type argument is "symbolic" (preserved rather than erased
    /// to <c>object</c>) when it is a user-defined G# type, a generic type
    /// parameter, or a constructed generic mentioning one of those. Mirrors the
    /// emitter's <c>ArgIsSymbolicUserDefined</c> so binding and emit agree on
    /// which arguments survive erasure.
    /// </summary>
    /// <param name="arg">The type argument to classify.</param>
    /// <returns><see langword="true"/> when the argument is symbolic.</returns>
    public static bool IsSymbolicTypeArgument(TypeSymbol arg)
    {
        switch (arg)
        {
            case StructSymbol:
            case InterfaceSymbol:
            case EnumSymbol:
            case DelegateTypeSymbol:
            case TypeParameterSymbol:
                return true;
            case ImportedTypeSymbol nested when nested.OpenDefinition != null
                && !nested.TypeArguments.IsDefaultOrEmpty
                && nested.TypeArguments.Any(IsSymbolicTypeArgument):
                return true;
            case ArrayTypeSymbol arr:
                return IsSymbolicTypeArgument(arr.ElementType);
            case SliceTypeSymbol slice:
                return IsSymbolicTypeArgument(slice.ElementType);
            case NullableTypeSymbol nullable when nullable.UnderlyingType != null:
                return IsSymbolicTypeArgument(nullable.UnderlyingType);
            default:
                return false;
        }
    }

    /// <summary>
    /// Looks up a user-declared property on <paramref name="structSymbol"/>
    /// whose name and CLR-projected type match <paramref name="clrProp"/>.
    /// </summary>
    /// <param name="structSymbol">The user struct symbol to inspect.</param>
    /// <param name="clrProp">The CLR property to match.</param>
    /// <returns>The matching <see cref="PropertySymbol"/>, or
    /// <see langword="null"/> when no match exists.</returns>
    public static PropertySymbol FindMatchingProperty(StructSymbol structSymbol, PropertyInfo clrProp)
    {
        foreach (var implProp in structSymbol.Properties)
        {
            if (implProp.Name == clrProp.Name
                && ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(implProp.Type), clrProp.PropertyType))
            {
                return implProp;
            }
        }

        return null;
    }

    // ----- Indexer / Nullable<> / extension-method probes (instance helpers) -----

    /// <summary>
    /// Looks up a public instance indexer on <paramref name="clrTarget"/>
    /// whose <c>GetIndexParameters()</c> matches <paramref name="boundArguments"/>
    /// by name-based assignability. The caller is expected to have already
    /// bound the index argument expressions — keeping
    /// <see cref="MemberLookup"/> free of <c>BindExpression</c> side effects.
    /// </summary>
    /// <param name="targetType">The symbolic receiver type used to recover
    /// same-compilation generic arguments from the erased CLR shape.</param>
    /// <param name="clrTarget">The CLR receiver type whose indexers to probe.</param>
    /// <param name="boundArguments">The pre-bound index argument expressions.</param>
    /// <param name="indexer">The matching <see cref="PropertyInfo"/>, on success.</param>
    /// <param name="resolvedArguments">The arguments in parameter order, including omitted optional defaults.</param>
    /// <returns><see langword="true"/> when a matching indexer is found.</returns>
    public bool TryResolveClrIndexer(
        TypeSymbol targetType,
        Type clrTarget,
        ImmutableArray<BoundExpression> boundArguments,
        out PropertyInfo indexer,
        out ImmutableArray<BoundExpression> resolvedArguments)
    {
        indexer = null;
        resolvedArguments = default;

        var properties = EnumerateSelfAndInterfaces(clrTarget)
            .SelectMany(type => ClrTypeUtilities.SafeGetProperties(
                type,
                BindingFlags.Public | BindingFlags.Instance))
            .Where(static property => property.GetMethod != null && property.GetIndexParameters().Length > 0)
            .GroupBy(static property => (property.Module, property.MetadataToken))
            .Select(static group => group.First())
            .ToArray();
        var hasSymbolicArgument = boundArguments.Any(static argument =>
            argument.Type?.ClrType == null
            || TypeSymbol.ContainsTypeParameter(argument.Type)
            || TypeSymbol.ContainsSameCompilationUserType(argument.Type)
            || argument.Type is ImportedTypeSymbol { HasSubstitutableTypeArgument: true });
        if (hasSymbolicArgument)
        {
            var applicable = new List<(PropertyInfo Property, ImmutableArray<TypeSymbol> ParameterTypes)>();
            foreach (var property in properties)
            {
                var parameters = property.GetIndexParameters();
                if (parameters.Length != boundArguments.Length)
                {
                    continue;
                }

                var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(parameters.Length);
                var candidateApplicable = true;
                for (var i = 0; i < parameters.Length; i++)
                {
                    var parameterType = GetIndexerParameterTypeSymbol(targetType, property, i);
                    parameterTypes.Add(parameterType);
                    var conversion = ClassifySymbolicIndexerConversion(boundArguments[i].Type, parameterType);
                    if (!conversion.IsImplicit)
                    {
                        candidateApplicable = false;
                        break;
                    }
                }

                if (candidateApplicable)
                {
                    applicable.Add((property, parameterTypes.MoveToImmutable()));
                }
            }

            if (applicable.Count != 0)
            {
                (PropertyInfo Property, ImmutableArray<TypeSymbol> ParameterTypes)? winner = null;
                foreach (var candidate in applicable)
                {
                    var betterThanAll = true;
                    foreach (var other in applicable)
                    {
                        if (ReferenceEquals(candidate.Property, other.Property))
                        {
                            continue;
                        }

                        if (!IsBetterSymbolicIndexerCandidate(candidate.ParameterTypes, other.ParameterTypes, boundArguments))
                        {
                            betterThanAll = false;
                            break;
                        }
                    }

                    if (betterThanAll)
                    {
                        winner = candidate;
                        break;
                    }
                }

                if (winner.HasValue)
                {
                    indexer = winner.Value.Property;
                    resolvedArguments = boundArguments;
                    return true;
                }

                // Do not retry a genuine symbolic ambiguity against the
                // object-erased CLR shape: doing so can incorrectly prefer an
                // object overload over a more specific symbolic interface.
                return false;
            }
        }

        var argTypes = new Type[boundArguments.Length];
        for (var i = 0; i < boundArguments.Length; i++)
        {
            argTypes[i] = boundArguments[i].Type?.ClrType;
            if (argTypes[i] == null)
            {
                // Issue #2471: imported generic receivers constructed with a
                // same-compilation source type use System.Object as the
                // reflection-time placeholder for that symbolic argument.
                // Project an index argument with the same not-yet-emitted type
                // onto that placeholder as well, so overload resolution sees
                // the erased shape while the original BoundExpression keeps
                // the real source TypeSymbol for conversion and emit.
                argTypes[i] = this.binderCtx.References.GetCoreType("System.Object");
            }
        }

        var resolution = OverloadResolution.Resolve(properties.Select(static property => property.GetMethod).ToArray(), argTypes);
        if (resolution.Outcome != OverloadResolution.ResolutionOutcome.Resolved)
        {
            return false;
        }

        indexer = properties.First(property => ReferenceEquals(property.GetMethod, resolution.Best));
        resolvedArguments = OverloadResolver.BuildOrderedCallArguments(
            boundArguments,
            resolution.ParameterMapping,
            resolution.Best.GetParameters());
        return true;
    }

    /// <summary>
    /// Constructs <c>Nullable&lt;TUnderlying&gt;</c> projected onto the
    /// binder's <see cref="ReferenceResolver"/>. Returns false when the
    /// open <c>Nullable&lt;&gt;</c> is not reachable from the references in
    /// scope, or when projecting <paramref name="underlying"/> through the
    /// reference set fails.
    /// </summary>
    /// <param name="underlying">The value-type underlying type.</param>
    /// <param name="constructed">The constructed nullable CLR type, on success.</param>
    /// <returns><see langword="true"/> when construction succeeded.</returns>
    public bool TryGetNullableConstructedType(Type underlying, out Type constructed)
        => NullableLifting.TryConstructNullable(this.binderCtx.References, underlying, out constructed);

    /// <summary>
    /// Enumerates imported CLR method groups for member-call probing. Instance
    /// groups use the same self/interface walk as final CLR instance binding;
    /// extension groups report offset 1 for their synthetic receiver parameter.
    /// </summary>
    /// <param name="staticClassType">The imported static class to inspect, or <see langword="null"/> for receiver calls.</param>
    /// <param name="receiverClrType">The receiver CLR type for instance probes, or <see langword="null"/>.</param>
    /// <param name="methodName">The method name to match.</param>
    /// <param name="includeExtensions">Whether to append imported extension-method probes.</param>
    /// <returns>The imported method probe groups in existing lookup order.</returns>
    public List<ImportedMethodProbe> CollectImportedMethodProbes(Type staticClassType, Type receiverClrType, string methodName, bool includeExtensions)
    {
        var result = new List<ImportedMethodProbe>();
        if (staticClassType != null)
        {
            var statics = ClrTypeUtilities.SafeGetMethods(staticClassType, BindingFlags.Static | BindingFlags.Public)
                .Where(m => string.Equals(m.Name, methodName, StringComparison.Ordinal))
                .ToList();
            if (statics.Count > 0)
            {
                result.Add(new ImportedMethodProbe(statics, receiverParameterOffset: 0));
            }

            return result;
        }

        if (receiverClrType != null)
        {
            var instance = new List<MethodInfo>(SafeGetMethodsIncludingSelfAndInterfaces(receiverClrType, methodName));
            if (instance.Count > 0)
            {
                result.Add(new ImportedMethodProbe(instance, receiverParameterOffset: 0));
            }
        }

        if (includeExtensions)
        {
            var extensions = this.CollectImportedExtensionMethods(methodName);
            if (extensions.Count > 0)
            {
                result.Add(new ImportedMethodProbe(extensions, receiverParameterOffset: 1));
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #294: collects every <c>static [Extension]</c> method named
    /// <paramref name="methodName"/> across the imported extension-holding
    /// classes (see <see cref="GetImportedExtensionClasses"/>).
    /// </summary>
    /// <param name="methodName">The extension method's simple name.</param>
    /// <returns>The list of candidate <see cref="MethodInfo"/> overloads.</returns>
    public List<MethodInfo> CollectImportedExtensionMethods(string methodName)
    {
        var result = new List<MethodInfo>();
        foreach (var type in this.GetImportedExtensionClasses())
        {
            MethodInfo[] methods;
            try
            {
                var flags = BindingFlags.Public | BindingFlags.Static;
                if (this.binderCtx.References.CanAccessInternalMembers(type.Assembly))
                {
                    flags |= BindingFlags.NonPublic;
                }

                methods = type.GetMethods(flags);
            }
            catch
            {
                continue;
            }

            foreach (var method in methods)
            {
                if (!string.Equals(method.Name, methodName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (!HasExtensionAttribute(method) || !IsVisibleImportedMethod(method))
                {
                    continue;
                }

                if (method.GetParameters().Length == 0)
                {
                    continue;
                }

                result.Add(method);
            }
        }

        return result;
    }

    /// <summary>
    /// Issue #294: enumerates static classes declared in the currently
    /// imported namespaces that carry <c>[Extension]</c> (i.e. host
    /// extension methods). The result is cached on the
    /// <see cref="BinderContext"/> — the import count acts as a cheap
    /// invalidation key because imports only grow during binding.
    /// </summary>
    /// <returns>The imported static extension-holding classes.</returns>
    public List<Type> GetImportedExtensionClasses()
    {
        var imports = this.binderCtx.RootScope.GetDeclaredImports();
        var importCount = imports.IsDefault ? 0 : imports.Length;
        if (this.binderCtx.CachedImportedExtensionClasses != null
            && this.binderCtx.CachedImportedExtensionImportCount == importCount
            && ReferenceEquals(
                this.binderCtx.CachedImportedExtensionSyntaxTree,
                this.binderCtx.RootScope.GetCurrentReferencingSyntaxTreeForCache()))
        {
            return this.binderCtx.CachedImportedExtensionClasses;
        }

        var namespaces = new HashSet<string>(StringComparer.Ordinal);
        if (!imports.IsDefault)
        {
            foreach (var import in imports)
            {
                if (!string.IsNullOrEmpty(import.Target))
                {
                    namespaces.Add(import.Target);
                }
            }
        }

        var classes = new List<Type>();
        if (namespaces.Count > 0)
        {
            foreach (var assembly in this.binderCtx.References.Assemblies)
            {
                IEnumerable<Type> types;
                try
                {
                    types = assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException ex)
                {
                    types = ex.Types.Where(t => t != null);
                }
                catch
                {
                    continue;
                }

                foreach (var type in types)
                {
                    if (type == null || type.Namespace == null || !namespaces.Contains(type.Namespace))
                    {
                        continue;
                    }

                    if (!IsStaticClass(type) || !HasExtensionAttribute(type) || !IsVisibleImportedType(type))
                    {
                        continue;
                    }

                    classes.Add(type);
                }
            }
        }

        this.binderCtx.CachedImportedExtensionClasses = classes;
        this.binderCtx.CachedImportedExtensionImportCount = importCount;
        this.binderCtx.CachedImportedExtensionSyntaxTree = this.binderCtx.RootScope.GetCurrentReferencingSyntaxTreeForCache();
        return classes;
    }

    /// <summary>
    /// A C# static class is a sealed abstract class. Detected structurally
    /// so it works under <see cref="System.Reflection.MetadataLoadContext"/>.
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns><see langword="true"/> when the type is a static class.</returns>
    public static bool IsStaticClass(Type type)
        => type.IsClass && type.IsAbstract && type.IsSealed;

    /// <summary>
    /// Robustly detects <c>[System.Runtime.CompilerServices.ExtensionAttribute]</c>
    /// via <see cref="CustomAttributeData"/> (never runtime
    /// <c>GetCustomAttribute</c>, which throws under
    /// <see cref="System.Reflection.MetadataLoadContext"/>).
    /// </summary>
    /// <param name="member">The type or method to inspect.</param>
    /// <returns><see langword="true"/> when the member carries the
    /// extension attribute.</returns>
    public static bool HasExtensionAttribute(MemberInfo member)
    {
        try
        {
            foreach (var attribute in member.GetCustomAttributesData())
            {
                if (string.Equals(
                    attribute.AttributeType?.FullName,
                    "System.Runtime.CompilerServices.ExtensionAttribute",
                    StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }
        catch
        {
            // Reflection failures (notably in MLC) — treat as "no attribute".
        }

        return false;
    }

    /// <summary>
    /// Removes every entry from the method cache.
    /// Called by <see cref="ReferenceResolver.Dispose"/> (#1678, mirroring #1622)
    /// alongside <see cref="ClrTypeUtilities.ClearCache"/>.
    /// </summary>
    internal static void ClearCache() => methodsIncludingSelfAndInterfacesCache = new ConditionalWeakTable<Type, System.Collections.Concurrent.ConcurrentDictionary<string, IReadOnlyList<MethodInfo>>>();

    internal static TypeSymbol GetIndexerParameterTypeSymbol(
        TypeSymbol targetType,
        PropertyInfo closedIndexer,
        int parameterIndex)
    {
        var closedParameter = closedIndexer.GetIndexParameters()[parameterIndex];
        if (GetImportedTypeSymbol(targetType) is ImportedTypeSymbol imported
            && TryGetSymbolicDeclaringContext(
                imported,
                closedIndexer.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments))
        {
            var openIndexer = FindOpenIndexerDefinition(openDefinition, closedIndexer);
            var openParameters = openIndexer?.GetIndexParameters();
            if (openParameters != null && parameterIndex < openParameters.Length)
            {
                return MapOpenClrTypeToSymbolic(
                    openParameters[parameterIndex].ParameterType,
                    openDefinition,
                    declaringTypeArguments);
            }
        }

        var closedParameterType = closedParameter.ParameterType;
        if (closedParameterType.IsConstructedGenericType)
        {
            return ImportedTypeSymbol.GetConstructed(
                closedParameterType,
                closedParameterType.GetGenericTypeDefinition(),
                closedParameterType.GetGenericArguments()
                    .Select(TypeSymbol.FromClrType)
                    .ToImmutableArray());
        }

        return ClrNullability.GetParameterTypeSymbol(closedParameter);
    }

    /// <summary>
    /// Resolves a CLR property's type through a symbolic imported receiver,
    /// including properties declared on inherited generic interfaces.
    /// </summary>
    /// <param name="targetType">The symbolic imported receiver type.</param>
    /// <param name="closedProperty">The reflected property selected from the erased receiver.</param>
    /// <returns>The property type after symbolic receiver substitution.</returns>
    internal static TypeSymbol GetClrPropertyTypeSymbol(TypeSymbol targetType, PropertyInfo closedProperty)
    {
        if (GetImportedTypeSymbol(targetType) is ImportedTypeSymbol imported
            && TryGetSymbolicDeclaringContext(
                imported,
                closedProperty.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments))
        {
            var openProperty = FindOpenIndexerDefinition(openDefinition, closedProperty);
            if (openProperty != null)
            {
                return MapOpenClrTypeToSymbolic(
                    openProperty.PropertyType,
                    openDefinition,
                    declaringTypeArguments);
            }
        }

        return ClrNullability.GetPropertyTypeSymbol(closedProperty);
    }

    /// <summary>Resolves an imported event handler type through a symbolic receiver/interface hierarchy.</summary>
    /// <param name="targetType">The symbolic imported receiver type.</param>
    /// <param name="closedEvent">The reflected event selected from the erased receiver.</param>
    /// <returns>The event handler type after symbolic receiver substitution.</returns>
    internal static TypeSymbol GetClrEventHandlerTypeSymbol(TypeSymbol targetType, EventInfo closedEvent)
    {
        if (GetImportedTypeSymbol(targetType) is ImportedTypeSymbol imported
            && TryGetSymbolicDeclaringContext(
                imported,
                closedEvent.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments))
        {
            var openEvent = ClrTypeUtilities.SafeGetEvents(
                    openDefinition,
                    BindingFlags.Public | BindingFlags.Instance)
                .FirstOrDefault(candidate => candidate.Name == closedEvent.Name);
            if (openEvent?.EventHandlerType != null)
            {
                return MapOpenClrTypeToSymbolic(
                    openEvent.EventHandlerType,
                    openDefinition,
                    declaringTypeArguments);
            }
        }

        return TypeSymbol.FromClrType(closedEvent.EventHandlerType);
    }

    /// <summary>
    /// Reconstructs the symbolic imported interface that actually declares a
    /// reflected member reached through a possibly derived constraint.
    /// </summary>
    /// <param name="targetType">The symbolic imported receiver type.</param>
    /// <param name="member">The reflected member reached through the receiver.</param>
    /// <returns>The symbolic declaring interface used to parent the emitted member reference.</returns>
    internal static TypeSymbol GetClrMemberDeclaringTypeSymbol(
        TypeSymbol targetType,
        MemberInfo member)
    {
        if (GetImportedTypeSymbol(targetType) is ImportedTypeSymbol imported
            && TryGetSymbolicDeclaringContext(
                imported,
                member?.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments))
        {
            return openDefinition.IsGenericTypeDefinition
                ? ImportedTypeSymbol.GetConstructed(
                    member.DeclaringType,
                    openDefinition,
                    declaringTypeArguments)
                : ImportedTypeSymbol.Get(openDefinition);
        }

        return targetType;
    }

    /// <summary>Resolves an imported method return through a symbolic receiver/interface hierarchy.</summary>
    /// <param name="targetType">The symbolic imported receiver type.</param>
    /// <param name="closedMethod">The reflected method selected from the erased receiver.</param>
    /// <returns>The method return type after symbolic receiver substitution.</returns>
    internal static TypeSymbol GetClrMethodReturnTypeSymbol(
        TypeSymbol targetType,
        MethodInfo closedMethod)
    {
        if (GetImportedTypeSymbol(targetType) is ImportedTypeSymbol imported
            && TryGetSymbolicDeclaringContext(
                imported,
                closedMethod?.DeclaringType,
                out var openDefinition,
                out var declaringTypeArguments))
        {
            var openMethod = TryGetOpenMethodOnDeclaringType(openDefinition, closedMethod);
            if (openMethod != null)
            {
                return MapOpenClrTypeToSymbolic(
                    openMethod.ReturnType,
                    openDefinition,
                    declaringTypeArguments);
            }
        }

        return TypeSymbol.FromClrType(closedMethod.ReturnType);
    }

    /// <summary>Finds the symbolic generic context for a reflected declaring type.</summary>
    /// <param name="imported">The symbolic imported receiver.</param>
    /// <param name="declaringType">The reflected member's declaring type.</param>
    /// <param name="openDefinition">The open declaring type definition.</param>
    /// <param name="typeArguments">The receiver-projected declaring type arguments.</param>
    /// <returns><see langword="true"/> when a symbolic declaring context was found.</returns>
    internal static bool TryGetSymbolicDeclaringContext(
        ImportedTypeSymbol imported,
        Type declaringType,
        out Type openDefinition,
        out ImmutableArray<TypeSymbol> typeArguments)
    {
        openDefinition = null;
        typeArguments = default;
        if (imported?.ClrType == null || declaringType == null)
        {
            return false;
        }

        var receiverOpenDefinition = imported.OpenDefinition
            ?? (imported.ClrType.IsGenericType
                ? imported.ClrType.GetGenericTypeDefinition()
                : imported.ClrType);
        var receiverTypeArguments = !imported.TypeArguments.IsDefaultOrEmpty
            ? imported.TypeArguments
            : (imported.ClrType.IsGenericType
                ? imported.ClrType.GetGenericArguments()
                    .Select(TypeSymbol.FromClrType)
                    .ToImmutableArray()
                : ImmutableArray<TypeSymbol>.Empty);

        openDefinition = declaringType.IsGenericType
            ? declaringType.GetGenericTypeDefinition()
            : declaringType;
        if (ClrTypeUtilities.AreSame(receiverOpenDefinition, openDefinition))
        {
            typeArguments = receiverTypeArguments;
            return true;
        }

        if (imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty
            && TryMapThroughImplemented(imported, openDefinition, out typeArguments))
        {
            return true;
        }

        if (declaringType.IsGenericType)
        {
            typeArguments = declaringType.GetGenericArguments()
                .Select(TypeSymbol.FromClrType)
                .ToImmutableArray();
            return true;
        }

        typeArguments = ImmutableArray<TypeSymbol>.Empty;
        return true;
    }

    /// <summary>Unwraps an imported type from an optional CLR nullability annotation.</summary>
    /// <param name="type">The type symbol to unwrap.</param>
    /// <returns>The imported type symbol, or <c>null</c> for another symbol kind.</returns>
    internal static ImportedTypeSymbol GetImportedTypeSymbol(TypeSymbol type)
        => type switch
        {
            ImportedTypeSymbol imported => imported,
            NullabilityAnnotatedTypeSymbol { BaseType: ImportedTypeSymbol imported } => imported,
            _ => null,
        };

    internal static PropertyInfo FindOpenIndexerDefinition(Type openDefinition, PropertyInfo closedIndexer)
    {
        var candidates = ClrTypeUtilities.SafeGetProperties(
            openDefinition,
            BindingFlags.Public | BindingFlags.Instance);
        var token = closedIndexer.MetadataToken;
        foreach (var candidate in candidates)
        {
            if (candidate.MetadataToken == token)
            {
                return candidate;
            }
        }

        var closedParameters = closedIndexer.GetIndexParameters();
        foreach (var candidate in candidates)
        {
            if (!string.Equals(candidate.Name, closedIndexer.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var openParameters = candidate.GetIndexParameters();
            if (openParameters.Length != closedParameters.Length)
            {
                continue;
            }

            var matches = true;
            for (var i = 0; i < openParameters.Length; i++)
            {
                var openType = openParameters[i].ParameterType;
                var closedType = closedParameters[i].ParameterType;
                if (!openType.IsGenericParameter && !ClrTypeUtilities.AreSame(openType, closedType))
                {
                    matches = false;
                    break;
                }
            }

            if (matches)
            {
                return candidate;
            }
        }

        return null;
    }

    internal static TypeSymbol SubstituteOpenIndexerType(
        ImportedTypeSymbol target,
        Type openType,
        Type closedType)
    {
        if (openType.IsGenericParameter
            && openType.DeclaringMethod == null
            && openType.GenericParameterPosition < target.TypeArguments.Length)
        {
            return target.TypeArguments[openType.GenericParameterPosition];
        }

        if (openType.IsByRef)
        {
            return ByRefTypeSymbol.Get(
                SubstituteOpenIndexerType(target, openType.GetElementType()!, closedType.GetElementType()!));
        }

        if (openType.IsArray && openType.GetArrayRank() == 1
            && closedType.IsArray && closedType.GetArrayRank() == 1)
        {
            return SliceTypeSymbol.Get(
                SubstituteOpenIndexerType(target, openType.GetElementType()!, closedType.GetElementType()!));
        }

        if (openType.IsGenericType && closedType.IsGenericType)
        {
            var openArguments = openType.GetGenericArguments();
            var closedArguments = closedType.GetGenericArguments();
            if (openArguments.Length == closedArguments.Length)
            {
                var symbolicArguments = ImmutableArray.CreateBuilder<TypeSymbol>(openArguments.Length);
                for (var i = 0; i < openArguments.Length; i++)
                {
                    symbolicArguments.Add(SubstituteOpenIndexerType(target, openArguments[i], closedArguments[i]));
                }

                return ImportedTypeSymbol.GetConstructed(
                    closedType,
                    openType.GetGenericTypeDefinition(),
                    symbolicArguments.MoveToImmutable());
            }
        }

        return TypeSymbol.FromClrType(closedType);
    }

    internal static TypeSymbol MergeInferredTypeArgument(TypeSymbol existing, TypeSymbol incoming)
        => MergeRecoveredTypeArgument(existing, incoming);

    private static bool IsBetterSymbolicIndexerCandidate(
        ImmutableArray<TypeSymbol> candidate,
        ImmutableArray<TypeSymbol> other,
        ImmutableArray<BoundExpression> arguments)
    {
        var hasBetterConversion = false;
        for (var i = 0; i < arguments.Length; i++)
        {
            var source = arguments[i].Type;
            var candidateConversion = ClassifySymbolicIndexerConversion(source, candidate[i]);
            var otherConversion = ClassifySymbolicIndexerConversion(source, other[i]);
            if (candidateConversion.IsIdentity != otherConversion.IsIdentity)
            {
                if (!candidateConversion.IsIdentity)
                {
                    return false;
                }

                hasBetterConversion = true;
                continue;
            }

            var candidateToOther = ClassifySymbolicIndexerConversion(candidate[i], other[i]).IsImplicit;
            var otherToCandidate = ClassifySymbolicIndexerConversion(other[i], candidate[i]).IsImplicit;
            if (candidateToOther == otherToCandidate)
            {
                continue;
            }

            if (!candidateToOther)
            {
                return false;
            }

            hasBetterConversion = true;
        }

        return hasBetterConversion;
    }

    private static (bool IsImplicit, bool IsIdentity) ClassifySymbolicIndexerConversion(
        TypeSymbol source,
        TypeSymbol target)
    {
        if (SameTypeSymbol(source, target))
        {
            return (true, true);
        }

        if (TryClassifyConstructedGenericConversion(source, target, out var constructedImplicit))
        {
            return (constructedImplicit, false);
        }

        var conversion = Conversion.ClassifyNonStructural(source, target);
        return (conversion.IsImplicit, conversion.IsIdentity);
    }

    private static bool TryClassifyConstructedGenericConversion(
        TypeSymbol source,
        TypeSymbol target,
        out bool isImplicit)
    {
        isImplicit = false;
        if (source is not ImportedTypeSymbol sourceImported
            || target is not ImportedTypeSymbol targetImported
            || sourceImported.OpenDefinition == null
            || targetImported.OpenDefinition == null
            || sourceImported.TypeArguments.IsDefaultOrEmpty
            || targetImported.TypeArguments.IsDefaultOrEmpty)
        {
            return false;
        }

        ImmutableArray<TypeSymbol> sourceArguments;
        if (ClrTypeUtilities.AreSame(sourceImported.OpenDefinition, targetImported.OpenDefinition))
        {
            sourceArguments = sourceImported.TypeArguments;
        }
        else if (!TryMapThroughImplemented(sourceImported, targetImported.OpenDefinition, out sourceArguments))
        {
            return false;
        }

        if (sourceArguments.Length != targetImported.TypeArguments.Length)
        {
            return true;
        }

        var genericParameters = targetImported.OpenDefinition.GetGenericArguments();
        for (var i = 0; i < sourceArguments.Length; i++)
        {
            var variance = genericParameters[i].GenericParameterAttributes
                & GenericParameterAttributes.VarianceMask;
            var compatible = variance switch
            {
                GenericParameterAttributes.Covariant =>
                    Binder.IsReferenceTypeForConstraint(sourceArguments[i])
                    && Binder.IsReferenceTypeForConstraint(targetImported.TypeArguments[i])
                    && ClassifySymbolicIndexerConversion(sourceArguments[i], targetImported.TypeArguments[i]).IsImplicit,
                GenericParameterAttributes.Contravariant =>
                    Binder.IsReferenceTypeForConstraint(sourceArguments[i])
                    && Binder.IsReferenceTypeForConstraint(targetImported.TypeArguments[i])
                    && ClassifySymbolicIndexerConversion(targetImported.TypeArguments[i], sourceArguments[i]).IsImplicit,
                _ => SameTypeSymbol(sourceArguments[i], targetImported.TypeArguments[i]),
            };
            if (!compatible)
            {
                return true;
            }
        }

        isImplicit = true;
        return true;
    }

    /// <summary>
    /// Issue #2375: builds the <see cref="FunctionTypeSymbol"/> shape of a
    /// constructed delegate (<c>Func`N</c>/<c>Action`N</c>/a named delegate)
    /// directly from its open CLR generic definition and the symbolic type
    /// arguments it was constructed with (<see cref="ImportedTypeSymbol.OpenDefinition"/>
    /// / <see cref="ImportedTypeSymbol.TypeArguments"/>), instead of
    /// reflecting over the (possibly type-erased) closed
    /// <see cref="TypeSymbol.ClrType"/>. A delegate's <c>Invoke</c> method
    /// parameters/return map 1:1 onto the delegate type's own open generic
    /// parameters by position (verified: <c>typeof(Func&lt;,&gt;).GetMethod("Invoke")</c>'s
    /// parameter/return <see cref="Type"/> instances are reference-equal to
    /// <c>typeof(Func&lt;,&gt;).GetGenericArguments()</c>), so this only needs to
    /// substitute each such open-parameter slot with the corresponding entry
    /// in <paramref name="typeArguments"/>. Returns <see langword="false"/>
    /// (letting the caller fall back to the reflection-based
    /// <see cref="TryGetDelegateFunctionType(Type, out FunctionTypeSymbol)"/>)
    /// for any Invoke slot that is NOT directly one of the delegate's own
    /// generic parameters (e.g. a named delegate whose Invoke signature nests
    /// a type parameter inside another generic, such as <c>List&lt;T&gt;</c>) —
    /// an intentionally conservative scope covering the overwhelmingly common
    /// <c>Func</c>/<c>Action</c>/simple-named-delegate shape without
    /// attempting general type substitution.
    /// </summary>
    /// <param name="openDefinition">The delegate's open CLR generic definition (e.g. <c>typeof(Func&lt;,&gt;)</c>).</param>
    /// <param name="typeArguments">The symbolic type arguments the delegate was constructed with.</param>
    /// <param name="functionType">The matching function-type symbol, on success.</param>
    /// <returns><see langword="true"/> when every Invoke parameter/return slot could be mapped symbolically.</returns>
    private static bool TryGetDelegateFunctionTypeFromOpenDefinition(Type openDefinition, ImmutableArray<TypeSymbol> typeArguments, out FunctionTypeSymbol functionType)
    {
        functionType = null;
        if (openDefinition == null
            || typeArguments.IsDefaultOrEmpty
            || !openDefinition.IsGenericTypeDefinition
            || (!ClrTypeUtilities.IsDelegateType(openDefinition)
                && !string.Equals(openDefinition.BaseType?.FullName, "System.MulticastDelegate", StringComparison.Ordinal)
                && !(openDefinition.FullName?.StartsWith("System.Func`", StringComparison.Ordinal) == true)
                && !(openDefinition.FullName?.StartsWith("System.Action`", StringComparison.Ordinal) == true)))
        {
            return false;
        }

        var openGenericParams = openDefinition.GetGenericArguments();
        if (openGenericParams.Length != typeArguments.Length)
        {
            return false;
        }

        MethodInfo invoke;
        try
        {
            invoke = openDefinition.GetMethod("Invoke");
        }
        catch (Exception ex) when (ex is AmbiguousMatchException || ex is NotSupportedException)
        {
            return false;
        }

        if (invoke == null)
        {
            return false;
        }

        static bool TryMapSlot(Type invokeSlotType, Type openDefinitionForSlot, ImmutableArray<TypeSymbol> args, out TypeSymbol mapped)
        {
            if (invokeSlotType.IsGenericParameter
                && ClrTypeUtilities.IsSameAs(invokeSlotType.DeclaringType, openDefinitionForSlot)
                && invokeSlotType.GenericParameterPosition >= 0
                && invokeSlotType.GenericParameterPosition < args.Length)
            {
                mapped = args[invokeSlotType.GenericParameterPosition];
                return mapped != null;
            }

            mapped = null;
            return false;
        }

        var parameters = invoke.GetParameters();
        var parameterTypes = ImmutableArray.CreateBuilder<TypeSymbol>(parameters.Length);
        var variadicBuilder = ImmutableArray.CreateBuilder<bool>(parameters.Length);
        var anyVariadic = false;
        foreach (var parameter in parameters)
        {
            if (!TryMapSlot(parameter.ParameterType, openDefinition, typeArguments, out var mappedParam))
            {
                return false;
            }

            parameterTypes.Add(mappedParam);

            // ADR-0102 follow-up / issue #818: mirror TryGetDelegateFunctionType's
            // variadic-flag handling so a params-shaped named delegate keeps
            // its call-site pack/pass-through behavior through this path too.
            var paramArray = parameter.GetCustomAttributesData()
                .Any(a => string.Equals(a.AttributeType.FullName, "System.ParamArrayAttribute", StringComparison.Ordinal));
            variadicBuilder.Add(paramArray);
            anyVariadic |= paramArray;
        }

        TypeSymbol returnType;
        if (invoke.ReturnType.IsSameAs(typeof(void)))
        {
            returnType = TypeSymbol.Void;
        }
        else if (!TryMapSlot(invoke.ReturnType, openDefinition, typeArguments, out returnType))
        {
            return false;
        }

        var variadicFlags = anyVariadic ? variadicBuilder.ToImmutable() : default;
        functionType = FunctionTypeSymbol.Get(parameterTypes.ToImmutable(), variadicFlags, returnType);
        return true;
    }

    private bool IsVisibleImportedMethod(MethodBase method)
        => method.IsPublic || (method.IsAssembly && this.binderCtx.References.CanAccessInternalMembers(method.DeclaringType?.Assembly));

    private bool IsVisibleImportedType(Type type)
        => type.IsPublic || type.IsNestedPublic || ((type.IsNotPublic || type.IsNestedAssembly) && this.binderCtx.References.CanAccessInternalMembers(type.Assembly));

    /// <summary>
    /// Returns the callable parameter slice of <paramref name="method"/> —
    /// dropping the synthetic receiver slot used by extension methods so
    /// signature-matching against a CLR contract sees only the
    /// explicitly-declared parameters. Mirrors
    /// <c>Binder.GetCallableParameters</c> byte-for-byte (kept duplicated
    /// rather than widening the binder's helper to <c>internal</c>; the
    /// implementation is a one-liner).
    /// </summary>
    /// <param name="method">The user function symbol.</param>
    /// <returns>The parameters visible to a non-extension caller.</returns>
    private static ImmutableArray<ParameterSymbol> GetCallableParameters(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    /// <summary>
    /// Issue #1305 / #821: resolves the <c>System.Object</c> used to erase the
    /// type arguments when closing <paramref name="openDef"/> via
    /// <see cref="Type.MakeGenericType"/>. When <paramref name="openDef"/> was
    /// loaded by the references' <c>MetadataLoadContext</c> (reference-pack
    /// assemblies), passing a live <c>typeof(object)</c> raises an
    /// <see cref="ArgumentException"/> ("type was not loaded by the
    /// MetadataLoadContext that loaded the generic type or method"). A generic
    /// parameter's effective base type is <c>System.Object</c> in that same
    /// context, so reuse it. Falls back to the host <c>typeof(object)</c> when
    /// <paramref name="openDef"/> lives in the host runtime or no
    /// <c>System.Object</c> base can be recovered.
    /// </summary>
    /// <param name="openDef">The open generic type definition being closed.</param>
    /// <returns>An <c>object</c> <see cref="Type"/> loaded in the same context as <paramref name="openDef"/>.</returns>
    private static Type ResolveErasedObjectInContext(Type openDef)
    {
        var hostObject = typeof(object);
        if (openDef == null || openDef.Assembly == hostObject.Assembly)
        {
            return hostObject;
        }

        foreach (var p in openDef.GetGenericArguments())
        {
            var baseType = p.BaseType;
            if (baseType != null && baseType.FullName == "System.Object")
            {
                return baseType;
            }
        }

        return hostObject;
    }

    /// <summary>
    /// Issue #1422: builds the type-erased closed shape for a constructed
    /// generic whose symbolic arguments may themselves be constructed generics
    /// (e.g. <c>IEnumerable&lt;IEnumerator&lt;T&gt;&gt;</c>). Each top-level
    /// argument's <em>nested</em> generic structure is preserved by recursing
    /// through its open definition, while leaf type parameters and concrete
    /// leaves collapse to the context's <c>object</c> placeholder — matching the
    /// erasure applied to selector/lambda parameter types, so generic inference
    /// recovers the right element type for a chained extension call. Falls back
    /// to a flat all-<c>object</c> erasure, then to <see langword="null"/>, when
    /// the richer construction is rejected (e.g. cross-context or constraint
    /// violations).
    /// </summary>
    /// <param name="openDef">The open generic type definition being closed.</param>
    /// <param name="openParams">The open definition's generic parameters.</param>
    /// <param name="symbolicArgs">The symbolic type arguments, aligned with <paramref name="openParams"/>.</param>
    /// <param name="contextObject">The <c>object</c> placeholder resolved in <paramref name="openDef"/>'s context.</param>
    /// <returns>The erased closed CLR type, or <see langword="null"/> when no valid closure could be formed.</returns>
    private static Type TryBuildErasedClosedGeneric(Type openDef, Type[] openParams, ImmutableArray<TypeSymbol> symbolicArgs, Type contextObject)
    {
        var richArgs = new Type[openParams.Length];
        var anyRich = false;
        for (var i = 0; i < openParams.Length; i++)
        {
            var projected = i < symbolicArgs.Length
                ? ProjectSymbolicArgToErasedClr(symbolicArgs[i], contextObject)
                : null;
            if (projected != null && !projected.IsSameAs(contextObject))
            {
                anyRich = true;
            }

            richArgs[i] = projected ?? contextObject;
        }

        if (anyRich)
        {
            try
            {
                return openDef.MakeGenericType(richArgs);
            }
            catch
            {
                // Fall through to the flat erasure below.
            }
        }

        var flatArgs = new Type[openParams.Length];
        for (var i = 0; i < openParams.Length; i++)
        {
            flatArgs[i] = contextObject;
        }

        try
        {
            return openDef.MakeGenericType(flatArgs);
        }
        catch
        {
            // Constraint or cross-context failure — caller falls back to the
            // open shape; downstream emit still encodes correctly via the
            // OpenDefinition + TypeArguments.
            return null;
        }
    }

    /// <summary>
    /// Issue #1422: projects a single symbolic type argument onto an erased CLR
    /// type in <paramref name="contextObject"/>'s load context. Nested
    /// constructed generics (carrying an <see cref="ImportedTypeSymbol.OpenDefinition"/>)
    /// are rebuilt recursively so their generic shape survives; leaf type
    /// parameters and other leaves collapse to <paramref name="contextObject"/>.
    /// Returns <see langword="null"/> when no useful erasure could be formed.
    /// </summary>
    /// <param name="symbolicArg">The symbolic type argument.</param>
    /// <param name="contextObject">The <c>object</c> placeholder for the target context.</param>
    /// <returns>The erased CLR type, or <see langword="null"/>.</returns>
    private static Type ProjectSymbolicArgToErasedClr(TypeSymbol symbolicArg, Type contextObject)
    {
        switch (symbolicArg)
        {
            case null:
            case TypeParameterSymbol:
                return contextObject;
            case EnumSymbol:
                // Issue #2391: same-compilation enums already use Int32 as
                // their overload-resolution ride-through. Use that same
                // surrogate when closing an imported generic receiver so a
                // struct-constrained interface such as IRepo<Color> can expose
                // a closed Echo(Nullable<Int32>) candidate instead of falling
                // back to the unusable open Echo(Nullable<T>) signature.
                return contextObject.Assembly == typeof(object).Assembly
                    ? typeof(int)
                    : contextObject.Assembly.GetType(typeof(int).FullName, throwOnError: false);
            case ImportedTypeSymbol imp when imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty:
                return TryBuildErasedClosedGeneric(
                    imp.OpenDefinition,
                    imp.OpenDefinition.GetGenericArguments(),
                    imp.TypeArguments,
                    contextObject);
            case TupleTypeSymbol tuple:
                // Issue #1902: a positional tuple carrying a same-compilation
                // user element (e.g. the `(Owner, Pet)` transparent identifier
                // a Join's result-selector returns) has a null ClrType —
                // `TupleTypeSymbol.BuildClrType` refuses to build
                // `ValueTuple<...>` when any element's own ClrType is null.
                // Flattening it to the bare `contextObject` placeholder (the
                // `default` arm below) would still satisfy *this* call's own
                // generic constraints, but the erased closed generic loses the
                // tuple shape entirely (`IEnumerable<object>` instead of
                // `IEnumerable<ValueTuple<object, object>>`), so the *next*
                // chained call (`.Select(t => …)`) can no longer structurally
                // match its own tuple-typed delegate parameter and dead-ends
                // at GS0159. Build the erased `ValueTuple<...>` shape in
                // `contextObject`'s own load context (see
                // <see cref="BuildErasedTupleInContext"/>) — a host-context
                // `typeof(ValueTuple<,>)` (what `TryProjectErasedClrType` would
                // build) cannot close over an MLC-loaded `contextObject`
                // (cross-context `MakeGenericType` throws), the same reason
                // `ResolveErasedObjectInContext` exists for the plain-object
                // case above.
                return BuildErasedTupleInContext(tuple, contextObject);
            default:
                // Concrete leaf (e.g. a fully-closed imported type): erase to the
                // context placeholder so the shape stays in a single load context
                // and mirrors how the same leaf is erased on the selector side.
                return contextObject;
        }
    }

    /// <summary>
    /// Issue #1902: builds the erased <c>ValueTuple&lt;...&gt;</c> shape for a
    /// <see cref="TupleTypeSymbol"/> element-by-element, staying in
    /// <paramref name="contextObject"/>'s load context throughout (both the
    /// <c>ValueTuple`N</c> open definition and every element are resolved from
    /// that context, recursing via <see cref="ProjectSymbolicArgToErasedClr"/>
    /// so a nested generic/tuple element keeps its own structure too).
    /// </summary>
    /// <param name="tuple">The symbolic tuple type.</param>
    /// <param name="contextObject">The <c>object</c> placeholder resolved in the target context.</param>
    /// <returns>The erased closed tuple CLR type, or <see langword="null"/> when none could be built.</returns>
    private static Type BuildErasedTupleInContext(TupleTypeSymbol tuple, Type contextObject)
    {
        Type tupleOpenDefinition = ResolveErasedValueTupleOpenDefinition(contextObject, tuple.ElementTypes.Length);
        if (tupleOpenDefinition == null)
        {
            return null;
        }

        var erasedElements = new Type[tuple.ElementTypes.Length];
        for (int i = 0; i < tuple.ElementTypes.Length; i++)
        {
            erasedElements[i] = ProjectSymbolicArgToErasedClr(tuple.ElementTypes[i], contextObject) ?? contextObject;
        }

        try
        {
            return tupleOpenDefinition.MakeGenericType(erasedElements);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Issue #1902: resolves the open <c>System.ValueTuple`N</c> generic type
    /// definition for the given arity, in the same load context as
    /// <paramref name="contextObject"/>. <c>System.ValueTuple</c> lives in the
    /// same core assembly as <c>System.Object</c>, so when
    /// <paramref name="contextObject"/> is not the host <c>typeof(object)</c>
    /// (i.e. it was resolved in an isolated <c>MetadataLoadContext</c> per
    /// <see cref="ResolveErasedObjectInContext"/>), the matching
    /// <c>ValueTuple`N</c> is looked up from that same assembly rather than
    /// using the host BCL's <c>typeof(ValueTuple&lt;,&gt;)</c> (which
    /// <c>MakeGenericType</c> would reject with a cross-context
    /// <see cref="ArgumentException"/>).
    /// </summary>
    /// <param name="contextObject">The <c>object</c> placeholder resolved in the target context.</param>
    /// <param name="arity">The tuple arity (2–7; the BCL <c>ValueTuple</c> family's generic range).</param>
    /// <returns>The open <c>ValueTuple`N</c> definition, or <see langword="null"/> when unsupported/unresolvable.</returns>
    private static Type ResolveErasedValueTupleOpenDefinition(Type contextObject, int arity)
    {
        Type hostOpenDefinition = arity switch
        {
            2 => typeof(ValueTuple<,>),
            3 => typeof(ValueTuple<,,>),
            4 => typeof(ValueTuple<,,,>),
            5 => typeof(ValueTuple<,,,,>),
            6 => typeof(ValueTuple<,,,,,>),
            7 => typeof(ValueTuple<,,,,,,>),
            _ => null,
        };
        if (hostOpenDefinition == null)
        {
            return null;
        }

        if (contextObject == null || contextObject.Assembly == typeof(object).Assembly)
        {
            return hostOpenDefinition;
        }

        return contextObject.Assembly.GetType(hostOpenDefinition.FullName, throwOnError: false);
    }

    private static bool ReturnTypeMatchesSubstituted(TypeSymbol candidateReturn, Type openReturn, ImmutableArray<TypeSymbol> symbolicArgs)
    {
        if (openReturn.IsSameAs(typeof(void)))
        {
            return candidateReturn == TypeSymbol.Void;
        }

        return ParameterTypeMatchesSubstituted(candidateReturn, openReturn, symbolicArgs);
    }

    private static bool ParameterTypeMatchesSubstituted(TypeSymbol candidate, Type openType, ImmutableArray<TypeSymbol> symbolicArgs)
    {
        if (openType.IsGenericParameter)
        {
            var position = openType.GenericParameterPosition;
            if (position < 0 || position >= symbolicArgs.Length)
            {
                return false;
            }

            return SameTypeSymbol(candidate, symbolicArgs[position]);
        }

        // Issue #2380 follow-up: a contract position of `Nullable<T>` (e.g.
        // `T? Find()` on `IRepo<T> where T : struct`) is a constructed
        // generic whose single type argument is the interface's OWN generic
        // parameter, not an `ImportedTypeSymbol`'s type argument. A G#
        // candidate satisfying this via `Color?` projects as a
        // `NullableTypeSymbol`, which the `ImportedTypeSymbol` branch below
        // does not recognize — it would fall through to the erased
        // CLR-projected comparison, which fails for same-compilation
        // `UnderlyingType`s (their `ClrType` is always null). Unwrap both
        // sides structurally instead.
        if (openType.IsConstructedGenericType
            && openType.GetGenericTypeDefinition().IsSameAs(typeof(Nullable<>))
            && candidate is NullableTypeSymbol nullableCandidate)
        {
            return ParameterTypeMatchesSubstituted(nullableCandidate.UnderlyingType, openType.GetGenericArguments()[0], symbolicArgs);
        }

        // Issue #985: the contract position may itself be a *constructed
        // generic* that mentions the interface's generic parameters — e.g.
        // `IEnumerable<T>.GetEnumerator()` returns `IEnumerator<T>`. The erased
        // CLR-projection comparison below would demand `IEnumerator<object>`
        // and wrongly reject a candidate returning `IEnumerator[T]`. Recurse
        // structurally instead, substituting the interface's generic parameters
        // with the symbolic arguments at each nested position (mirrors the
        // #974 `InterfaceSymbol.SubstituteType` recursion on the G# path).
        if (openType.IsConstructedGenericType
            && candidate is ImportedTypeSymbol importedCandidate
            && importedCandidate.OpenDefinition != null
            && !importedCandidate.TypeArguments.IsDefaultOrEmpty)
        {
            var openDefinition = openType.GetGenericTypeDefinition();
            if (importedCandidate.OpenDefinition.IsSameAs(openDefinition))
            {
                var openArgs = openType.GetGenericArguments();
                if (openArgs.Length == importedCandidate.TypeArguments.Length)
                {
                    for (var i = 0; i < openArgs.Length; i++)
                    {
                        if (!ParameterTypeMatchesSubstituted(importedCandidate.TypeArguments[i], openArgs[i], symbolicArgs))
                        {
                            return false;
                        }
                    }

                    return true;
                }
            }

            return false;
        }

        // Non-generic contract position — compare against the CLR-projected
        // effective type, exactly as the erased path does.
        return ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(candidate), openType);
    }

    private static bool SameTypeSymbol(TypeSymbol a, TypeSymbol b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        if (a is ImportedTypeSymbol importedA
            && b is ImportedTypeSymbol importedB
            && importedA.OpenDefinition != null
            && importedB.OpenDefinition != null
            && (!importedA.TypeArguments.IsDefaultOrEmpty || !importedB.TypeArguments.IsDefaultOrEmpty))
        {
            if (!ClrTypeUtilities.AreSame(importedA.OpenDefinition, importedB.OpenDefinition)
                || importedA.TypeArguments.Length != importedB.TypeArguments.Length)
            {
                return false;
            }

            for (var i = 0; i < importedA.TypeArguments.Length; i++)
            {
                if (!SameTypeSymbol(importedA.TypeArguments[i], importedB.TypeArguments[i]))
                {
                    return false;
                }
            }

            return true;
        }

        if (a is SliceTypeSymbol sliceA && b is SliceTypeSymbol sliceB)
        {
            return SameTypeSymbol(sliceA.ElementType, sliceB.ElementType);
        }

        if (a is NullableTypeSymbol nullableA && b is NullableTypeSymbol nullableB)
        {
            return SameTypeSymbol(nullableA.UnderlyingType, nullableB.UnderlyingType);
        }

        // Constructed user generics are interned (StructSymbol.Construct uses a
        // cache), so reference identity usually holds; fall back to a
        // structural comparison by definition + ordered type arguments.
        if (a is StructSymbol sa && b is StructSymbol sb)
        {
            if (!ReferenceEquals(sa.Definition, sb.Definition))
            {
                return false;
            }

            if (sa.TypeArguments.Length != sb.TypeArguments.Length)
            {
                return false;
            }

            for (var i = 0; i < sa.TypeArguments.Length; i++)
            {
                if (!SameTypeSymbol(sa.TypeArguments[i], sb.TypeArguments[i]))
                {
                    return false;
                }
            }

            return true;
        }

        if (a.ClrType != null && b.ClrType != null)
        {
            return ClrTypeUtilities.AreSame(a.ClrType, b.ClrType);
        }

        return false;
    }

    private static bool ReturnTypeSignaturesEqual(TypeSymbol a, TypeSymbol b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a == null || b == null)
        {
            return false;
        }

        if (SameTypeSymbol(a, b))
        {
            return true;
        }

        var ca = NullableLifting.GetEffectiveClrType(a);
        var cb = NullableLifting.GetEffectiveClrType(b);
        return ca != null && cb != null && ClrTypeUtilities.AreSame(ca, cb);
    }

    /// <summary>
    /// Returns whether <paramref name="candidate"/> is hidden by any method
    /// already in <paramref name="existing"/>. Same-name-and-parameter-types
    /// hiding mirrors C# semantics.
    /// </summary>
    private static bool IsMethodHiddenByExisting(List<MethodInfo> existing, MethodInfo candidate)
    {
        foreach (var m in existing)
        {
            if (!string.Equals(m.Name, candidate.Name, StringComparison.Ordinal))
            {
                continue;
            }

            var existingParams = m.GetParameters();
            var candidateParams = candidate.GetParameters();
            if (existingParams.Length != candidateParams.Length)
            {
                continue;
            }

            var match = true;
            for (var i = 0; i < existingParams.Length; i++)
            {
                if (!ClrTypeUtilities.AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType))
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #2375: locates the counterpart of <paramref name="genericMethod"/>
    /// (a method already opened at its OWN generic-method-parameter level, e.g.
    /// via <c>MethodInfo.GetGenericMethodDefinition()</c>) on
    /// <paramref name="openDeclaringType"/> — the receiver's fully open
    /// declaring type (all of ITS OWN type parameters unbound too). This
    /// matters because <c>GetGenericMethodDefinition()</c> only opens the
    /// method's own type parameters; if the method's DECLARING type was
    /// already closed (e.g. erased to <c>object</c> by overload resolution),
    /// the declaring type's arguments remain closed on the result, silently
    /// corrupting any reference to the declaring type's own type parameter
    /// inside the method's signature (e.g. a return type like
    /// <c>DependentBuilder&lt;TRelated, TEntity&gt;</c> would keep `TEntity`
    /// erased to `object` even after re-opening `TRelated`). Match is by
    /// metadata token + module, which is stable for methods on a constructed
    /// generic type.
    /// </summary>
    /// <param name="openDeclaringType">The receiver's open generic type definition.</param>
    /// <param name="genericMethod">The method to re-project onto <paramref name="openDeclaringType"/>.</param>
    /// <returns>The fully open method, or <see langword="null"/> when no match is found.</returns>
    private static MethodInfo TryGetOpenMethodOnDeclaringType(Type openDeclaringType, MethodInfo genericMethod)
    {
        if (openDeclaringType == null || genericMethod == null)
        {
            return null;
        }

        if (ClrTypeUtilities.AreSame(genericMethod.DeclaringType, openDeclaringType))
        {
            return genericMethod;
        }

        var token = genericMethod.MetadataToken;
        var module = genericMethod.Module;
        const BindingFlags bindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
        foreach (var candidate in openDeclaringType.GetMethods(bindingFlags))
        {
            if (candidate.MetadataToken == token && ReferenceEquals(candidate.Module, module))
            {
                return candidate.IsGenericMethodDefinition || !candidate.IsGenericMethod
                    ? candidate
                    : candidate.GetGenericMethodDefinition();
            }
        }

        return null;
    }

    private static void UnifyForMethodTypeArgs(Type openClr, TypeSymbol actual, MethodInfo openMethod, TypeSymbol[] result)
    {
        if (openClr == null || actual == null)
        {
            return;
        }

        // A direct MVar match must observe the complete symbolic actual before
        // nullable-reference wrappers are removed for outer structural
        // matching. Multiple inference sources join compatible nullable
        // evidence instead of depending on argument order.
        if (openClr.IsGenericParameter && openClr.DeclaringMethod != null)
        {
            if (ReferenceEquals(openClr.DeclaringMethod, openMethod)
                || openClr.DeclaringMethod.MetadataToken == openMethod.MetadataToken)
            {
                var pos = openClr.GenericParameterPosition;
                if ((uint)pos < (uint)result.Length)
                {
                    var recovered = NormalizeRecoveredNullability(actual);
                    result[pos] = MergeInferredTypeArgument(result[pos], recovered);
                }
            }

            return;
        }

        // Reference-type nullability is a source annotation and does not add a
        // CLR wrapper. Unify through it so a nullable reference receiver such as
        // IEnumerable<Choice>? still recovers TSource = Choice. Preserve real
        // Nullable<T> value shapes (including same-compilation enums/structs).
        if (actual is NullableTypeSymbol nullableActual
            && !NullableLifting.IsAnyValueTypeNullable(nullableActual))
        {
            actual = nullableActual.UnderlyingType;
        }

        // T[] / []T (open array element).
        if (openClr.IsArray && openClr.GetArrayRank() == 1)
        {
            var openElement = openClr.GetElementType();
            var actualElement = TryGetElementType(actual);
            if (actualElement != null)
            {
                UnifyForMethodTypeArgs(openElement, actualElement, openMethod, result);
            }

            return;
        }

        if (openClr.IsByRef)
        {
            var openPointee = openClr.GetElementType();
            if (actual is ByRefTypeSymbol bf)
            {
                UnifyForMethodTypeArgs(openPointee, bf.PointeeType, openMethod, result);
            }
            else
            {
                UnifyForMethodTypeArgs(openPointee, actual, openMethod, result);
            }

            return;
        }

        if (openClr.IsGenericType && !openClr.IsGenericTypeDefinition)
        {
            var openDef = openClr.GetGenericTypeDefinition();
            var openArgs = openClr.GetGenericArguments();

            if (actual is TupleTypeSymbol tuple
                && openDef.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true
                && openArgs.Length == tuple.ElementTypes.Length)
            {
                for (var i = 0; i < openArgs.Length; i++)
                {
                    UnifyForMethodTypeArgs(openArgs[i], tuple.ElementTypes[i], openMethod, result);
                }

                return;
            }

            // Pattern A: actual is an ImportedTypeSymbol whose OpenDefinition matches exactly.
            if (actual is ImportedTypeSymbol imp
                && imp.OpenDefinition != null
                && ClrTypeUtilities.AreSame(imp.OpenDefinition, openDef)
                && !imp.TypeArguments.IsDefaultOrEmpty
                && imp.TypeArguments.Length == openArgs.Length)
            {
                for (int j = 0; j < openArgs.Length; j++)
                {
                    UnifyForMethodTypeArgs(openArgs[j], imp.TypeArguments[j], openMethod, result);
                }

                return;
            }

            // Issue #2375: open formal is `Expression<TDelegate>` and actual is a
            // G# arrow/lambda (FunctionTypeSymbol) — i.e. a deferred lambda
            // argument being matched against an expression-tree-wrapped
            // parameter such as `HasOne<TRelated>(Expression<Func<TEntity,
            // TRelated>>)`. A lambda literal's bound type is always its bare
            // `FunctionTypeSymbol` shape (Expression<> wrapping only happens via
            // a later argument CONVERSION, never as the lambda's own natural
            // type), so without this unwrap the outer `openArgs.Length == 1`
            // (Expression`1's own single type argument, the `Func<...>` shape)
            // never matches the FunctionTypeSymbol pattern below (which expects
            // `openArgs.Length` to equal the delegate's own parameter/return
            // arity). Unwrapping one level lets the existing #1334 pattern unify
            // the inner `Func<TEntity, TRelated>` shape against the lambda's
            // parameter/return types directly, recovering `TRelated` for a
            // fully-inferred call (no explicit type argument) whose only
            // occurrence is the delegate's return position.
            if (openArgs.Length == 1
                && actual is FunctionTypeSymbol
                && string.Equals(openDef.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal))
            {
                UnifyForMethodTypeArgs(openArgs[0], actual, openMethod, result);
                return;
            }

            // Issue #1334: open formal is a delegate shape (Func<…, TResult> /
            // Action<…>) and actual is a G# arrow/lambda (FunctionTypeSymbol).
            // Unify each delegate parameter with the lambda's parameter type and
            // — for Func — the trailing return slot with the lambda's return
            // type. This recovers a method type parameter that only appears in
            // the projection result (e.g. the `TResult` of
            // `Select<TSource, TResult>(this IEnumerable<TSource>,
            // Func<TSource, TResult>)`) when that result is a same-compilation
            // user type whose CLR backing is still erased to `object` during
            // binding. Without this, `dict.Values.Select((e Entry) -> e.Member)`
            // surfaces `IEnumerable<object>` and the loop variable loses the
            // user element identity (GS0159). The receiver still supplies
            // `TSource` via Pattern C.
            if (actual is FunctionTypeSymbol fn)
            {
                var fnVoid = FunctionTypeSymbol.IsVoidReturn(fn.ReturnType);
                var expectedArgs = fnVoid ? fn.ParameterTypes.Length : fn.ParameterTypes.Length + 1;
                if (openArgs.Length == expectedArgs)
                {
                    for (int j = 0; j < fn.ParameterTypes.Length; j++)
                    {
                        UnifyForMethodTypeArgs(openArgs[j], fn.ParameterTypes[j], openMethod, result);
                    }

                    if (!fnVoid)
                    {
                        UnifyForMethodTypeArgs(openArgs[openArgs.Length - 1], fn.ReturnType, openMethod, result);
                    }
                }

                return;
            }

            // Pattern B: open formal is IEnumerable<T> / IEnumerable<...> and
            // actual is a slice/array/sequence — the element type lifts as the
            // single substitution.
            if (openArgs.Length == 1)
            {
                var actualElement = TryGetElementType(actual);
                if (actualElement != null)
                {
                    UnifyForMethodTypeArgs(openArgs[0], actualElement, openMethod, result);
                    return;
                }
            }

            // Pattern C: actual is an ImportedTypeSymbol whose OpenDefinition is
            // a derived/implementing shape (e.g. List<T> formal-matched against
            // IEnumerable<TSource>). Walk the actual's interfaces/base.
            if (actual is ImportedTypeSymbol imp2 && imp2.OpenDefinition != null && !imp2.TypeArguments.IsDefaultOrEmpty)
            {
                if (TryMapThroughImplemented(imp2, openDef, out var liftedArgs))
                {
                    for (int j = 0; j < openArgs.Length && j < liftedArgs.Length; j++)
                    {
                        UnifyForMethodTypeArgs(openArgs[j], liftedArgs[j], openMethod, result);
                    }
                }
            }
        }
    }

    /// <summary>
    /// Issue #1428: normalizes a symbolic type argument recovered while unifying
    /// a method type parameter (e.g. the <c>TResult</c> of <c>Select</c>) against
    /// the actual argument shape. A <em>reference</em>-typed nullable (e.g.
    /// <c>IEnumerator[T]?</c>) keeps its nullable annotation so the projected
    /// result element (<c>IEnumerable[IEnumerator[T]?]</c> → <c>IEnumerator[T]?[]</c>)
    /// remains nullable — its CLR backing is identical to the underlying type, so
    /// emit and overload resolution are unaffected by carrying the annotation.
    /// A <em>value</em>-typed nullable (<c>int?</c> = <c>Nullable&lt;int&gt;</c>) is
    /// still stripped to its underlying type, preserving the pre-existing CLR
    /// encoding expectations for value-type projections.
    /// </summary>
    private static TypeSymbol NormalizeRecoveredNullability(TypeSymbol t)
    {
        if (t is NullableTypeSymbol nn && nn.UnderlyingType?.ClrType is { IsValueType: true })
        {
            return nn.UnderlyingType;
        }

        return t;
    }

    private static TypeSymbol MergeRecoveredTypeArgument(TypeSymbol existing, TypeSymbol incoming)
    {
        if (existing == null)
        {
            return incoming;
        }

        if (incoming == null || ReferenceEquals(existing, incoming))
        {
            return existing;
        }

        var existingNullable = existing is NullableTypeSymbol en
            && !NullableLifting.IsAnyValueTypeNullable(en);
        var incomingNullable = incoming is NullableTypeSymbol inn
            && !NullableLifting.IsAnyValueTypeNullable(inn);
        if (existingNullable || incomingNullable)
        {
            var existingUnderlying = existingNullable ? ((NullableTypeSymbol)existing).UnderlyingType : existing;
            var incomingUnderlying = incomingNullable ? ((NullableTypeSymbol)incoming).UnderlyingType : incoming;
            if (DeclarationBinder.TypeSignaturesEquivalent(existingUnderlying, incomingUnderlying))
            {
                return NullableTypeSymbol.Get(
                    MergeRecoveredTypeArgument(existingUnderlying, incomingUnderlying));
            }
        }

        if (existing is ImportedTypeSymbol existingImported
            && incoming is ImportedTypeSymbol incomingImported
            && existingImported.OpenDefinition != null
            && incomingImported.OpenDefinition != null
            && ClrTypeUtilities.AreSame(existingImported.OpenDefinition, incomingImported.OpenDefinition)
            && existingImported.TypeArguments.Length == incomingImported.TypeArguments.Length)
        {
            var merged = ImmutableArray.CreateBuilder<TypeSymbol>(existingImported.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < existingImported.TypeArguments.Length; i++)
            {
                var left = existingImported.TypeArguments[i];
                var right = incomingImported.TypeArguments[i];
                if (!DeclarationBinder.TypeSignaturesEquivalent(left, right))
                {
                    return existing;
                }

                var item = MergeRecoveredTypeArgument(left, right);
                changed |= !ReferenceEquals(item, left);
                merged.Add(item);
            }

            if (changed)
            {
                return ImportedTypeSymbol.GetConstructed(
                    existingImported.ClrType,
                    existingImported.OpenDefinition,
                    merged.MoveToImmutable());
            }
        }

        if (existing is SliceTypeSymbol existingSlice
            && incoming is SliceTypeSymbol incomingSlice
            && DeclarationBinder.TypeSignaturesEquivalent(existingSlice.ElementType, incomingSlice.ElementType))
        {
            return SliceTypeSymbol.Get(
                MergeRecoveredTypeArgument(existingSlice.ElementType, incomingSlice.ElementType));
        }

        if (existing is ArrayTypeSymbol existingArray
            && incoming is ArrayTypeSymbol incomingArray
            && existingArray.Length == incomingArray.Length
            && DeclarationBinder.TypeSignaturesEquivalent(existingArray.ElementType, incomingArray.ElementType))
        {
            return ArrayTypeSymbol.Get(
                MergeRecoveredTypeArgument(existingArray.ElementType, incomingArray.ElementType),
                existingArray.Length);
        }

        if (existing is TupleTypeSymbol existingTuple
            && incoming is TupleTypeSymbol incomingTuple
            && existingTuple.ElementTypes.Length == incomingTuple.ElementTypes.Length)
        {
            var merged = ImmutableArray.CreateBuilder<TypeSymbol>(existingTuple.ElementTypes.Length);
            for (var i = 0; i < existingTuple.ElementTypes.Length; i++)
            {
                if (!DeclarationBinder.TypeSignaturesEquivalent(
                    existingTuple.ElementTypes[i],
                    incomingTuple.ElementTypes[i]))
                {
                    return existing;
                }

                merged.Add(MergeRecoveredTypeArgument(
                    existingTuple.ElementTypes[i],
                    incomingTuple.ElementTypes[i]));
            }

            return TupleTypeSymbol.Get(merged.MoveToImmutable());
        }

        return !TypeSymbol.ContainsReferenceNullableAnnotation(existing)
            && TypeSymbol.ContainsReferenceNullableAnnotation(incoming)
            && DeclarationBinder.TypeSignaturesEquivalent(existing, incoming)
                ? incoming
                : existing;
    }

    private static TypeSymbol TryGetElementType(TypeSymbol t)
    {
        return t switch
        {
            SliceTypeSymbol s => s.ElementType,
            ArrayTypeSymbol a => a.ElementType,
            SequenceTypeSymbol seq => seq.ElementType,
            AsyncSequenceTypeSymbol aseq => aseq.ElementType,
            _ => null,
        };
    }

    private static bool TryMapThroughImplemented(ImportedTypeSymbol imp, Type targetOpenDef, out ImmutableArray<TypeSymbol> liftedArgs)
    {
        liftedArgs = default;
        if (imp.OpenDefinition == null)
        {
            return false;
        }

        // Walk the open definition's interfaces/base for an instantiation of
        // targetOpenDef, then substitute the symbolic args back through.
        foreach (var iface in EnumerateOpenInterfacesAndBases(imp.OpenDefinition))
        {
            if (!iface.IsGenericType || !ClrTypeUtilities.AreSame(iface.GetGenericTypeDefinition(), targetOpenDef))
            {
                continue;
            }

            var openArgs = iface.GetGenericArguments();
            var lifted = ImmutableArray.CreateBuilder<TypeSymbol>(openArgs.Length);
            foreach (var oa in openArgs)
            {
                lifted.Add(MapOpenClrTypeToSymbolic(oa, imp.OpenDefinition, imp.TypeArguments));
            }

            liftedArgs = lifted.MoveToImmutable();
            return true;
        }

        return false;
    }

    private static IEnumerable<Type> EnumerateOpenInterfacesAndBases(Type openDef)
    {
        yield return openDef;
        foreach (var iface in openDef.GetInterfaces())
        {
            yield return iface;
        }

        var baseType = openDef.BaseType;
        while (baseType != null && !baseType.IsSameAs(typeof(object)))
        {
            yield return baseType;
            baseType = baseType.BaseType;
        }
    }

    /// <summary>
    /// Issue #932: builds an erased CLR <c>System.Func&lt;...&gt;</c> /
    /// <c>System.Action&lt;...&gt;</c> delegate type for a
    /// <see cref="FunctionTypeSymbol"/> whose natural <c>ClrType</c> is null
    /// because one of its parameter / return types is symbolic (a
    /// same-compilation user class, enum, or open type parameter). Each
    /// component is erased through <see cref="TryEraseDelegateComponentClrType"/>
    /// so the result matches the erasure the surrounding generic call applies to
    /// its other arguments.
    /// </summary>
    /// <param name="functionType">The literal's bound function type.</param>
    /// <param name="erased">On success, the erased delegate CLR type.</param>
    /// <returns><see langword="true"/> when an erased delegate type was built.</returns>
    private static bool TryProjectErasedDelegateClrType(FunctionTypeSymbol functionType, out Type erased)
    {
        erased = null;
        if (functionType == null)
        {
            return false;
        }

        var paramClr = new Type[functionType.ParameterTypes.Length];
        for (var i = 0; i < paramClr.Length; i++)
        {
            if (!TryEraseDelegateComponentClrType(functionType.ParameterTypes[i], out paramClr[i]))
            {
                return false;
            }
        }

        var isVoid = FunctionTypeSymbol.IsVoidReturn(functionType.ReturnType);
        Type returnClr = null;
        if (!isVoid && !TryEraseDelegateComponentClrType(functionType.ReturnType, out returnClr))
        {
            return false;
        }

        erased = isVoid
            ? BuildActionClrType(paramClr)
            : BuildFuncClrType(paramClr, returnClr);
        return erased != null;
    }

    /// <summary>
    /// Issue #932: erases a single delegate parameter / return
    /// <see cref="TypeSymbol"/> to a CLR <see cref="System.Type"/>, mapping
    /// symbolic shapes the same way <see cref="ImportedClassSymbol"/>'s
    /// argument-type erasure does (user class → its imported base or
    /// <c>object</c>, enum → <c>int32</c>); non-symbolic and other erasable
    /// shapes fall back to <see cref="TryProjectErasedClrType"/>.
    /// </summary>
    /// <param name="t">The component type to erase.</param>
    /// <param name="clr">On success, the erased CLR type.</param>
    /// <returns><see langword="true"/> when an erasure exists.</returns>
    private static bool TryEraseDelegateComponentClrType(TypeSymbol t, out Type clr)
    {
        clr = null;
        if (t == null)
        {
            return false;
        }

        if (t.ClrType != null)
        {
            clr = t.ClrType;
            return true;
        }

        switch (t)
        {
            case StructSymbol { IsClass: true } userClass:
                clr = userClass.ImportedBaseType?.ClrType ?? typeof(object);
                return true;
            case EnumSymbol:
                clr = typeof(int);
                return true;
            default:
                return TryProjectErasedClrType(t, out clr);
        }
    }

    private static Type BuildActionClrType(Type[] paramClr) => paramClr.Length switch
    {
        0 => typeof(Action),
        1 => typeof(Action<>).MakeGenericType(paramClr),
        2 => typeof(Action<,>).MakeGenericType(paramClr),
        3 => typeof(Action<,,>).MakeGenericType(paramClr),
        4 => typeof(Action<,,,>).MakeGenericType(paramClr),
        5 => typeof(Action<,,,,>).MakeGenericType(paramClr),
        6 => typeof(Action<,,,,,>).MakeGenericType(paramClr),
        7 => typeof(Action<,,,,,,>).MakeGenericType(paramClr),
        8 => typeof(Action<,,,,,,,>).MakeGenericType(paramClr),
        _ => null,
    };

    private static Type BuildFuncClrType(Type[] paramClr, Type returnClr)
    {
        if (returnClr == null)
        {
            return null;
        }

        var args = new Type[paramClr.Length + 1];
        Array.Copy(paramClr, args, paramClr.Length);
        args[paramClr.Length] = returnClr;
        return paramClr.Length switch
        {
            0 => typeof(Func<>).MakeGenericType(args),
            1 => typeof(Func<,>).MakeGenericType(args),
            2 => typeof(Func<,,>).MakeGenericType(args),
            3 => typeof(Func<,,,>).MakeGenericType(args),
            4 => typeof(Func<,,,,>).MakeGenericType(args),
            5 => typeof(Func<,,,,,>).MakeGenericType(args),
            6 => typeof(Func<,,,,,,>).MakeGenericType(args),
            7 => typeof(Func<,,,,,,,>).MakeGenericType(args),
            8 => typeof(Func<,,,,,,,,>).MakeGenericType(args),
            _ => null,
        };
    }

    /// <summary>
    /// Issue #2230: compares a candidate implementer's parameter/return
    /// <see cref="TypeSymbol"/> against a CLR contract position that may
    /// reference an imported (metadata) interface METHOD's own generic
    /// parameter (e.g. the <c>TState</c> in <c>ILogger.BeginScope&lt;TState&gt;</c>
    /// / <c>ILogger.Log&lt;TState&gt;</c>), either directly or nested inside ANY
    /// constructed generic shape — a delegate (e.g.
    /// <c>Func&lt;TState, Exception, string&gt;</c>), an array (<c>TState[]</c>),
    /// or any other constructed generic type (<c>IEnumerable&lt;TState&gt;</c>,
    /// <c>IComparer&lt;TState&gt;</c>, <c>Nullable&lt;TState&gt;</c>, a custom
    /// generic, etc.), at any nesting depth (e.g.
    /// <c>IEnumerable&lt;IEnumerable&lt;TState&gt;&gt;</c>).
    /// Falls back to the existing erased-<c>ClrType</c> comparison
    /// (<see cref="HasMatchingMethodForClrSignature"/>'s prior behavior) for
    /// every other position, so ordinary non-generic contract members are
    /// unaffected.
    /// </summary>
    /// <param name="candidate">The implementer's parameter or return type.</param>
    /// <param name="openType">The corresponding CLR contract type (from the open generic method definition).</param>
    /// <param name="methodGenericParams">The interface method's own generic-parameter <see cref="Type"/>s, positionally.</param>
    /// <param name="candidateTypeParams">The implementer method's own type parameters, positionally.</param>
    /// <returns><see langword="true"/> when the positions match.</returns>
    private static bool ClrParamTypeMatchesGenericMethodParam(
        TypeSymbol candidate,
        Type openType,
        Type[] methodGenericParams,
        ImmutableArray<TypeParameterSymbol> candidateTypeParams)
    {
        if (candidate == null || openType == null)
        {
            return false;
        }

        // Direct method-type-parameter position (e.g. `TState state`):
        // match by position against the implementer's own method type
        // parameter — an unbound G# type parameter has no ClrType, so the
        // erased comparison below can never succeed for it.
        if (openType.IsGenericMethodParameter)
        {
            var position = Array.IndexOf(methodGenericParams, openType);
            return position >= 0
                && position < candidateTypeParams.Length
                && ReferenceEquals(candidate, candidateTypeParams[position]);
        }

        // Fast path: no method type parameter involved at or below this
        // position — the pre-existing erased-ClrType comparison works
        // (covers the overwhelming majority of contract positions,
        // including non-generic methods entirely).
        var effectiveClr = NullableLifting.GetEffectiveClrType(candidate);
        if (effectiveClr != null && ClrTypeUtilities.AreSame(effectiveClr, openType))
        {
            return true;
        }

        // Slow path: a constructed generic contract position nests the
        // method's own type parameter (e.g. `Func<TState, Exception, string>`
        // in `Log<TState>(..., Func<TState, Exception, string> formatter)`),
        // which erases to a null ClrType (FunctionTypeSymbol.BuildClrType
        // bails when any parameter has no ClrType). Recurse structurally
        // through the delegate's `Invoke` shape instead.
        if (candidate is FunctionTypeSymbol fn && openType.IsConstructedGenericType)
        {
            var invoke = openType.GetMethodSafe("Invoke");
            if (invoke == null)
            {
                return false;
            }

            var invokeParams = invoke.GetParameters();
            if (invokeParams.Length != fn.ParameterTypes.Length)
            {
                return false;
            }

            for (var i = 0; i < invokeParams.Length; i++)
            {
                if (!ClrParamTypeMatchesGenericMethodParam(fn.ParameterTypes[i], invokeParams[i].ParameterType, methodGenericParams, candidateTypeParams))
                {
                    return false;
                }
            }

            if (invoke.ReturnType.IsSameAs(typeof(void)))
            {
                return FunctionTypeSymbol.IsVoidReturn(fn.ReturnType);
            }

            return ClrParamTypeMatchesGenericMethodParam(fn.ReturnType, invoke.ReturnType, methodGenericParams, candidateTypeParams);
        }

        // Slow path: an array contract position nests the method's own type
        // parameter (e.g. `TState[]` in `CopyTo<TState>(TState[] items)`).
        // C#/CLR arrays aren't "generic types" in the reflection sense
        // (`IsConstructedGenericType` is false), so they need their own
        // element-wise recursion against the G# array-of-T shapes.
        if (openType.IsArray)
        {
            var openElementType = openType.GetElementType();
            var candidateElementType = candidate switch
            {
                ArrayTypeSymbol arr => arr.ElementType,
                SliceTypeSymbol slice => slice.ElementType,
                _ => null,
            };

            return candidateElementType != null
                && ClrParamTypeMatchesGenericMethodParam(candidateElementType, openElementType, methodGenericParams, candidateTypeParams);
        }

        // Slow path: any other constructed generic contract position nests
        // the method's own type parameter (e.g. `IEnumerable<TState>`,
        // `IComparer<TState>`, `Nullable<TState>`, or a custom imported/
        // source generic, at any nesting depth). Recurse positionally
        // through the CLR open type's generic arguments against the G#
        // symbol's own symbolic type arguments — the same pattern as the
        // delegate-Invoke-shape branch above, generalized to any generic
        // type rather than just delegates.
        if (openType.IsConstructedGenericType
            && candidate is ImportedTypeSymbol named
            && named.OpenDefinition != null
            && !named.TypeArguments.IsDefaultOrEmpty
            && ClrTypeUtilities.AreSame(openType.GetGenericTypeDefinition(), named.OpenDefinition))
        {
            var openArgs = openType.GetGenericArguments();
            if (openArgs.Length != named.TypeArguments.Length)
            {
                return false;
            }

            for (var i = 0; i < openArgs.Length; i++)
            {
                if (!ClrParamTypeMatchesGenericMethodParam(named.TypeArguments[i], openArgs[i], methodGenericParams, candidateTypeParams))
                {
                    return false;
                }
            }

            return true;
        }

        return false;
    }

    /// <summary>
    /// Returns the value type of a <c>Current</c> member resolved by
    /// <see cref="TryResolveClrPatternAsyncEnumerator"/> — a property or a
    /// field.
    /// </summary>
    /// <param name="member">The member to inspect.</param>
    /// <returns>The member's value type.</returns>
    private static Type GetClrMemberValueType(MemberInfo member)
    {
        return member switch
        {
            PropertyInfo property => property.PropertyType,
            FieldInfo field => field.FieldType,
            _ => null,
        };
    }

    /// <summary>
    /// Issue #985: a single CLR interface method slot that an implementing type
    /// must satisfy, paired with the symbolic type arguments needed to resolve
    /// any generic-parameter positions in its signature. <see cref="IsInherited"/>
    /// is <see langword="true"/> when the slot comes from a base interface that
    /// the declared interface inherits (e.g. the non-generic
    /// <c>IEnumerable.GetEnumerator()</c> reached through
    /// <c>IEnumerable&lt;T&gt;</c>).
    /// </summary>
    public readonly struct ClrInterfaceSlot
    {
        public ClrInterfaceSlot(MethodInfo method, ImmutableArray<TypeSymbol> symbolicArgs, bool isInherited)
        {
            this.Method = method;
            this.SymbolicArgs = symbolicArgs;
            this.IsInherited = isInherited;
        }

        public MethodInfo Method { get; }

        public ImmutableArray<TypeSymbol> SymbolicArgs { get; }

        public bool IsInherited { get; }
    }

    internal readonly struct ImportedMethodProbe
    {
        public ImportedMethodProbe(IReadOnlyList<MethodInfo> methods, int receiverParameterOffset)
        {
            this.Methods = methods;
            this.ReceiverParameterOffset = receiverParameterOffset;
        }

        public IReadOnlyList<MethodInfo> Methods { get; }

        public int ReceiverParameterOffset { get; }
    }
}
