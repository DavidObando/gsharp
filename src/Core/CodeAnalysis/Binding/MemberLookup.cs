// <copyright file="MemberLookup.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
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
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<(Type ClrType, string Name), IReadOnlyList<MethodInfo>> MethodsIncludingSelfAndInterfacesCache = new();

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
        return MethodsIncludingSelfAndInterfacesCache.GetOrAdd((clrType, name), key =>
        {
            var (t, n) = key;
            var selfMethods = ClrTypeUtilities.SafeGetMethods(t, BindingFlags.Public | BindingFlags.Instance);
            var result = new List<MethodInfo>();
            foreach (var m in selfMethods)
            {
                if (string.Equals(m.Name, n, StringComparison.Ordinal))
                {
                    result.Add(m);
                }
            }

            // Walk transitive interfaces for DIMs not surfaced by the concrete type.
            foreach (var iface in ClrTypeUtilities.SafeGetInterfaces(t))
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
    /// <c>IAsyncEnumerable&lt;T&gt;</c> implementation and returns its
    /// element type when present.
    /// </summary>
    /// <param name="type">The <see cref="TypeSymbol"/> to probe.</param>
    /// <param name="elementType">The bound element type symbol, on success.</param>
    /// <returns><see langword="true"/> when the type implements
    /// <c>IAsyncEnumerable&lt;T&gt;</c>.</returns>
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
            var declaring = openClr.DeclaringType;
            if (declaring != null && openDefinition != null && !typeArguments.IsDefaultOrEmpty)
            {
                var declaringDef = declaring.IsGenericTypeDefinition ? declaring : (declaring.IsGenericType ? declaring.GetGenericTypeDefinition() : declaring);
                if (declaringDef == openDefinition)
                {
                    var pos = openClr.GenericParameterPosition;
                    if ((uint)pos < (uint)typeArguments.Length)
                    {
                        return typeArguments[pos];
                    }
                }
            }

            // Issue #833: method-level parameter (declared on a generic method).
            // The CLR reports DeclaringMethod != null and DeclaringType == null
            // for these; substitute via the parallel method-type-args slot.
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
            if (TypeSymbol.ContainsTypeParameter(mappedElement)
                || TypeSymbol.ContainsSameCompilationUserType(mappedElement))
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
            if (TypeSymbol.ContainsTypeParameter(mappedPointee)
                || TypeSymbol.ContainsSameCompilationUserType(mappedPointee))
            {
                return ByRefTypeSymbol.Get(mappedPointee);
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
                if (TypeSymbol.ContainsTypeParameter(mapped)
                    || TypeSymbol.ContainsSameCompilationUserType(mapped))
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
        var openReturn = openMethod.ReturnType;
        if (openReturn == null || openReturn.IsSameAs(typeof(void)))
        {
            return null;
        }

        Type receiverOpenDef = null;
        ImmutableArray<TypeSymbol> receiverTypeArgs = default;
        if (receiverType is ImportedTypeSymbol imp && imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty)
        {
            receiverOpenDef = imp.OpenDefinition;
            receiverTypeArgs = imp.TypeArguments;
        }

        var mapped = MapOpenClrTypeToSymbolic(openReturn, receiverOpenDef, receiverTypeArgs, openMethod, symbolicMethodTypeArgs);

        // Issue #833 surfaces the override when the projection still contains an
        // in-scope type parameter. Issue #903 extends this to same-compilation
        // user element types: when the receiver is e.g. `List[Check]` and
        // `Check` is a struct/class still being compiled, the closed CLR method
        // erased `TSource` to `object`, so a generic return like `Single() →
        // TSource` would otherwise surface as `object` and lose the `Check`
        // identity (breaking `net.Id`). The symbolic projection recovers it.
        return TypeSymbol.ContainsTypeParameter(mapped) || TypeSymbol.ContainsSameCompilationUserType(mapped)
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
            if (inferred[i] != null
                && (TypeSymbol.ContainsTypeParameter(inferred[i]) || TypeSymbol.ContainsSameCompilationUserType(inferred[i])))
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
                return TryProjectErasedClrType(nullable.UnderlyingType, out erased);
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
            default:
                return type.ClrType != null && TryGetDelegateFunctionType(type.ClrType, out functionType);
        }
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
        foreach (var candidate in structSymbol.GetMethodsIncludingInherited(clrMethod.Name))
        {
            var callable = GetCallableParameters(candidate);
            if (callable.Length != clrParams.Length)
            {
                continue;
            }

            // Issue #1071: an `async func` implementing a CLR interface method
            // declared with an explicit `Task` / `Task[T]` return type has a
            // declared (awaited) return of void / T. Compare the contract's
            // unwrapped awaited result against the candidate's declared type.
            var candidateReturnClr = NullableLifting.GetEffectiveClrType(candidate.Type);
            if (candidate.IsAsync
                && AsyncReturnTypeNormalizer.TryUnwrapTaskClrType(clrMethod.ReturnType, out var awaitedReturnClr))
            {
                if (!ClrTypeUtilities.AreSame(candidateReturnClr, awaitedReturnClr))
                {
                    continue;
                }
            }
            else if (!ClrTypeUtilities.AreSame(candidateReturnClr, clrMethod.ReturnType))
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
                    if (!ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(gsParam.Type), elementType))
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

                    if (!ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(gsParam.Type), clrParamType))
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
    /// <param name="clrTarget">The CLR receiver type whose indexers to probe.</param>
    /// <param name="boundArguments">The pre-bound index argument expressions.</param>
    /// <param name="indexer">The matching <see cref="PropertyInfo"/>, on success.</param>
    /// <returns><see langword="true"/> when a matching indexer is found.</returns>
    public bool TryResolveClrIndexer(Type clrTarget, ImmutableArray<BoundExpression> boundArguments, out PropertyInfo indexer)
    {
        indexer = null;

        foreach (var prop in ClrTypeUtilities.SafeGetProperties(clrTarget, BindingFlags.Public | BindingFlags.Instance))
        {
            var ps = prop.GetIndexParameters();
            if (ps.Length != boundArguments.Length)
            {
                continue;
            }

            var ok = true;
            for (var i = 0; i < ps.Length; i++)
            {
                var argClr = boundArguments[i].Type?.ClrType;
                if (argClr == null || !ClrTypeUtilities.IsAssignableByName(ps[i].ParameterType, argClr))
                {
                    ok = false;
                    break;
                }
            }

            if (ok)
            {
                indexer = prop;
                return true;
            }
        }

        return false;
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
                methods = type.GetMethods(BindingFlags.Public | BindingFlags.Static);
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

                if (!HasExtensionAttribute(method))
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
        if (this.binderCtx.CachedImportedExtensionClasses != null && this.binderCtx.CachedImportedExtensionImportCount == importCount)
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

                    if (!IsStaticClass(type) || !HasExtensionAttribute(type))
                    {
                        continue;
                    }

                    classes.Add(type);
                }
            }
        }

        this.binderCtx.CachedImportedExtensionClasses = classes;
        this.binderCtx.CachedImportedExtensionImportCount = importCount;
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
    /// Removes every entry from the <see cref="MethodsIncludingSelfAndInterfacesCache"/>.
    /// Called by <see cref="ReferenceResolver.Dispose"/> (#1678, mirroring #1622)
    /// alongside <see cref="ClrTypeUtilities.ClearCache"/>.
    /// </summary>
    internal static void ClearCache() => MethodsIncludingSelfAndInterfacesCache.Clear();

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
            case ImportedTypeSymbol imp when imp.OpenDefinition != null && !imp.TypeArguments.IsDefaultOrEmpty:
                return TryBuildErasedClosedGeneric(
                    imp.OpenDefinition,
                    imp.OpenDefinition.GetGenericArguments(),
                    imp.TypeArguments,
                    contextObject);
            default:
                // Concrete leaf (e.g. a fully-closed imported type): erase to the
                // context placeholder so the shape stays in a single load context
                // and mirrors how the same leaf is erased on the selector side.
                return contextObject;
        }
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

    private static void UnifyForMethodTypeArgs(Type openClr, TypeSymbol actual, MethodInfo openMethod, TypeSymbol[] result)
    {
        if (openClr == null || actual == null)
        {
            return;
        }

        // Open MVar(i) → record the actual symbolic shape (first wins).
        if (openClr.IsGenericParameter && openClr.DeclaringMethod != null)
        {
            if (ReferenceEquals(openClr.DeclaringMethod, openMethod)
                || openClr.DeclaringMethod.MetadataToken == openMethod.MetadataToken)
            {
                var pos = openClr.GenericParameterPosition;
                if ((uint)pos < (uint)result.Length && result[pos] == null)
                {
                    result[pos] = NormalizeRecoveredNullability(actual);
                }
            }

            return;
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

            // Pattern A: actual is an ImportedTypeSymbol whose OpenDefinition matches exactly.
            if (actual is ImportedTypeSymbol imp
                && imp.OpenDefinition != null
                && imp.OpenDefinition == openDef
                && !imp.TypeArguments.IsDefaultOrEmpty
                && imp.TypeArguments.Length == openArgs.Length)
            {
                for (int j = 0; j < openArgs.Length; j++)
                {
                    UnifyForMethodTypeArgs(openArgs[j], imp.TypeArguments[j], openMethod, result);
                }

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
            if (!iface.IsGenericType || iface.GetGenericTypeDefinition() != targetOpenDef)
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
}
