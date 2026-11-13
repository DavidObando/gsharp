// <copyright file="ByRefStorageMatching.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Linq

/// Issue #4422: decides whether the storage behind a by-reference argument
/// (`&x` at a `ref`, `out` or `in` parameter of a G#
/// callee) has the parameter's type.
///
/// A by-reference argument passes the storage location itself, so its type
/// must be the parameter type, with no conversion. Reference nullability is
/// the one exception: `[]?int32` and `[]int32`, or
/// `List[string?]` and `List[string]`, are one runtime type, and C#
/// accepts such an argument with only a nullability warning. A value-type
/// `int32?` is `Nullable<int32>`, a different runtime type, and
/// is never accepted for `int32`.
///
/// This replaces (cref:DeclarationBinder.TypeSignaturesEquivalent(TypeSymbol, TypeSymbol))
/// at the by-ref gates. The shared comparer answers a boolean equivalence
/// question for declarations, inference, overload identity, and related
/// signature decisions. This matcher additionally records the direction and
/// nesting of reference-nullability differences for `GS0612`, and
/// normalizes equivalent imported-array and native-slice storage views.
internal shared class ByRefStorageMatching {
    /// Compares the storage type of a by-reference argument with the
    /// parameter type.
    /// @param storageType The type of the storage the argument's address points at.
    /// @param parameterType The (substituted) parameter type.
    /// @param storageNullable Set when the top-level storage type is stated nullable (`T?`) and the
    /// parameter type is stated non-null (`T`): a nil in the storage
    /// reaches the callee as a non-null value.
    /// @param parameterNullable Set when the top-level parameter type is stated nullable and the storage
    /// type is stated non-null: the callee may store nil into storage declared
    /// non-null.
    /// @param nestedMismatch Set when an element or type-argument position differs in stated
    /// nullability. Both views share one object, so values of either
    /// nullability can flow through it in both directions.
    /// @returns `true` when the two types are the same runtime type,
    /// differing at most in reference nullability.
    func AreSameStorageType(
        storageType TypeSymbol,
        parameterType TypeSymbol,
        out storageNullable bool,
        out parameterNullable bool,
        out nestedMismatch bool
    ) bool {
        storageNullable = false
        parameterNullable = false
        nestedMismatch = false
        if !Conversion.HaveCompatibleOptionalContracts(storageType, parameterType, invariant: true) {
            return false
        }
        let storageKind = storageType.ReferenceNullability
        let parameterKind = parameterType.ReferenceNullability
        // ADR-0186: a platform (`T!`) position stated nothing, so it differs
        // from neither `T` nor `T?`; only two stated positions can disagree.
        if storageKind == ReferenceNullabilityKind.Nullable && parameterKind == ReferenceNullabilityKind.NotNull {
            storageNullable = true
        } else if parameterKind == ReferenceNullabilityKind.Nullable &&
            storageKind == ReferenceNullabilityKind.NotNull {
            parameterNullable = true
        }
        var storage = StripReferenceWrapper(storageType)
        var parameter = StripReferenceWrapper(parameterType)
        if storage is NullableTypeSymbol || parameter is NullableTypeSymbol {
            // What is left is a value-type `Nullable<V>`, a runtime type of its
            // own: both sides must be one.
            if storage is not NullableTypeSymbol storageValue || parameter is not NullableTypeSymbol parameterValue {
                return false
            }
            storage = storageValue.UnderlyingType
            parameter = parameterValue.UnderlyingType
        }
        if !IsSameRuntimeType(storage, parameter) {
            return false
        }
        ClassifyNestedNullability(storage, parameter, ref storageNullable, ref parameterNullable, ref nestedMismatch)
        return true
    }

    /// Issue #4422: the storage a by-reference argument addresses — the
    /// operand of `&x` or the shared pointee of a conditional
    /// address — when it is known. An unresolved inline `out var` has
    /// the error type and is not known yet.
    /// @param argument The bound argument.
    /// @param refKind Only readonly input arguments use narrowed reference nullability.
    /// @returns The storage type, or `null`.
    func TryGetStorageType(argument BoundExpression?, refKind RefKind = RefKind.None) TypeSymbol? {
        if argument is BoundAddressOfExpression address && ExpressionBinder.TryGetAddressedStorageType(
            address.Operand,
            out var declaredStorage,
            useEffectiveNullability: refKind == RefKind.In
        ) &&
            declaredStorage != TypeSymbol.Error {
            return declaredStorage
        }
        let storageType = switch argument {
            case address is BoundAddressOfExpression: address.Operand?.Type
            case conditional is BoundConditionalAddressExpression: conditional.PointeeType
            case BoundVariableExpression{Type: ByRefTypeSymbol byRef}: byRef.PointeeType
            default: default(TypeSymbol?)
        }
        return if storageType == TypeSymbol.Error {
            default(TypeSymbol?)
        } else {
            storageType
        }
    }

    /// Issue #4422: how well a by-reference argument's storage fits a candidate
    /// parameter, for overload ranking. An exact match is an identity; a match
    /// that differs only in reference nullability (a GS0612 warning) ranks
    /// below it, as C#'s betterness prefers the exact `ref string?` over
    /// `ref string` for `string?` storage. A platform (`T!`)
    /// storage prefers the non-null parameter, ADR-0186 §3's tie-break.
    /// @param storageType The storage type.
    /// @param parameterType The (substituted) parameter type.
    /// @returns `null` when the storage does not fit at all;
    /// otherwise `true` for an exact fit.
    func IsExactStorageMatch(storageType TypeSymbol, parameterType TypeSymbol) bool? {
        if !AreSameStorageType(
            storageType,
            parameterType,
            out var storageNullable,
            out var parameterNullable,
            out var nestedMismatch
        ) {
            return nil
        }
        if storageNullable || parameterNullable || nestedMismatch {
            return false
        }
        return !(
            storageType.ReferenceNullability == ReferenceNullabilityKind.Platform &&
                parameterType.ReferenceNullability == ReferenceNullabilityKind.Nullable
        )
    }

    /// Whether [`storage`](paramref) and [`parameter`](paramref), both
    /// already stripped of a top-level reference-nullability wrapper, denote
    /// one runtime type.
    /// @param storage The storage type.
    /// @param parameter The parameter type.
    /// @returns `true` when they are one runtime type.
    private func IsSameRuntimeType(storage TypeSymbol?, parameter TypeSymbol?) bool {
        if storage == nil || parameter == nil {
            return storage == parameter
        }
        let bareStorage = storage.StripToBareShape()
        let bareParameter = parameter.StripToBareShape()
        if bareStorage is FunctionPointerTypeSymbol || bareParameter is FunctionPointerTypeSymbol {
            return bareStorage is FunctionPointerTypeSymbol storagePointer &&
                bareParameter is FunctionPointerTypeSymbol parameterPointer &&
                storagePointer.SignatureEquals(parameterPointer, Conversion.HaveIdenticalTypeArgumentContracts)
        }
        if bareStorage is NullableTypeSymbol || bareParameter is NullableTypeSymbol {
            return bareStorage is NullableTypeSymbol storageNullable &&
                bareParameter is NullableTypeSymbol parameterNullable &&
                IsSameRuntimeType(storageNullable.UnderlyingType, parameterNullable.UnderlyingType)
        }
        if !TypeSymbol.ContainsFunctionPointer(bareStorage) && !TypeSymbol.ContainsFunctionPointer(bareParameter) &&
            TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(bareStorage, bareParameter) {
            return true
        }
        if bareStorage is PointerTypeSymbol storagePtr && bareParameter is PointerTypeSymbol parameterPtr {
            return IsSameRuntimeType(storagePtr.PointeeType, parameterPtr.PointeeType)
        }
        if bareStorage is StructSymbol storageStruct && bareParameter is StructSymbol parameterStruct {
            return object.ReferenceEquals(
                storageStruct.Definition ?? storageStruct,
                parameterStruct.Definition ?? parameterStruct
            ) &&
                AreSameRuntimeElementSequence(
                Conversion.GetEffectiveStructTypeArguments(storageStruct),
                Conversion.GetEffectiveStructTypeArguments(parameterStruct)
            )
        }
        if bareStorage is InterfaceSymbol storageInterface && bareParameter is InterfaceSymbol parameterInterface {
            return object.ReferenceEquals(
                storageInterface.Definition ?? storageInterface,
                parameterInterface.Definition ?? parameterInterface
            ) &&
                AreSameRuntimeElementSequence(
                Conversion.GetEffectiveInterfaceTypeArguments(storageInterface),
                Conversion.GetEffectiveInterfaceTypeArguments(parameterInterface)
            )
        }
        if bareStorage is DelegateTypeSymbol storageDelegate && bareParameter is DelegateTypeSymbol parameterDelegate {
            return object.ReferenceEquals(
                storageDelegate.Definition ?? storageDelegate,
                parameterDelegate.Definition ?? parameterDelegate
            ) &&
                AreSameRuntimeElementSequence(storageDelegate.TypeArguments, parameterDelegate.TypeArguments)
        }
        if bareStorage is ArrayTypeSymbol || bareParameter is ArrayTypeSymbol {
            if bareStorage is ArrayTypeSymbol storageFixed && bareParameter is ArrayTypeSymbol parameterFixed {
                return storageFixed.Length == parameterFixed.Length &&
                    IsSameRuntimeType(storageFixed.ElementType, parameterFixed.ElementType)
            }
            if bareStorage is ArrayTypeSymbol fixedStorage &&
                TryGetImportedSzArrayElement(bareParameter, out var importedParamElement) {
                return IsSameRuntimeType(fixedStorage.ElementType, importedParamElement)
            }
            if bareParameter is ArrayTypeSymbol fixedParameter &&
                TryGetImportedSzArrayElement(bareStorage, out var importedStorageElement) {
                return IsSameRuntimeType(importedStorageElement, fixedParameter.ElementType)
            }
            return false
        }
        if TryGetSingleDimensionalArrayElement(bareStorage, out var storageArrayElement) &&
            TryGetSingleDimensionalArrayElement(bareParameter, out var parameterArrayElement) {
            return IsSameRuntimeType(storageArrayElement, parameterArrayElement)
        }
        if TryGetMultiDimensionalArrayShape(bareStorage, out var storageMultiElement, out var storageRank) &&
            TryGetMultiDimensionalArrayShape(bareParameter, out var parameterMultiElement, out var parameterRank) {
            return storageRank == parameterRank && IsSameRuntimeType(storageMultiElement, parameterMultiElement)
        }
        if MapTypeSymbol.TryGetMapShape(bareStorage, out var storageKey, out var storageValue) &&
            MapTypeSymbol
            .TryGetMapShape(bareParameter, out var parameterKey, out var parameterValue) {
            return IsSameRuntimeType(storageKey, parameterKey) && IsSameRuntimeType(storageValue, parameterValue)
        }
        if TupleTypeSymbol.TryGetTupleShape(bareStorage, out var storageTupleElements) &&
            TupleTypeSymbol
            .TryGetTupleShape(bareParameter, out var parameterTupleElements) {
            return AreSameRuntimeElementSequence(storageTupleElements, parameterTupleElements)
        }
        if SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
            bareStorage,
            out var storageSeqDef,
            out var storageSeqElement
        ) &&
            SequenceTypeSymbol
            .TryGetEnumerableInterfaceShape(bareParameter, out var parameterSeqDef, out var parameterSeqElement) {
            return ClrTypeUtilities.AreSame(storageSeqDef, parameterSeqDef) &&
                IsSameRuntimeType(storageSeqElement, parameterSeqElement)
        }
        if ChannelTypeSymbol.TryGetChannelShape(
            bareStorage,
            out var storageChanElement,
            out var storageChanDirection,
            out var storageChanConstructed
        ) &&
            ChannelTypeSymbol
            .TryGetChannelShape(
            bareParameter,
            out var parameterChanElement,
            out var parameterChanDirection,
            out var parameterChanConstructed
        ) {
            return storageChanDirection == parameterChanDirection &&
                storageChanConstructed == parameterChanConstructed &&
                IsSameRuntimeType(storageChanElement, parameterChanElement)
        }
        if TryMatchFunctionShape(bareStorage, bareParameter) {
            return true
        }
        if TryGetConstructedImportedGenericShape(bareStorage, out var storageOpenDef, out var storageTypeArgs) &&
            TryGetConstructedImportedGenericShape(bareParameter, out var parameterOpenDef, out var parameterTypeArgs) {
            return ClrTypeUtilities.AreSame(storageOpenDef, parameterOpenDef) &&
                AreSameRuntimeElementSequence(storageTypeArgs, parameterTypeArgs)
        }
        if HasErasedRuntimeShape(bareStorage) || HasErasedRuntimeShape(bareParameter) {
            return false
        }
        // Two representations of one non-erased CLR type, such as a built-in
        // primitive symbol and an ImportedTypeSymbol for the same CLR Type.
        let storageClr Type? = bareStorage.ClrType
        let parameterClr Type? = bareParameter.ClrType
        return storageClr != nil && parameterClr != nil && ClrTypeUtilities.AreSame(storageClr, parameterClr)
    }

    private func AreSameRuntimeElementSequence(left ImmutableArray[TypeSymbol], right ImmutableArray[TypeSymbol]) bool {
        if left.Length != right.Length {
            return false
        }
        for var i = 0; i < left.Length; i++ {
            if !IsSameRuntimeType(left[i], right[i]) {
                return false
            }
        }
        return true
    }

    private func TryGetSingleDimensionalArrayElement(type TypeSymbol, out elementType TypeSymbol?) bool {
        if type is SliceTypeSymbol slice {
            elementType = slice.ElementType
            return true
        }
        return TryGetImportedSzArrayElement(type, out elementType)
    }

    private func TryGetImportedSzArrayElement(type TypeSymbol, out elementType TypeSymbol?) bool {
        if type is ImportedTypeSymbol imported && imported.ClrType is {IsSZArray: true} szArrayClr {
            if !imported.TypeArguments.IsDefaultOrEmpty && imported.TypeArguments.Length == 1 {
                elementType = imported.TypeArguments[0]
                return true
            }
            let positions = imported.GetElementPositions()
            if positions.Length == 1 {
                elementType = if szArrayClr.GetElementType() is {} elemClr {
                    PreserveNominalClrTypeCore(elemClr, positions[0])
                } else {
                    positions[0]
                }
                return true
            }
        }
        elementType = nil
        return false
    }

    func PreserveNominalClrPointeeType(clrType Type?, pointeeType TypeSymbol) TypeSymbol {
        if clrType == nil {
            return pointeeType
        }
        let elementClr = if clrType.IsByRef {
            clrType.GetElementType()
        } else {
            clrType
        }
        return if elementClr == nil {
            pointeeType
        } else {
            PreserveNominalClrTypeCore(elementClr, pointeeType, preserveNominalArray: true)
        }
    }

    func PreserveReferenceTupleIdentity(clrType Type?, typeSymbol TypeSymbol) TypeSymbol {
        if clrType == nil {
            return typeSymbol
        }
        return PreserveNominalClrTypeCore(clrType, typeSymbol, preserveNominalArray: false)
    }

    private func PreserveNominalClrTypeCore(
        clrType Type,
        typeSymbol TypeSymbol,
        preserveNominalArray bool = true
    ) TypeSymbol {
        if typeSymbol is ByRefTypeSymbol byRef {
            let pointeeClr = if clrType.IsByRef {
                clrType.GetElementType() ?? clrType
            } else {
                clrType
            }
            let inner = PreserveNominalClrTypeCore(pointeeClr, byRef.PointeeType, preserveNominalArray)
            return if object.ReferenceEquals(inner, byRef.PointeeType) {
                typeSymbol
            } else {
                ByRefTypeSymbol.Get(inner)
            }
        }
        if typeSymbol is PlatformTypeSymbol platform {
            let inner = PreserveNominalClrTypeCore(clrType, platform.UnderlyingType, preserveNominalArray)
            return if object.ReferenceEquals(inner, platform.UnderlyingType) {
                typeSymbol
            } else {
                PlatformTypeSymbol.Get(inner)
            }
        }
        if typeSymbol is NullableTypeSymbol nullable {
            let underlyingClr = NullableLifting.GetValueTypeNullableUnderlyingClr(clrType) ?? clrType
            let inner = PreserveNominalClrTypeCore(underlyingClr, nullable.UnderlyingType, preserveNominalArray)
            return if object.ReferenceEquals(inner, nullable.UnderlyingType) {
                typeSymbol
            } else {
                NullableTypeSymbol.Get(inner)
            }
        }
        if typeSymbol is NullabilityAnnotatedTypeSymbol annotated {
            let inner = PreserveNominalClrTypeCore(clrType, annotated.BaseType, preserveNominalArray)
            return if object.ReferenceEquals(inner, annotated.BaseType) {
                typeSymbol
            } else if preserveNominalArray {
                inner
            } else {
                NullabilityAnnotatedTypeSymbol(inner, annotated.NullableFlags)
            }
        }
        if clrType.IsGenericType {
            let openDef = if clrType.IsGenericTypeDefinition {
                clrType
            } else {
                clrType.GetGenericTypeDefinition()
            }
            if openDef.FullName?.StartsWith("System.Tuple`", StringComparison.Ordinal) == true &&
                typeSymbol is TupleTypeSymbol tuple &&
                ReconstructReferenceTupleFromFlattenedElements(
                clrType,
                tuple.ElementTypes,
                0,
                preserveNominalArray
            ) is {} reconstructed {
                return reconstructed
            }
            if openDef.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true &&
                typeSymbol is TupleTypeSymbol valueTuple {
                let clrElements = ImmutableArray.CreateBuilder[Type]()
                if TryCollectFlattenedValueTupleClrElements(clrType, clrElements) &&
                    clrElements.Count == valueTuple
                    .ElementTypes
                    .Length {
                    let builder = ImmutableArray.CreateBuilder[TypeSymbol](clrElements.Count)
                    var changed = false
                    for var i = 0; i < clrElements.Count; i++ {
                        let updated = PreserveNominalClrTypeCore(
                            clrElements[i],
                            valueTuple.ElementTypes[i],
                            preserveNominalArray
                        )
                        changed |= !object.ReferenceEquals(updated, valueTuple.ElementTypes[i])
                        builder.Add(updated)
                    }
                    if changed {
                        return TupleTypeSymbol.Get(builder.MoveToImmutable(), valueTuple.ElementNames)
                    }
                    return typeSymbol
                }
            }
            if !clrType.IsGenericTypeDefinition && typeSymbol is ImportedTypeSymbol imported {
                let clrArgs = clrType.GetGenericArguments()
                let symArgs = imported.ConstructedTypeArguments
                if clrArgs.Length == symArgs.Length {
                    let builder = ImmutableArray.CreateBuilder[TypeSymbol](clrArgs.Length)
                    var changed = false
                    for var i = 0; i < clrArgs.Length; i++ {
                        let updated = PreserveNominalClrTypeCore(clrArgs[i], symArgs[i], preserveNominalArray)
                        changed |= !object.ReferenceEquals(updated, symArgs[i])
                        builder.Add(updated)
                    }
                    if changed {
                        return ImportedTypeSymbol.GetConstructed(
                            imported.Type,
                            imported.OpenDefinition ?? openDef,
                            builder.MoveToImmutable()
                        )
                    }
                }
            }
        }
        if clrType.IsArray &&
            !clrType.IsSZArray &&
            typeSymbol is RectangularArrayTypeSymbol rectangular &&
            clrType.GetElementType() is {} rectElemClr {
            let updatedRectElem = PreserveNominalClrTypeCore(rectElemClr, rectangular.ElementType, preserveNominalArray)
            return if object.ReferenceEquals(updatedRectElem, rectangular.ElementType) {
                typeSymbol
            } else {
                RectangularArrayTypeSymbol.Get(updatedRectElem, rectangular.Rank)
            }
        }
        if clrType.IsSZArray && typeSymbol is SliceTypeSymbol slice && clrType.GetElementType() is {} elemClr {
            let updatedElem = PreserveNominalClrTypeCore(elemClr, slice.ElementType, preserveNominalArray)
            if !preserveNominalArray {
                return if object.ReferenceEquals(updatedElem, slice.ElementType) {
                    typeSymbol
                } else {
                    SliceTypeSymbol.Get(updatedElem)
                }
            }
            if !HasErasedRuntimeShape(updatedElem) && NullableLifting.GetEffectiveClrType(
                updatedElem
            ) is {} concreteElemClr {
                return ImportedTypeSymbol.GetWithoutNullability(
                    concreteElemClr.MakeArrayType(),
                    NullabilityFreeReason.TypeStructure
                )
            }
            return ImportedTypeSymbol.GetConstructed(
                typeof([]object),
                openDefinition: nil,
                ImmutableArray.Create(updatedElem)
            )
        }
        return typeSymbol
    }

    private func ReconstructReferenceTupleFromFlattenedElements(
        clrType Type,
        elements ImmutableArray[TypeSymbol],
        offset int32,
        preserveNominalArray bool = true
    ) TypeSymbol? {
        if !clrType.IsGenericType {
            return nil
        }
        let openDef = if clrType.IsGenericTypeDefinition {
            clrType
        } else {
            clrType.GetGenericTypeDefinition()
        }
        if openDef.FullName?.StartsWith("System.Tuple`", StringComparison.Ordinal) != true {
            return nil
        }
        let clrArgs = clrType.GetGenericArguments()
        let remaining = elements.Length - offset
        let closedOrOpen = if clrType.ContainsGenericParameters {
            openDef
        } else {
            clrType
        }
        if clrArgs.Length == 8 && remaining >= 8 && IsTupleRestClrType(clrArgs[7]) {
            let restSymbol = ReconstructTupleRestFromFlattenedElements(
                clrArgs[7],
                elements,
                offset + 7,
                preserveNominalArray
            )
            if restSymbol == nil {
                return nil
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](8)
            for var i = 0; i < 7; i++ {
                builder.Add(PreserveNominalClrTypeCore(clrArgs[i], elements[offset + i], preserveNominalArray))
            }
            builder.Add(restSymbol)
            return ImportedTypeSymbol.GetConstructed(closedOrOpen, openDef, builder.MoveToImmutable())
        }
        if clrArgs.Length != remaining {
            return nil
        }
        let directBuilder = ImmutableArray.CreateBuilder[TypeSymbol](clrArgs.Length)
        for var i = 0; i < clrArgs.Length; i++ {
            directBuilder.Add(PreserveNominalClrTypeCore(clrArgs[i], elements[offset + i], preserveNominalArray))
        }
        return ImportedTypeSymbol.GetConstructed(closedOrOpen, openDef, directBuilder.MoveToImmutable())
    }

    private func ReconstructTupleRestFromFlattenedElements(
        restClrType Type,
        elements ImmutableArray[TypeSymbol],
        offset int32,
        preserveNominalArray bool = true
    ) TypeSymbol? {
        if !restClrType.IsGenericType {
            return nil
        }
        let openDef = if restClrType.IsGenericTypeDefinition {
            restClrType
        } else {
            restClrType.GetGenericTypeDefinition()
        }
        if openDef.FullName?.StartsWith("System.Tuple`", StringComparison.Ordinal) == true {
            return ReconstructReferenceTupleFromFlattenedElements(restClrType, elements, offset, preserveNominalArray)
        }
        if openDef.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true {
            let remaining = elements.Length - offset
            if remaining == 1 && restClrType.GetGenericArguments() is {Length: 1} singleRestArgs {
                let closedOrOpen = if restClrType.ContainsGenericParameters {
                    openDef
                } else {
                    restClrType
                }
                return ImportedTypeSymbol.GetConstructed(
                    closedOrOpen,
                    openDef,
                    ImmutableArray.Create(
                        PreserveNominalClrTypeCore(singleRestArgs[0], elements[offset], preserveNominalArray)
                    )
                )
            }
            if remaining >= 2 {
                let subBuilder = ImmutableArray.CreateBuilder[TypeSymbol](remaining)
                for var i = offset; i < elements.Length; i++ {
                    subBuilder.Add(elements[i])
                }
                return PreserveNominalClrTypeCore(
                    restClrType,
                    TupleTypeSymbol.Get(subBuilder.MoveToImmutable()),
                    preserveNominalArray
                )
            }
        }
        return nil
    }

    private func IsTupleRestClrType(clrType Type) bool {
        if !clrType.IsGenericType {
            return false
        }
        let openDef = if clrType.IsGenericTypeDefinition {
            clrType
        } else {
            clrType.GetGenericTypeDefinition()
        }
        return openDef.FullName?.StartsWith("System.Tuple`", StringComparison.Ordinal) == true ||
            openDef
            .FullName
            ?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true
    }

    private func TryCollectFlattenedValueTupleClrElements(clrType Type, sink ImmutableArray[Type].Builder) bool {
        if !clrType.IsGenericType {
            return false
        }
        let openDef = if clrType.IsGenericTypeDefinition {
            clrType
        } else {
            clrType.GetGenericTypeDefinition()
        }
        if openDef.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) != true {
            return false
        }
        let clrArgs = clrType.GetGenericArguments()
        if clrArgs.Length == 8 && IsTupleRestClrType(clrArgs[7]) {
            for var i = 0; i < 7; i++ {
                sink.Add(clrArgs[i])
            }
            return if clrArgs[7]
                .GetGenericTypeDefinition()
                .FullName
                ?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true {
                TryCollectFlattenedValueTupleClrElements(clrArgs[7], sink)
            } else {
                false
            }
        }
        for arg in clrArgs {
            sink.Add(arg)
        }
        return true
    }

    private func TryGetMultiDimensionalArrayShape(type TypeSymbol, out elementType TypeSymbol?, out rank int32) bool {
        if type is RectangularArrayTypeSymbol rectangular {
            elementType = rectangular.ElementType
            rank = rectangular.Rank
            return true
        }
        if type is ImportedTypeSymbol imported && imported.ClrType is {IsArray: true, IsSZArray: false} arrayClr {
            let positions = imported.GetElementPositions()
            if positions.Length == 1 {
                elementType = if arrayClr.GetElementType() is {} elemClr {
                    PreserveNominalClrTypeCore(elemClr, positions[0])
                } else {
                    positions[0]
                }
                rank = arrayClr.GetArrayRank()
                return true
            }
        }
        elementType = nil
        rank = 0
        return false
    }

    private func TryMatchFunctionShape(left TypeSymbol, right TypeSymbol) bool {
        if left is FunctionTypeSymbol leftFunction && right is FunctionTypeSymbol rightFunction {
            return leftFunction.IsVariadic.SequenceEqual(rightFunction.IsVariadic) &&
                AreSameRuntimeElementSequence(leftFunction.ParameterTypes, rightFunction.ParameterTypes) &&
                IsSameRuntimeType(leftFunction.ReturnType, rightFunction.ReturnType)
        }
        return TryMatchNaturalDelegate(left, right) || TryMatchNaturalDelegate(right, left)
    }

    private func TryMatchNaturalDelegate(source TypeSymbol, target TypeSymbol) bool {
        if source is not FunctionTypeSymbol sourceFunction ||
            sourceFunction.HasVariadic ||
            sourceFunction.Arity > 16 ||
            target.ClrType == nil {
            return false
        }
        let isVoid = FunctionTypeSymbol.IsVoidReturn(sourceFunction.ReturnType)
        let naturalFullName = if isVoid {
            (
                if sourceFunction.Arity == 0 {
                    "System.Action"
                } else {
                    "System.Action`" + sourceFunction.Arity.ToString(System.Globalization.CultureInfo.InvariantCulture)
                }
            )
        } else {
            "System.Func`" + (sourceFunction.Arity + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)
        }
        let targetDefinition = if target.ClrType!!.IsGenericType {
            target.ClrType!!.GetGenericTypeDefinition()
        } else {
            target.ClrType!!
        }
        let baseType Type? = targetDefinition.BaseType
        if !string.Equals(targetDefinition.FullName, naturalFullName, StringComparison.Ordinal) ||
            baseType == nil ||
            !string.Equals(baseType.FullName, "System.MulticastDelegate", StringComparison.Ordinal) || !string.Equals(
            targetDefinition.Assembly.FullName,
            baseType.Assembly.FullName,
            StringComparison.Ordinal
        ) {
            return false
        }
        let targetArgs = target.ConstructedTypeArguments
        let expectedArgCount = if isVoid {
            sourceFunction.Arity
        } else {
            sourceFunction.Arity + 1
        }
        if targetArgs.Length != expectedArgCount {
            return false
        }
        for var i = 0; i < sourceFunction.Arity; i++ {
            if !IsSameRuntimeType(sourceFunction.ParameterTypes[i], targetArgs[i]) {
                return false
            }
        }
        return isVoid || IsSameRuntimeType(sourceFunction.ReturnType, targetArgs[sourceFunction.Arity])
    }

    private func TryGetConstructedImportedGenericShape(
        type TypeSymbol,
        out openDefinition Type?,
        out typeArguments ImmutableArray[TypeSymbol]
    ) bool {
        if type is ImportedTypeSymbol imported {
            if imported.OpenDefinition != nil && !imported.TypeArguments.IsDefaultOrEmpty {
                openDefinition = imported.OpenDefinition
                typeArguments = imported.TypeArguments
                return true
            }
            if imported.ClrType is {IsGenericType: true, IsGenericTypeDefinition: false} genericClr {
                openDefinition = genericClr.GetGenericTypeDefinition()
                let rawArguments = imported.ConstructedTypeArguments
                let clrArguments = genericClr.GetGenericArguments()
                if rawArguments.Length == clrArguments.Length && !rawArguments.IsDefaultOrEmpty {
                    let builder = ImmutableArray.CreateBuilder[TypeSymbol](rawArguments.Length)
                    for var i = 0; i < rawArguments.Length; i++ {
                        builder.Add(PreserveNominalClrTypeCore(clrArguments[i], rawArguments[i]))
                    }
                    typeArguments = builder.MoveToImmutable()
                    return true
                }
                typeArguments = rawArguments
                return !typeArguments.IsDefaultOrEmpty
            }
        }
        openDefinition = nil
        typeArguments = default(ImmutableArray[TypeSymbol])
        return false
    }

    private func HasErasedRuntimeShape(type TypeSymbol) bool -> TypeSymbol.ContainsSameCompilationUserType(type) ||
        TypeSymbol.ContainsTypeParameter(type) || TypeSymbol.ContainsFixedLengthArray(type) ||
        TypeSymbol.ContainsFunctionPointer(type)

    // Value-tuple fields live directly in the passed storage (#5905).
    // Classify their leaf nullability by direction, and keep shared container positions invariant.
    private func ClassifyNestedNullability(
        storage TypeSymbol,
        parameter TypeSymbol,
        ref storageNullable bool,
        ref parameterNullable bool,
        ref nestedMismatch bool
    ) {
        if TupleTypeSymbol.TryGetTupleShape(storage.StripToBareShape(), out _) && TupleTypeSymbol.TryGetTupleShape(
            parameter.StripToBareShape(),
            out _
        ) {
            let storagePositions = storage.GetElementPositions()
            let parameterPositions = parameter.GetElementPositions()
            if storagePositions.Length != parameterPositions.Length {
                return
            }
            for var i = 0; i < storagePositions.Length; i++ {
                let storageElement = storagePositions[i]
                let parameterElement = parameterPositions[i]
                let storageKind = storageElement.ReferenceNullability
                let parameterKind = parameterElement.ReferenceNullability
                if storageKind == ReferenceNullabilityKind.Nullable &&
                    parameterKind == ReferenceNullabilityKind.NotNull {
                    storageNullable = true
                } else if parameterKind == ReferenceNullabilityKind.Nullable &&
                    storageKind == ReferenceNullabilityKind.NotNull {
                    parameterNullable = true
                }
                let innerStorage = StripValueWrapper(StripReferenceWrapper(storageElement))
                let innerParameter = StripValueWrapper(StripReferenceWrapper(parameterElement))
                ClassifyNestedNullability(
                    innerStorage,
                    innerParameter,
                    ref storageNullable,
                    ref parameterNullable,
                    ref nestedMismatch
                )
            }
            return
        }
        if HasNestedNullabilityMismatch(storage, parameter) {
            nestedMismatch = true
        }
    }

    /// Whether any element or type-argument position of the two types differs
    /// in stated reference nullability, at any depth.
    /// @param storage The storage type.
    /// @param parameter The parameter type.
    /// @returns `true` when a nested position differs.
    private func HasNestedNullabilityMismatch(storage TypeSymbol, parameter TypeSymbol) bool {
        let storagePositions = storage.GetElementPositions()
        let parameterPositions = parameter.GetElementPositions()
        if storagePositions.Length != parameterPositions.Length {
            return false
        }
        for var i = 0; i < storagePositions.Length; i++ {
            if PositionDiffers(storagePositions[i], parameterPositions[i]) {
                return true
            }
        }
        return false
    }

    private func PositionDiffers(storage TypeSymbol, parameter TypeSymbol) bool {
        let storageKind = storage.ReferenceNullability
        let parameterKind = parameter.ReferenceNullability
        if (storageKind == ReferenceNullabilityKind.Nullable && parameterKind == ReferenceNullabilityKind.NotNull) ||
            (storageKind == ReferenceNullabilityKind.NotNull && parameterKind == ReferenceNullabilityKind.Nullable) {
            return true
        }
        let innerStorage = StripValueWrapper(StripReferenceWrapper(storage))
        let innerParameter = StripValueWrapper(StripReferenceWrapper(parameter))
        return HasNestedNullabilityMismatch(innerStorage, innerParameter)
    }

    /// Removes a top-level reference-nullability wrapper — a `T?` over a
    /// reference type, or a platform `T!` — leaving a value-type
    /// `Nullable<V>` in place.
    /// @param type The type.
    /// @returns The type without its top-level reference-nullability wrapper.
    private func StripReferenceWrapper(type TypeSymbol) TypeSymbol {
        if type is PlatformTypeSymbol platform {
            return platform.UnderlyingType
        }
        if type is NullableTypeSymbol nullable && type.ReferenceNullability == ReferenceNullabilityKind.Nullable {
            return nullable.UnderlyingType
        }
        return type
    }

    private func StripValueWrapper(type TypeSymbol) TypeSymbol -> if type is NullableTypeSymbol nullable {
        nullable.UnderlyingType
    } else {
        type
    }
}
