// <copyright file="VariadicCarriers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Reflection

/// ADR-0173 / issue #3627: generalized variadic carriers. A variadic
/// parameter `name ...X` now mirrors C#13 params collections: when the
/// type written after `...` is itself a supported COLLECTION shape, it
/// is the parameter's CARRIER type (the exact type the callee receives and
/// the CLR signature declares) and its single type argument is the element
/// type — `...List[int32]` ≡ C# `params List<int>`,
/// `...ReadOnlySpan[int32]` ≡ `params ReadOnlySpan<int>`,
/// `...[]T` ≡ `params T[]`. Any other type keeps the ADR-0101
/// meaning: it is the ELEMENT type and the implicit carrier is the slice
/// (`...int32` ≡ `params int[]`).
/// @remarks Supported non-array carriers (exactly the shapes cs2gs's call-site
/// lowering has historically allowlisted, plus the two span types):
/// `List<T>`, `IEnumerable<T>`, `ICollection<T>`,
/// `IList<T>`, `IReadOnlyCollection<T>`,
/// `IReadOnlyList<T>`, `Span<T>`,
/// `ReadOnlySpan<T>`. The array family emits
/// `[ParamArrayAttribute]` as before; every other carrier emits C#13's
/// `[ParamCollectionAttribute]`.
internal shared class VariadicCarriers {
    /// The carrier family a variadic parameter packs into.
    internal enum CarrierKind {
        Array,
        List,
        Interface,
        Span
    }

    private let InterfaceCarrierNames ImmutableHashSet[string] = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        "System.Collections.Generic.IEnumerable`1",
        "System.Collections.Generic.ICollection`1",
        "System.Collections.Generic.IList`1",
        "System.Collections.Generic.IReadOnlyCollection`1",
        "System.Collections.Generic.IReadOnlyList`1"
    )

    /// Resolves the declared parameter type for a variadic parameter whose
    /// `...`-suffixed type clause bound to [`boundType`](paramref):
    /// the type itself when it is a supported carrier, else the ADR-0101
    /// slice wrap around it (element interpretation).
    /// @param boundType The bound type written after `...`.
    /// @returns The parameter's declared (carrier) type.
    internal func ResolveDeclaredParameterType(boundType TypeSymbol) TypeSymbol -> if IsCarrierType(boundType) {
        boundType
    } else {
        cast[TypeSymbol](SliceTypeSymbol.Get(boundType))
    }

    /// Returns whether [`type`](paramref) is a supported variadic
    /// carrier shape (array family or an allowlisted single-argument
    /// collection).
    /// @param type The candidate type.
    /// @returns `true` for carrier shapes.
    internal func IsCarrierType(type TypeSymbol) bool -> type is SliceTypeSymbol ||
        type is ArrayTypeSymbol ||
        TryClassifyCollectionCarrier(type, out _)

    /// Gets the carrier kind for a variadic parameter's declared type.
    /// A non-carrier type (only possible for error recovery) reports Array.
    /// @param carrierType The variadic parameter's declared type.
    /// @returns The carrier kind.
    internal func GetCarrierKind(carrierType TypeSymbol) CarrierKind {
        if carrierType is SliceTypeSymbol || carrierType is ArrayTypeSymbol {
            return CarrierKind.Array
        }
        return if TryClassifyCollectionCarrier(carrierType, out var kind) {
            kind
        } else {
            CarrierKind.Array
        }
    }

    /// Extracts the variadic ELEMENT type from a carrier type: the
    /// slice/array element, or the collection's single type argument.
    /// @param carrierType The variadic parameter's declared type.
    /// @returns The element type; (cref:TypeSymbol.Error) when the shape is unrecognized.
    internal func GetElementType(carrierType TypeSymbol) TypeSymbol -> (
        switch carrierType {
            case slice is SliceTypeSymbol: slice.ElementType
            case array is ArrayTypeSymbol: array.ElementType
            case ImportedTypeSymbol{TypeArguments: [var symbolicElement]}: symbolicElement
            case NullabilityAnnotatedTypeSymbol{
                ClrType: {IsArray: true} annotatedArray
            } annotatedCarrier: annotatedCarrier.GetTypeArgumentSymbolForClrType(annotatedArray.GetElementType())
            case NullabilityAnnotatedTypeSymbol{
                ClrType: {IsGenericType: true, IsGenericTypeDefinition: false}
            } annotatedGeneric: annotatedGeneric.GetTypeArgumentSymbol(0)
            case _ when carrierType.ClrType is {
                IsGenericType: true,
                IsGenericTypeDefinition: false
            } clr: TypeSymbol.FromClrTypeWithoutNullability(
                clr.GetGenericArguments()[0],
                NullabilityFreeReason.TypeStructure
            )
            default: TypeSymbol.Error
        }
    )

    /// Wraps a freshly packed element array in the carrier's construction
    /// form: the array itself for the array family, an implicit upcast for
    /// interface carriers, `new List<T>(T[])` for the list
    /// carrier, and the span's `T[]` constructor for span carriers.
    /// @param conversions The conversion classifier, used to bind the interface upcast.
    /// @param diagnostics Receives a diagnostic when a collection carrier over a same-compilation (erased)
    /// element cannot be constructed.
    /// @param callSyntax The originating call syntax for diagnostics.
    /// @param carrierType The variadic parameter's declared type.
    /// @param packedArray The packed (cref:BoundArrayCreationExpression) of the element type.
    /// @returns The carrier-typed bound expression.
    internal func WrapPackedArray(
        conversions ConversionClassifier,
        diagnostics DiagnosticBag,
        callSyntax SyntaxNode,
        carrierType TypeSymbol,
        packedArray BoundExpression
    ) BoundExpression {
        switch GetCarrierKind(carrierType) {
            case CarrierKind.Array {
                return packedArray
            }
            case CarrierKind.Interface {
                // Arrays implement all five IEnumerable-family interfaces;
                // the slice→interface implicit conversion already exists.
                return conversions.BindConversion(
                    callSyntax?.Location ?? default(TextLocation),
                    packedArray,
                    carrierType
                )
            }
            case CarrierKind.List {
                return WrapViaCarrierConstructor(
                    diagnostics,
                    callSyntax,
                    carrierType,
                    packedArray,
                    (clr Type, elementClr Type) -> clr.GetConstructor([]Type{ResolveEnumerableOf(clr, elementClr)})
                )
            }
            case CarrierKind.Span {
                return WrapViaCarrierConstructor(
                    diagnostics,
                    callSyntax,
                    carrierType,
                    packedArray,
                    (clr Type, elementClr Type) -> clr.GetConstructor([]Type{elementClr.MakeArrayType()})
                )
            }
            default {
                return packedArray
            }
        }
    }

    private func ResolveEnumerableOf(carrierClr Type, elementClr Type) Type {
        // Resolve IEnumerable<elem> in the SAME load context as the carrier
        // (MetadataLoadContext types cannot mix with runtime typeofs).
        for iface in carrierClr.GetInterfaces() {
            if iface.IsGenericType && iface.GetGenericTypeDefinition()
                .FullName == "System.Collections.Generic.IEnumerable`1" &&
                iface.GetGenericArguments()[0] == elementClr {
                return iface
            }
        }
        return elementClr.MakeArrayType()
    }

    private func ResolveElementInCarrierContext(carrierClr Type, elementClr Type?) Type? {
        // The carrier's own generic argument is the element type ALREADY in
        // the carrier's load context — under the SDK compile path the carrier
        // comes from a MetadataLoadContext, and passing a runtime typeof into
        // its GetConstructor throws ArgumentException ("Type must be a type
        // provided by the MetadataLoadContext").
        if carrierClr.IsGenericType && !carrierClr.IsGenericTypeDefinition {
            let arguments = carrierClr.GetGenericArguments()
            if arguments.Length == 1 {
                return arguments[0]
            }
        }
        return elementClr
    }

    private func WrapViaCarrierConstructor(
        diagnostics DiagnosticBag,
        callSyntax SyntaxNode,
        carrierType TypeSymbol,
        packedArray BoundExpression,
        selectConstructor(Type, Type) -> ConstructorInfo?
    ) BoundExpression {
        let carrierClr Type? = carrierType.ClrType
        let elementType = GetElementType(carrierType)
        let elementClr Type? = if carrierClr == nil {
            default(Type?)
        } else {
            ResolveElementInCarrierContext(carrierClr, NullableTypeSymbol.GetEffectiveClrType(elementType))
        }
        if carrierClr == nil || elementClr == nil || TypeSymbol.ContainsTypeParameter(elementType) ||
            TypeSymbol
            .ContainsSameCompilationUserType(elementType) {
            // A collection carrier over a same-compilation (erased) element
            // has no closed CLR construction shape yet; the array family
            // still covers that case.
            diagnostics.ReportVariadicCarrierElementNotConstructible(
                callSyntax?.Location ?? default(TextLocation),
                carrierType,
                elementType
            )
            return packedArray
        }
        var constructor ConstructorInfo?
        try {
            constructor = selectConstructor(carrierClr, elementClr)
        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
            constructor = nil
        }
        if constructor == nil {
            diagnostics.ReportVariadicCarrierElementNotConstructible(
                callSyntax?.Location ?? default(TextLocation),
                carrierType,
                elementType
            )
            return packedArray
        }
        // Keep the symbolic carrier so emission can reify its constructor's
        // declaring type consistently with the packed element array.
        return BoundClrConstructorCallExpression(
            callSyntax,
            carrierClr,
            constructor,
            ImmutableArray.Create(packedArray),
            carrierType
        )
    }

    private func TryClassifyCollectionCarrier(type TypeSymbol, out kind CarrierKind) bool {
        kind = CarrierKind.Array
        let openName string? = GetOpenDefinitionFullName(type)
        if openName == nil {
            return false
        }
        if openName == "System.Collections.Generic.List`1" {
            kind = CarrierKind.List
            return true
        }
        if InterfaceCarrierNames.Contains(openName) {
            kind = CarrierKind.Interface
            return true
        }
        if (openName is "System.Span`1" or "System.ReadOnlySpan`1") {
            kind = CarrierKind.Span
            return true
        }
        return false
    }

    private func GetOpenDefinitionFullName(type TypeSymbol) string? {
        if type is ImportedTypeSymbol{OpenDefinition: {} openDefinition} {
            return openDefinition.FullName
        }
        if type.ClrType is {IsGenericType: true, IsGenericTypeDefinition: false} clr {
            try {
                return clr.GetGenericTypeDefinition().FullName
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return nil
            }
        }
        return nil
    }
}
