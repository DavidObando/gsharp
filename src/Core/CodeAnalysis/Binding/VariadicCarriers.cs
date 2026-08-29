// <copyright file="VariadicCarriers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0173 / issue #3627: generalized variadic carriers. A variadic
/// parameter <c>name ...X</c> now mirrors C#13 params collections: when the
/// type written after <c>...</c> is itself a supported COLLECTION shape, it
/// is the parameter's CARRIER type (the exact type the callee receives and
/// the CLR signature declares) and its single type argument is the element
/// type — <c>...List[int32]</c> ≡ C# <c>params List&lt;int&gt;</c>,
/// <c>...ReadOnlySpan[int32]</c> ≡ <c>params ReadOnlySpan&lt;int&gt;</c>,
/// <c>...[]T</c> ≡ <c>params T[]</c>. Any other type keeps the ADR-0101
/// meaning: it is the ELEMENT type and the implicit carrier is the slice
/// (<c>...int32</c> ≡ <c>params int[]</c>).
/// </summary>
/// <remarks>
/// Supported non-array carriers (exactly the shapes cs2gs's call-site
/// lowering has historically allowlisted, plus the two span types):
/// <c>List&lt;T&gt;</c>, <c>IEnumerable&lt;T&gt;</c>, <c>ICollection&lt;T&gt;</c>,
/// <c>IList&lt;T&gt;</c>, <c>IReadOnlyCollection&lt;T&gt;</c>,
/// <c>IReadOnlyList&lt;T&gt;</c>, <c>Span&lt;T&gt;</c>,
/// <c>ReadOnlySpan&lt;T&gt;</c>. The array family emits
/// <c>[ParamArrayAttribute]</c> as before; every other carrier emits C#13's
/// <c>[ParamCollectionAttribute]</c>.
/// </remarks>
internal static class VariadicCarriers
{
    private static readonly ImmutableHashSet<string> InterfaceCarrierNames = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        "System.Collections.Generic.IEnumerable`1",
        "System.Collections.Generic.ICollection`1",
        "System.Collections.Generic.IList`1",
        "System.Collections.Generic.IReadOnlyCollection`1",
        "System.Collections.Generic.IReadOnlyList`1");

    /// <summary>The carrier family a variadic parameter packs into.</summary>
    internal enum CarrierKind
    {
        /// <summary>Slice/array carrier — the classic <c>params T[]</c> shape.</summary>
        Array,

        /// <summary><c>List&lt;T&gt;</c> — packed via <c>new List&lt;T&gt;(T[])</c>.</summary>
        List,

        /// <summary>One of the five <c>IEnumerable</c>-family interfaces — packed as an array upcast.</summary>
        Interface,

        /// <summary><c>Span&lt;T&gt;</c> / <c>ReadOnlySpan&lt;T&gt;</c> — packed via the span's <c>T[]</c> constructor.</summary>
        Span,
    }

    /// <summary>
    /// Resolves the declared parameter type for a variadic parameter whose
    /// <c>...</c>-suffixed type clause bound to <paramref name="boundType"/>:
    /// the type itself when it is a supported carrier, else the ADR-0101
    /// slice wrap around it (element interpretation).
    /// </summary>
    /// <param name="boundType">The bound type written after <c>...</c>.</param>
    /// <returns>The parameter's declared (carrier) type.</returns>
    internal static TypeSymbol ResolveDeclaredParameterType(TypeSymbol boundType)
        => IsCarrierType(boundType) ? boundType : SliceTypeSymbol.Get(boundType);

    /// <summary>
    /// Returns whether <paramref name="type"/> is a supported variadic
    /// carrier shape (array family or an allowlisted single-argument
    /// collection).
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns><see langword="true"/> for carrier shapes.</returns>
    internal static bool IsCarrierType(TypeSymbol type)
        => type is SliceTypeSymbol or ArrayTypeSymbol
            || TryClassifyCollectionCarrier(type, out _);

    /// <summary>
    /// Gets the carrier kind for a variadic parameter's declared type.
    /// A non-carrier type (only possible for error recovery) reports Array.
    /// </summary>
    /// <param name="carrierType">The variadic parameter's declared type.</param>
    /// <returns>The carrier kind.</returns>
    internal static CarrierKind GetCarrierKind(TypeSymbol carrierType)
    {
        if (carrierType is SliceTypeSymbol or ArrayTypeSymbol)
        {
            return CarrierKind.Array;
        }

        return TryClassifyCollectionCarrier(carrierType, out var kind) ? kind : CarrierKind.Array;
    }

    /// <summary>
    /// Extracts the variadic ELEMENT type from a carrier type: the
    /// slice/array element, or the collection's single type argument.
    /// </summary>
    /// <param name="carrierType">The variadic parameter's declared type.</param>
    /// <returns>The element type; <see cref="TypeSymbol.Error"/> when the shape is unrecognized.</returns>
    internal static TypeSymbol GetElementType(TypeSymbol carrierType) => carrierType switch
    {
        SliceTypeSymbol slice => slice.ElementType,
        ArrayTypeSymbol array => array.ElementType,
        ImportedTypeSymbol { TypeArguments: [var symbolicElement] } => symbolicElement,
        _ when carrierType.ClrType is { IsGenericType: true, IsGenericTypeDefinition: false } clr
            => TypeSymbol.FromClrType(clr.GetGenericArguments()[0]),
        _ => TypeSymbol.Error,
    };

    /// <summary>
    /// Wraps a freshly packed element array in the carrier's construction
    /// form: the array itself for the array family, an implicit upcast for
    /// interface carriers, <c>new List&lt;T&gt;(T[])</c> for the list
    /// carrier, and the span's <c>T[]</c> constructor for span carriers.
    /// </summary>
    /// <param name="conversions">The conversion classifier, used to bind the interface upcast.</param>
    /// <param name="diagnostics">Receives a diagnostic when a collection carrier over a same-compilation (erased) element cannot be constructed.</param>
    /// <param name="callSyntax">The originating call syntax for diagnostics.</param>
    /// <param name="carrierType">The variadic parameter's declared type.</param>
    /// <param name="packedArray">The packed <see cref="BoundArrayCreationExpression"/> of the element type.</param>
    /// <returns>The carrier-typed bound expression.</returns>
    internal static BoundExpression WrapPackedArray(
        ConversionClassifier conversions,
        DiagnosticBag diagnostics,
        SyntaxNode callSyntax,
        TypeSymbol carrierType,
        BoundExpression packedArray)
    {
        switch (GetCarrierKind(carrierType))
        {
            case CarrierKind.Array:
                return packedArray;

            case CarrierKind.Interface:
                // Arrays implement all five IEnumerable-family interfaces;
                // the slice→interface implicit conversion already exists.
                return conversions.BindConversion(callSyntax?.Location ?? default, packedArray, carrierType);

            case CarrierKind.List:
                return WrapViaCarrierConstructor(
                    diagnostics,
                    callSyntax,
                    carrierType,
                    packedArray,
                    static (clr, elementClr) => clr.GetConstructor(new[] { ResolveEnumerableOf(clr, elementClr) }));

            case CarrierKind.Span:
                return WrapViaCarrierConstructor(
                    diagnostics,
                    callSyntax,
                    carrierType,
                    packedArray,
                    static (clr, elementClr) => clr.GetConstructor(new[] { elementClr.MakeArrayType() }));

            default:
                return packedArray;
        }
    }

    private static Type ResolveEnumerableOf(Type carrierClr, Type elementClr)
    {
        // Resolve IEnumerable<elem> in the SAME load context as the carrier
        // (MetadataLoadContext types cannot mix with runtime typeofs).
        foreach (var iface in carrierClr.GetInterfaces())
        {
            if (iface.IsGenericType
                && iface.GetGenericTypeDefinition().FullName == "System.Collections.Generic.IEnumerable`1"
                && iface.GetGenericArguments()[0] == elementClr)
            {
                return iface;
            }
        }

        return elementClr.MakeArrayType();
    }

    private static Type? ResolveElementInCarrierContext(Type carrierClr, Type? elementClr)
    {
        // The carrier's own generic argument is the element type ALREADY in
        // the carrier's load context — under the SDK compile path the carrier
        // comes from a MetadataLoadContext, and passing a runtime typeof into
        // its GetConstructor throws ArgumentException ("Type must be a type
        // provided by the MetadataLoadContext").
        if (carrierClr.IsGenericType && !carrierClr.IsGenericTypeDefinition)
        {
            var arguments = carrierClr.GetGenericArguments();
            if (arguments.Length == 1)
            {
                return arguments[0];
            }
        }

        return elementClr;
    }

    private static BoundExpression WrapViaCarrierConstructor(
        DiagnosticBag diagnostics,
        SyntaxNode callSyntax,
        TypeSymbol carrierType,
        BoundExpression packedArray,
        Func<Type, Type, ConstructorInfo?> selectConstructor)
    {
        var carrierClr = carrierType.ClrType;
        var elementType = GetElementType(carrierType);
        var elementClr = carrierClr == null
            ? null
            : ResolveElementInCarrierContext(carrierClr, NullableTypeSymbol.GetEffectiveClrType(elementType));
        if (carrierClr == null
            || elementClr == null
            || TypeSymbol.RequiresSymbolicProjection(elementType))
        {
            // A collection carrier over a same-compilation (erased) element
            // has no closed CLR construction shape yet; the array family
            // still covers that case.
            diagnostics.ReportVariadicCarrierElementNotConstructible(
                callSyntax?.Location ?? default,
                carrierType,
                elementType);
            return packedArray;
        }

        ConstructorInfo? constructor;
        try
        {
            constructor = selectConstructor(carrierClr, elementClr);
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
            constructor = null;
        }

        if (constructor == null)
        {
            diagnostics.ReportVariadicCarrierElementNotConstructible(
                callSyntax?.Location ?? default,
                carrierType,
                elementType);
            return packedArray;
        }

        return new BoundClrConstructorCallExpression(
            callSyntax,
            carrierClr,
            constructor,
            ImmutableArray.Create(packedArray),
            carrierType);
    }

    private static bool TryClassifyCollectionCarrier(TypeSymbol type, out CarrierKind kind)
    {
        kind = CarrierKind.Array;
        var openName = GetOpenDefinitionFullName(type);
        if (openName == null)
        {
            return false;
        }

        if (openName == "System.Collections.Generic.List`1")
        {
            kind = CarrierKind.List;
            return true;
        }

        if (InterfaceCarrierNames.Contains(openName))
        {
            kind = CarrierKind.Interface;
            return true;
        }

        if (openName is "System.Span`1" or "System.ReadOnlySpan`1")
        {
            kind = CarrierKind.Span;
            return true;
        }

        return false;
    }

    private static string? GetOpenDefinitionFullName(TypeSymbol type)
    {
        if (type is ImportedTypeSymbol { OpenDefinition: { } openDefinition })
        {
            return openDefinition.FullName;
        }

        if (type.ClrType is { IsGenericType: true, IsGenericTypeDefinition: false } clr)
        {
            try
            {
                return clr.GetGenericTypeDefinition().FullName;
            }
            catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
            {
                return null;
            }
        }

        return null;
    }
}
