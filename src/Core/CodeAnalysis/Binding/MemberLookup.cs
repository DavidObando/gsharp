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

        var selfMethods = ClrTypeUtilities.SafeGetMethods(clrType, BindingFlags.Public | BindingFlags.Instance);
        var result = new List<MethodInfo>();
        foreach (var m in selfMethods)
        {
            if (string.Equals(m.Name, name, StringComparison.Ordinal))
            {
                result.Add(m);
            }
        }

        // Walk transitive interfaces for DIMs not surfaced by the concrete type.
        foreach (var iface in ClrTypeUtilities.SafeGetInterfaces(clrType))
        {
            foreach (var m in ClrTypeUtilities.SafeGetMethods(iface, BindingFlags.Public | BindingFlags.Instance))
            {
                if (!string.Equals(m.Name, name, StringComparison.Ordinal))
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
    /// Probes <paramref name="clrType"/> for an
    /// <c>IDictionary&lt;TKey, TValue&gt;</c> implementation and returns the
    /// key/value type arguments when present.
    /// </summary>
    /// <param name="clrType">The CLR type to probe.</param>
    /// <param name="keyType">The dictionary's key type, on success.</param>
    /// <param name="valueType">The dictionary's value type, on success.</param>
    /// <returns><see langword="true"/> when the type implements
    /// <c>IDictionary&lt;,&gt;</c>.</returns>
    public static bool TryGetClrDictionaryTypes(Type clrType, out Type keyType, out Type valueType)
    {
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
            if (TypeSymbol.ContainsTypeParameter(mappedElement))
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
            if (TypeSymbol.ContainsTypeParameter(mappedPointee))
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
            var openParams = openDef.GetGenericArguments();
            var erasedArgs = new Type[openParams.Length];
            for (int i = 0; i < openParams.Length; i++)
            {
                erasedArgs[i] = typeof(object);
            }

            Type erasedClosed;
            try
            {
                erasedClosed = openDef.MakeGenericType(erasedArgs);
            }
            catch
            {
                // Fallback: if the type-erased construction violates a
                // declared constraint (e.g. a `where T : struct` parameter
                // that rejects `object`), fall back to the original open
                // shape — downstream emit still encodes correctly via the
                // OpenDefinition + TypeArguments.
                erasedClosed = openClr;
            }

            return ImportedTypeSymbol.GetConstructed(erasedClosed, openDef, symbolic.MoveToImmutable());
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
            case NullableTypeSymbol nullable when nullable.UnderlyingType != null:
                return TryProjectErasedClrType(nullable.UnderlyingType, out erased);
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
        if (type.TryGetMethodIncludingInherited("GetEnumerator", out var getEnumerator) &&
            getEnumerator.Parameters.Length == 0 &&
            getEnumerator.Type is StructSymbol enumeratorType &&
            enumeratorType.TryGetMethodIncludingInherited("MoveNext", out var moveNext) &&
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

        var invoke = delegateType.GetMethod("Invoke");
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

            if (!ClrTypeUtilities.AreSame(NullableLifting.GetEffectiveClrType(candidate.Type), clrMethod.ReturnType))
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

    /// <summary>
    /// Walks <paramref name="type"/> and its base-class chain looking for a
    /// user-declared property with the given <paramref name="name"/>.
    /// </summary>
    /// <param name="type">The starting user struct symbol.</param>
    /// <param name="name">The property name to find.</param>
    /// <param name="property">The matching property symbol, on success.</param>
    /// <returns><see langword="true"/> when a property is found.</returns>
    public static bool TryGetPropertyIncludingInherited(StructSymbol type, string name, out PropertySymbol property)
    {
        var current = type;
        while (current != null)
        {
            foreach (var p in current.Properties)
            {
                if (p.Name == name)
                {
                    property = p;
                    return true;
                }
            }

            current = current.BaseClass;
        }

        property = null;
        return false;
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
                    result[pos] = StripNullability(actual);
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

    private static TypeSymbol StripNullability(TypeSymbol t)
    {
        if (t is NullableTypeSymbol nn && nn.UnderlyingType != null)
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
}
