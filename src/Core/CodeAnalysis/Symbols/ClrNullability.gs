// <copyright file="ClrNullability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Collections.ObjectModel
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import System.Threading

/// Phase 3.C.5 / ADR-0001 / issue #209: helpers for reading C# nullable-reference-types
/// metadata (`[NullableAttribute]` / `[NullableContextAttribute]`)
/// from members loaded through a (cref:MetadataLoadContext).
///
/// Both top-level and inner-position (generic argument or array element)
/// nullability are surfaced. Inner positions are carried via
/// (cref:NullabilityAnnotatedTypeSymbol) so that code paths such as
/// `for range` iteration and CLR indexer access can recover element
/// nullability at bind time.
shared class ClrNullability {
    private const NullableAttributeFullName string = "System.Runtime.CompilerServices.NullableAttribute"
    private const NullableContextAttributeFullName string = "System.Runtime.CompilerServices.NullableContextAttribute"
    private const NotNullWhenAttributeFullName string = "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute"
    private const MaybeNullWhenAttributeFullName string = "System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute"
    private const MemberNotNullAttributeFullName string = "System.Diagnostics.CodeAnalysis.MemberNotNullAttribute"
    private const MemberNotNullWhenAttributeFullName string = "System.Diagnostics.CodeAnalysis.MemberNotNullWhenAttribute"
    private const NotNullIfNotNullAttributeFullName string = "System.Diagnostics.CodeAnalysis.NotNullIfNotNullAttribute"

    /// Issue #3802: cache of the parameter names carried by
    /// `[return: NotNullIfNotNull(...)]` per method. Reading custom
    /// attribute data through a (cref:MetadataLoadContext) is expensive
    /// and every imported call site asks the same question, so the answer is
    /// memoised. An empty array means "no conditional post-condition".
    private let NotNullIfNotNullCache ConditionalWeakTable[MethodInfo, []string] = ConditionalWeakTable[
        MethodInfo,
        []string
    ]()

    private class RawFlags {
        internal let Value ImmutableArray[uint8]

        internal init(value ImmutableArray[uint8]) {
            Value = value
        }
    }

    private let AttributesCache ConditionalWeakTable[ICustomAttributeProvider, IList[CustomAttributeData]] =
    ConditionalWeakTable[ICustomAttributeProvider, IList[CustomAttributeData]]()
    private let NullableFlagsCache ConditionalWeakTable[ICustomAttributeProvider, RawFlags] =
    ConditionalWeakTable[ICustomAttributeProvider, RawFlags]()
    private let NullableContextCache ConditionalWeakTable[ICustomAttributeProvider, RawFlags] =
    ConditionalWeakTable[ICustomAttributeProvider, RawFlags]()

    /// The decoded symbol of one declaration, one slot per nullability mode.
    /// The mode is an ambient setting (see (cref:NullabilityOptions)) and changes the
    /// decoded symbol, so it is part of the cache key.
    private class DecodedSignature {
        internal var PlatformTypes TypeSymbol?
        internal var Legacy TypeSymbol?
    }

    /// Issue #5125: decoded symbols of imported declarations, keyed by the
    /// reflected member (property, field, method return or parameter) and the
    /// nullability mode. The decode reads only the member, its declaring
    /// context and the mode, so the entry cannot answer another consumer or
    /// reference set. A member object belongs to one metadata context, and the
    /// entry lives as long as that member.
    private let DecodedSignatures ConditionalWeakTable[object, DecodedSignature] = ConditionalWeakTable[
        object,
        DecodedSignature
    ]()
    private let CreateDecodedSignature ConditionalWeakTable[object, DecodedSignature].CreateValueCallback =
    (_ object) -> DecodedSignature()

    /// Gets the slots of [`member`](paramref). A caller holds the lock on the
    /// slots while it reads or decodes, so each decode runs once per member and
    /// mode, also under concurrent callers.
    private func GetDecodedSignature(member object) DecodedSignature -> DecodedSignatures.GetValue(
        member,
        CreateDecodedSignature
    )

    /// Reads the decoded symbol of the current nullability mode, or `nil`
    /// when this member and mode were not decoded yet. Call under the slots lock.
    private func ReadDecodedSignature(slots DecodedSignature) TypeSymbol? {
        let cached = if NullabilityOptions.PlatformTypesEnabled {
            slots.PlatformTypes
        } else {
            slots.Legacy
        }
        if cached != nil {
            CompilationMeasurements.Count("metadata.signature-cache-hits")
        }
        return cached
    }

    private class FailureCounter {
        internal var Count int32
    }

    private let MetadataReadFailures ThreadLocal[FailureCounter] = ThreadLocal[FailureCounter](() -> FailureCounter())

    /// Records a metadata read that failed and fell back to a default. A decode
    /// that sees such a failure must not be cached, because the read can
    /// succeed later (issue #5125, issue #5070).
    internal func RecordMetadataReadFailure() {
        MetadataReadFailures.Value.Count++
    }

    /// Returns a mark for metadata reads on the current thread.
    internal func MarkMetadataReadFailures() int32 -> MetadataReadFailures.Value.Count

    /// Reports metadata read failures since [`mark`](paramref) on the current thread.
    internal func MetadataReadFailedSince(mark int32) bool -> MetadataReadFailures.Value.Count != mark

    /// Stores a decoded symbol for the current nullability mode, unless a metadata
    /// read failed on this thread since [`mark`](paramref). A failed decode returns
    /// its fallback symbol and leaves the slot empty, so the next call decodes again.
    /// Call under the slots lock.
    private func StoreDecodedSignature(slots DecodedSignature, decoded TypeSymbol, mark int32) TypeSymbol {
        if MetadataReadFailedSince(mark) {
            CompilationMeasurements.Count("metadata.signature-decode-failures")
            return decoded
        }
        CompilationMeasurements.Count("metadata.signature-decodes")
        if NullabilityOptions.PlatformTypesEnabled {
            slots.PlatformTypes = decoded
        } else {
            slots.Legacy = decoded
        }
        return decoded
    }

    /// Returns the GSharp (cref:TypeSymbol) for a property's
    /// declared type, with reference-type nullability applied (both
    /// top-level and inner generic argument positions — issue #209).
    /// Value-type `Nullable<T>` is handled inside
    /// (cref:TypeSymbol.FromClrType(Type)).
    /// @param property The property to inspect.
    /// @returns The mapped type symbol.
    @NullabilityFunnel
    func GetPropertyTypeSymbol(property PropertyInfo) TypeSymbol {
        let slots = GetDecodedSignature(property)
        lock slots {
            let cached = ReadDecodedSignature(slots)
            if cached != nil {
                return cached
            }
            let mark = MarkMetadataReadFailures()
            return StoreDecodedSignature(slots, DecodePropertyTypeSymbol(property), mark)
        }
    }

    @NullabilityFunnel
    private func DecodePropertyTypeSymbol(property PropertyInfo) TypeSymbol {
        let propertyType = GetSignatureType(property)
        if propertyType.IsByRef {
            // PropertyType.IsByRef guarantees that GetElementType returns the referent type.
            return ByRefTypeSymbol.Get(GetPropertyElementTypeSymbol(property, propertyType.GetElementType()!!))
        }
        let baseSymbol = TypeSymbol.FromClrType(propertyType)
        // Properties have no dedicated `ReturnParameter` to attach
        // `[NullableAttribute]` to in C# metadata; the attribute lands on
        // the property itself. Walk the enclosing member chain via the
        // declaring type to pick up any `[NullableContextAttribute]`
        // fallback (matches the C# emit shape used by csc for
        // e.g. `DirectoryInfo.Parent`).
        // ADR-0172 Phase B: surface imported tuple element names.
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(
                baseSymbol,
                propertyType,
                property,
                property.DeclaringType,
                GetOpenDefinition(property)?.PropertyType
            ),
            property
        )
    }

    /// Issue #1701: variant of (cref:GetPropertyTypeSymbol(PropertyInfo))
    /// for a ref-returning indexer (`PropertyType.IsByRef`), where the
    /// `[NullableAttribute]` metadata is read off [`property`](paramref)
    /// but applied to [`elementType`](paramref) (the by-ref pointee,
    /// e.g. `T` in `ref T`) rather than the by-ref type itself —
    /// mirroring how (cref:GetPropertyTypeSymbol(PropertyInfo)) handles
    /// the non-byref case. Callers wrap the result in `ByRefTypeSymbol`.
    /// @param property The ref-returning indexer/property to read attributes from.
    /// @param elementType The dereferenced (non-byref) element type.
    /// @returns The nullability-aware element type symbol.
    @NullabilityFunnel
    func GetPropertyElementTypeSymbol(property PropertyInfo, elementType Type) TypeSymbol {
        let baseSymbol = TypeSymbol.FromClrType(elementType)
        var layoutType = GetOpenDefinition(property)?.PropertyType
        if layoutType?.IsByRef == true {
            layoutType = layoutType!!.GetElementType()
        }
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(baseSymbol, elementType, property, property.DeclaringType, layoutType),
            property
        )
    }

    /// Returns the GSharp (cref:TypeSymbol) for a field's
    /// declared type, with reference-type nullability applied.
    /// @param field The field to inspect.
    /// @returns The mapped type symbol.
    @NullabilityFunnel
    func GetFieldTypeSymbol(field FieldInfo) TypeSymbol {
        let slots = GetDecodedSignature(field)
        lock slots {
            let cached = ReadDecodedSignature(slots)
            if cached != nil {
                return cached
            }
            let mark = MarkMetadataReadFailures()
            return StoreDecodedSignature(slots, DecodeFieldTypeSymbol(field), mark)
        }
    }

    @NullabilityFunnel
    private func DecodeFieldTypeSymbol(field FieldInfo) TypeSymbol {
        let fieldType = GetSignatureType(field)
        let baseSymbol = TypeSymbol.FromClrType(fieldType)
        // ADR-0172 Phase B: surface imported tuple element names.
        return TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(
                baseSymbol,
                fieldType,
                field,
                field.DeclaringType,
                GetOpenDefinition(field)?.FieldType
            ),
            field
        )
    }

    /// Returns the GSharp (cref:TypeSymbol) for a method's return
    /// type, wrapping it in (cref:NullableTypeSymbol) when the
    /// underlying CLR type is a reference type annotated as nullable, and
    /// in (cref:NullabilityAnnotatedTypeSymbol) when the type has
    /// generic arguments with inner-position nullability (issue #209).
    /// Value-type nullability (`Nullable<T>`) is handled inside
    /// (cref:TypeSymbol.FromClrType(Type)).
    /// @param method The method to inspect.
    /// @returns The mapped type symbol.
    @NullabilityFunnel
    func GetReturnTypeSymbol(method MethodInfo) TypeSymbol {
        let slots = GetDecodedSignature(method)
        lock slots {
            let cached = ReadDecodedSignature(slots)
            if cached != nil {
                return cached
            }
            let mark = MarkMetadataReadFailures()
            return StoreDecodedSignature(slots, DecodeReturnTypeSymbol(method), mark)
        }
    }

    @NullabilityFunnel
    private func DecodeReturnTypeSymbol(method MethodInfo) TypeSymbol {
        let signatureType = GetSignatureType(method.ReturnParameter)
        // ReturnType.IsByRef guarantees a non-null reflected element type on that branch.
        let returnType = if signatureType.IsByRef {
            signatureType.GetElementType()!!
        } else {
            signatureType
        }
        let baseSymbol = TypeSymbol.FromClrType(returnType)
        let definition = GetMetadataDefinition(method) as MethodInfo
        var layoutType = definition?.ReturnType
        if layoutType?.IsByRef == true {
            layoutType = layoutType!!.GetElementType()
        }
        // ADR-0172 Phase B: surface imported tuple element names.
        let result = TupleElementNamesReader.ApplyNames(
            ApplyReferenceNullabilityFull(baseSymbol, returnType, method.ReturnParameter, method, layoutType),
            method.ReturnParameter
        )
        return if method.ReturnType.IsByRef {
            cast[TypeSymbol](ByRefTypeSymbol.Get(result))
        } else {
            result
        }
    }

    /// Returns the GSharp (cref:TypeSymbol) for a parameter, with
    /// reference-type nullability applied (both top-level and inner generic
    /// argument positions — issue #209).
    /// @param parameter The parameter to inspect.
    /// @returns The mapped type symbol.
    @NullabilityFunnel
    func GetParameterTypeSymbol(parameter ParameterInfo) TypeSymbol {
        let slots = GetDecodedSignature(parameter)
        lock slots {
            let cached = ReadDecodedSignature(slots)
            if cached != nil {
                return cached
            }
            let mark = MarkMetadataReadFailures()
            return StoreDecodedSignature(slots, DecodeParameterTypeSymbol(parameter), mark)
        }
    }

    @NullabilityFunnel
    private func DecodeParameterTypeSymbol(parameter ParameterInfo) TypeSymbol {
        let signatureType = GetSignatureType(parameter)
        let parameterType = if signatureType.IsByRef {
            signatureType.GetElementType()
        } else {
            signatureType
        }
        // ADR-0193 §4: an indexer's parameter needs its open declaration as
        // the layout too, exactly as a method's does — without one an
        // oblivious `TKey` index parameter read through a closed
        // `ConcurrentDictionary<string, …>` stamped the slot's byte onto the
        // argument (`string!`).
        let definitionParameters[]?ParameterInfo = switch parameter.Member {
            case method is MethodBase: GetMetadataDefinition(method)?.GetParameters()
            case indexer is PropertyInfo: GetOpenDefinition(indexer)?.GetIndexParameters()
            default: default([]?ParameterInfo)
        }
        var layoutType = if definitionParameters != nil &&
            uint32(parameter.Position) < uint32(definitionParameters.Length) {
            definitionParameters[parameter.Position].ParameterType
        } else {
            default(Type?)
        }
        if layoutType?.IsByRef == true {
            layoutType = layoutType!!.GetElementType()
        }
        let baseSymbol = TypeSymbol.FromClrType(parameterType)
        var mapped = ApplyReferenceNullabilityFull(baseSymbol, parameterType, parameter, parameter.Member, layoutType)
        // ADR-0172 Phase B: surface imported tuple element names.
        mapped = TupleElementNamesReader.ApplyNames(mapped, parameter)
        let rawDefault object? = if parameter.HasDefaultValue || parameter.IsOptional {
            parameter.RawDefaultValue
        } else {
            default(object?)
        }
        return if parameterType?.IsValueType == false &&
            (parameter.HasDefaultValue || parameter.IsOptional) &&
            (
            rawDefault == nil || object.ReferenceEquals(rawDefault, Missing.Value) || object.ReferenceEquals(
                rawDefault,
                DBNull.Value
            )
        ) &&
            !(mapped is NullableTypeSymbol) {
            NullabilityImportRule.ApplyNullDefaultLift(mapped)
        } else {
            mapped
        }
    }

    /// Issue #4425: what a parameter's declaration says about its top-level
    /// position, as written. Unlike (cref:GetParameterTypeSymbol), this
    /// does not also widen a reference parameter whose default is
    /// `null`: `T value = default` declares an unannotated
    /// `T`, and method type-argument inference must read it as one.
    /// @param parameter The parameter to inspect.
    /// @returns The declared state of the parameter's top-level position.
    @NullabilityFunnel
    internal func GetParameterDeclaredState(parameter ParameterInfo) ClrNullabilityState -> ClassifyPosition(
        ReadNullableFlags(parameter, parameter.Member),
        0
    )

    /// Issue #3802: collects the parameter names named by every
    /// `[return: NotNullIfNotNull(name)]` on [`method`](paramref).
    /// The attribute states a CONDITIONAL post-condition — the (declared
    /// nullable) return value is non-null whenever the named argument is
    /// non-null — so this reader deliberately reports only the names. Deciding
    /// whether the post-condition actually holds is a fact about a particular
    /// call site's arguments and belongs with the binder's narrowing
    /// machinery, not with the declaration reader: narrowing the DECLARED
    /// return type here would restore the very unsoundness that #3705 family 2
    /// removed.
    /// @param method The method to inspect.
    /// @returns The named parameters, in attribute order; empty when the method carries
    /// no conditional return post-condition.
    internal func GetNotNullIfNotNullParameters(method MethodInfo) IReadOnlyList[string] {
        if NotNullIfNotNullCache.TryGetValue(method, out var cached) {
            return cached
        }
        let names = ReadNotNullIfNotNullParameters(method)
        NotNullIfNotNullCache.AddOrUpdate(method, names)
        return names
    }

    internal func TryGetNotNullWhen(parameter ParameterInfo, out returnValue bool) bool {
        return TryGetBoolAttributeValue(parameter, NotNullWhenAttributeFullName, out returnValue)
    }

    internal func TryGetMaybeNullWhen(parameter ParameterInfo, out returnValue bool) bool {
        return TryGetBoolAttributeValue(parameter, MaybeNullWhenAttributeFullName, out returnValue)
    }

    /// Collects all member names from every `[MemberNotNull]` attribute
    /// on [`method`](paramref). Issue #208: used to apply unconditional
    /// field post-condition narrowing at call sites.
    /// @param method The method to inspect.
    /// @param members Receives the collected member names.
    /// @returns `true` when at least one name was collected.
    internal func TryGetMemberNotNullMembers(method MethodInfo, out members ImmutableArray[string]) bool {
        members = ImmutableArray[string].Empty
        let attrs IList[CustomAttributeData]? = SafeGetCustomAttributesData(method)
        if attrs == nil {
            return false
        }
        var builder ImmutableArray[string].Builder? = nil
        for ad in attrs {
            if ad.AttributeType?.FullName != MemberNotNullAttributeFullName || ad.ConstructorArguments.Count == 0 {
                continue
            }
            for arg in ad.ConstructorArguments {
                CollectStringOrArray(arg, &builder)
            }
        }
        if builder == nil {
            return false
        }
        members = builder.ToImmutable()
        return true
    }

    /// Extracts the `returnValue` boolean and field names from a
    /// `[MemberNotNullWhen]` attribute on [`method`](paramref).
    /// Issue #208: used to apply conditional field post-condition narrowing.
    /// Returns the first valid occurrence found.
    /// @param method The method to inspect.
    /// @param returnValue Receives the `returnValue` argument.
    /// @param members Receives the member names.
    /// @returns `true` when a valid `[MemberNotNullWhen]` was found.
    internal func TryGetMemberNotNullWhenData(
        method MethodInfo,
        out returnValue bool,
        out members ImmutableArray[string]
    ) bool {
        returnValue = false
        members = ImmutableArray[string].Empty
        let attrs IList[CustomAttributeData]? = SafeGetCustomAttributesData(method)
        if attrs == nil {
            return false
        }
        for ad in attrs {
            if ad.AttributeType?.FullName != MemberNotNullWhenAttributeFullName || ad.ConstructorArguments.Count < 2 {
                continue
            }
            if ad.ConstructorArguments[0].Value is not bool rv {
                continue
            }
            var builder ImmutableArray[string].Builder? = nil
            for var i = 1; i < ad.ConstructorArguments.Count; i++ {
                CollectStringOrArray(ad.ConstructorArguments[i], &builder)
            }
            if builder != nil && builder.Count > 0 {
                returnValue = rv
                members = builder.ToImmutable()
                return true
            }
        }
        return false
    }

    /// Reads a base-class signature with its declaration's nullable metadata.
    /// @param declaration The reflected open or constructed declaring type.
    /// @param project An optional receiver-aware projection of the open base layout.
    /// @returns The annotated base type, or null when there is no base.
    @NullabilityFunnel
    internal func GetBaseTypeSymbol(declaration Type, project Func[Type, TypeSymbol]? = nil) TypeSymbol? {
        let actual = declaration.BaseType
        if actual == nil {
            return nil
        }
        let definition = if declaration.IsGenericType {
            declaration.GetGenericTypeDefinition()
        } else {
            declaration
        }
        let layout = definition.BaseType ?? actual
        let flags = ReadNullableFlags(definition, definition)
        if project is {} projector {
            return NullableFlagsBuilder.MergeDeclarationNullability(projector(layout), layout, flags)
        }
        return SymbolFromLayoutFlags(actual, layout, flags)
    }

    /// Reads the declared interfaces and their InterfaceImpl annotations.
    /// @param declaration The reflected declaring type.
    /// @param project An optional receiver-aware projection.
    /// @returns Annotated direct interface signatures in metadata order.
    @NullabilityFunnel
    internal func GetInterfaceTypeSymbols(declaration Type, project Func[Type, TypeSymbol]? = nil) ImmutableArray[
        TypeSymbol
    ] {
        return ClrSignatureMetadata
            .Interfaces(declaration)
            .Select(
            (row(Layout Type, Flags ImmutableArray[uint8])) -> if project is {} projector {
                NullableFlagsBuilder.MergeDeclarationNullability(projector(row.Layout), row.Layout, row.Flags)
            } else {
                SymbolFromLayoutFlags(row.Layout, row.Layout, row.Flags)
            }
        )
            .ToImmutableArray()
    }

    /// Reads annotated type bounds of a type or method parameter.
    /// @param parameter The reflected generic parameter.
    /// @param project An optional receiver-aware projection.
    /// @returns Annotated constraints in metadata order.
    @NullabilityFunnel
    internal func GetGenericParameterConstraintTypeSymbols(
        parameter Type,
        project Func[Type, TypeSymbol]? = nil
    ) ImmutableArray[TypeSymbol] {
        return ClrSignatureMetadata
            .Constraints(parameter)
            .Select(
            (row(Layout Type, Flags ImmutableArray[uint8])) -> if project is {} projector {
                NullableFlagsBuilder.MergeDeclarationNullability(projector(row.Layout), row.Layout, row.Flags)
            } else {
                SymbolFromLayoutFlags(row.Layout, row.Layout, row.Flags)
            }
        )
            .ToImmutableArray()
    }

    /// Reads the full `[NullableAttribute]` byte array for a declaration,
    /// falling back to a single-element array derived from the surrounding
    /// `[NullableContextAttribute]` when no explicit `[Nullable]` is
    /// present. Returns an empty array when no annotation is found at all.
    /// @param declaration The attribute provider to inspect (parameter, return parameter, etc.).
    /// @param enclosingMember The enclosing member used to walk up to `[NullableContext]`.
    /// @returns The full byte array, or an empty array when no annotation is available.
    @NullabilityFunnel
    internal func ReadNullableFlags(declaration ICustomAttributeProvider, enclosingMember MemberInfo?) ImmutableArray[
        uint8
    ] {
        CompilationMeasurements.Count("metadata.contract-requests")
        let own = ReadRawNullableFlags(declaration, context: false)
        if !own.IsDefault {
            return own
        }
        return ReadNullableContext(enclosingMember)
    }

    @NullabilityFunnel
    internal func ReadNullableContext(enclosingMember MemberInfo?) ImmutableArray[uint8] {
        for var member MemberInfo? = enclosingMember; member != nil; member = member!!.DeclaringType {
            let context = ReadRawNullableFlags(member, context: true)
            if !context.IsDefault {
                return context
            }
        }
        return ImmutableArray[uint8].Empty
    }

    private func ReadRawNullableFlags(declaration ICustomAttributeProvider, context bool) ImmutableArray[uint8] {
        let cache = if context {
            NullableContextCache
        } else {
            NullableFlagsCache
        }
        if cache.TryGetValue(declaration, out var cached) {
            return cached.Value
        }
        let attrs IList[CustomAttributeData]? = SafeGetCustomAttributesData(declaration)
        if attrs == nil {
            // Failed metadata reads remain retryable, unlike a successfully decoded absence.
            return default(ImmutableArray[uint8])
        }
        CompilationMeasurements.Count(
            if context {
                "metadata.context-decodes"
            } else {
                "metadata.nullable-decodes"
            }
        )
        var flags = default(ImmutableArray[uint8])
        let attributeName = if context {
            NullableContextAttributeFullName
        } else {
            NullableAttributeFullName
        }
        for ad in attrs {
            if ad.AttributeType?.FullName != attributeName || ad.ConstructorArguments.Count != 1 {
                continue
            }
            let arg = ad.ConstructorArguments[0]
            if arg.Value is uint8 b {
                flags = ImmutableArray.Create(b)
                break
            }
            if !context && arg.Value is ReadOnlyCollection[CustomAttributeTypedArgument]arr {
                let builder = ImmutableArray.CreateBuilder[uint8](arr.Count)
                for elem in arr {
                    if elem.Value is uint8 eb {
                        builder.Add(eb)
                    }
                }
                flags = builder.ToImmutable()
                break
            }
        }
        cache.GetValue(declaration, (_ ICustomAttributeProvider) -> RawFlags(flags))
        return flags
    }

    /// Counts the number of bytes the C# compiler emits for [`type`](paramref)
    /// in a `[NullableAttribute]` byte array. The count follows the CLR
    /// DFS pre-order layout: reference and array positions contribute one byte,
    /// as does a closed generic value type's leading oblivious placeholder.
    /// `Nullable<T>` is transparent and contributes only T's
    /// subtree; generic parameters contribute one slot (forced to `0`
    /// for a struct constraint); non-generic value types contribute none.
    /// @param type The CLR type to measure.
    /// @returns The number of nullability bytes this type occupies.
    internal func CountNullabilityBytes(type Type?) int32 {
        if type == nil {
            return 0
        }
        if NullableLifting.GetValueTypeNullableUnderlyingClr(type) is {} nullableUnderlying {
            return CountNullabilityBytes(nullableUnderlying)
        }
        if type.IsGenericParameter {
            return 1
        }
        if type.IsByRef {
            return CountNullabilityBytes(type.GetElementType())
        }
        if type.IsPointer {
            return 1 + CountNullabilityBytes(type.GetElementType())
        }
        if type.IsFunctionPointer {
            var count = 1 + CountNullabilityBytes(type.GetFunctionPointerReturnType())
            for parameter in type.GetFunctionPointerParameterTypes() {
                count += CountNullabilityBytes(parameter)
            }
            return count
        }
        if type.IsArray {
            return 1 +
                CountNullabilityBytes(
                Invariant.Required(
                    type.GetElementType(),
                    "an array type has an element type",
                    expression: "type.GetElementType()"
                )
            )
        }
        let isClosedGeneric = type.IsGenericType && !type.IsGenericTypeDefinition
        var count = if !type.IsValueType || isClosedGeneric {
            1
        } else {
            0
        }
        if isClosedGeneric {
            for arg in type.GetGenericArguments() {
                count += CountNullabilityBytes(arg)
            }
        }
        return count
    }

    /// Returns whether a reflected generic parameter carries the CLR
    /// non-nullable value-type (`struct`) constraint.
    /// @param type Reflected type to inspect.
    /// @returns `true` for a struct-constrained generic parameter.
    internal func IsNotNullableValueTypeParameter(type Type) bool {
        return type.IsGenericParameter &&
            (type.GenericParameterAttributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0
    }

    /// Returns nullability flags rooted at a nested type. Scalar and empty
    /// forms are kept intact because they apply semantically to every position;
    /// physical per-position arrays are sliced to the exact subtree width.
    /// @param type Nested CLR type.
    /// @param flags Flags for the containing type tree.
    /// @param offset Nested type's DFS offset.
    /// @returns Flags rooted at [`type`](paramref).
    internal func GetNullableFlagsForSubtree(type Type, flags ImmutableArray[uint8], offset int32) ImmutableArray[
        uint8
    ] {
        if flags.Length <= 1 {
            return flags
        }
        return flags.Skip(offset).Take(CountNullabilityBytes(type)).ToImmutableArray()
    }

    /// Expands scalar, context-only, or absent nullable metadata to the CLR
    /// per-position layout for [`type`](paramref). Generic value-type
    /// placeholders are emitted as oblivious byte `0`, while
    /// metadata-transparent `Nullable<T>` recurses directly into T.
    /// Struct-constrained generic parameters likewise force a `0` slot.
    /// Empty and missing positions use the importer's current reading rule and
    /// expand to (cref:DefaultAbsentFill) — byte `0` (oblivious)
    /// under ADR-0186's platform-types mode, which is the default since step 3,
    /// and byte `2` (nullable-by-default, ADR-0136) under
    /// `--nullability=enabled`.
    /// @param type CLR type tree to expand.
    /// @param flags Physical nullable flags, possibly scalar or empty.
    /// @returns One byte per CLR nullable-metadata position.
    internal func ExpandNullableFlags(type Type, flags ImmutableArray[uint8]) ImmutableArray[
        uint8
    ] -> ExpandNullableFlags(type, flags, absentFill: DefaultAbsentFill())

    /// Issue #3705 family 2: (cref:ExpandNullableFlags(Type, ImmutableArray{byte}))
    /// with an explicit fill for positions the declaration did not supply.
    ///
    /// The fill the two-argument overload chooses IS the reading rule. Under
    /// `--nullability=enabled` it is `2` — the #1354 rule, "the
    /// declarer said nothing, so assume nullable" — and under ADR-0186's
    /// platform-types mode, the default since step 3, it is `0`
    /// (see (cref:DefaultAbsentFill)). Either way it is right for a
    /// concrete reference position and wrong for an OPEN type-parameter
    /// position, whose nullability comes from the substituted argument
    /// instead. A caller that must distinguish "the declaration explicitly
    /// said `2`" from "the declaration was silent and the ADR-0136
    /// reading defaulted it to `2`" cannot do it from the default
    /// expansion, because both look identical. Passing `absentFill: 0`
    /// yields the literal reading in either mode.
    ///
    /// A scalar or context byte is a genuine statement about every position and
    /// is preserved under both fills; only truly absent and beyond-length
    /// positions differ.
    /// @param type CLR type tree to expand.
    /// @param flags Physical nullable flags, possibly scalar or empty.
    /// @param absentFill Byte to use for positions the declaration did not supply.
    /// @returns One byte per CLR nullable-metadata position.
    internal func ExpandNullableFlags(type Type, flags ImmutableArray[uint8], absentFill uint8) ImmutableArray[uint8] {
        let GetFlag = func (position int32) uint8 {
            if flags.IsDefaultOrEmpty {
                return absentFill
            }
            if flags.Length == 1 {
                return flags[0]
            }
            return if position < flags.Length {
                flags[position]
            } else {
                absentFill
            }
        }
        let builder = ImmutableArray.CreateBuilder[uint8](CountNullabilityBytes(type))
        var index = 0
        let Append = func (current Type) {
            if NullableLifting.GetValueTypeNullableUnderlyingClr(current) is {} nullableUnderlying {
                Append(nullableUnderlying)
                return
            }
            if current.IsGenericParameter {
                builder.Add(
                    if IsNotNullableValueTypeParameter(current) {
                        uint8(0)
                    } else {
                        GetFlag(index)
                    }
                )
                index++
                return
            }
            if current.IsByRef {
                Append(current.GetElementType()!!)
                return
            }
            if current.IsPointer || current.IsFunctionPointer {
                builder.Add(uint8(0))
                index++
                if current.IsPointer {
                    Append(current.GetElementType()!!)
                } else {
                    Append(current.GetFunctionPointerReturnType())
                    for parameter in current.GetFunctionPointerParameterTypes() {
                        Append(parameter)
                    }
                }
                return
            }
            if current.IsArray {
                builder.Add(GetFlag(index))
                index++
                Append(
                    Invariant.Required(
                        current.GetElementType(),
                        "an array type has an element type",
                        expression: "current.GetElementType()"
                    )
                )
                return
            }
            let isClosedGeneric = current.IsGenericType && !current.IsGenericTypeDefinition
            if isClosedGeneric && current.IsValueType {
                builder.Add(uint8(0))
                index++
            } else if !current.IsValueType {
                builder.Add(GetFlag(index))
                index++
            }
            if isClosedGeneric {
                for argument in current.GetGenericArguments() {
                    Append(argument)
                }
            }
        }
        Append(type)
        return builder.MoveToImmutable()
    }

    /// Issue #1354: applies the "unannotated imported reference types are nullable
    /// by default" (Kotlin-style) reading rule to a single reference-type position.
    /// Given the nullable-flags array returned by (cref:ReadNullableFlags)
    /// and the DFS position [`index`](paramref):
    /// - [`flags`](paramref) empty (no `[Nullable]` and no `[NullableContext]` anywhere) → <b>nullable</b>
    /// (`T?`).
    /// - A single scalar/context byte (`flags.Length == 1`) applies to <b>every</b> position: non-null iff
    /// that byte is `1`.
    /// - A per-position array (`flags.Length > 1`): non-null iff `flags[index] == 1`.
    /// Only an explicit `1` (NotAnnotated) means a non-null reference type; `2`
    /// (Annotated), `0` (oblivious) and absent are all NOT non-null.
    ///
    /// ADR-0186 §2: this predicate is now a projection of
    /// (cref:ClassifyPosition), which is the real reader. It survives
    /// because "is this position non-null?" is a question several callers
    /// genuinely only need a `bool` for, and its answer is unchanged — but
    /// it is no longer sufficient on its own, because `false` now covers
    /// two different declarations (`T?` and `T!`). A caller that
    /// needs to tell them apart must ask (cref:ClassifyPosition).
    /// @param flags The nullable-flags byte array (possibly empty or scalar).
    /// @param index The DFS position index of the reference-type position.
    /// @returns `true` when the position is explicitly non-null.
    @NullabilityFunnel
    internal func IsPositionNonNull(flags ImmutableArray[uint8], index int32) bool -> ClassifyPosition(
        flags,
        index
    ) == ClrNullabilityState.NotAnnotated

    /// ADR-0186 §2 — <b>the</b> three-state classifier, and the successor to
    /// (cref:IsFlagNonNull)'s two-valued answer. Maps the DFS position
    /// [`index`](paramref) within [`flags`](paramref) onto what the
    /// declarer actually said about it:
    /// ```xmldoc
    /// <list type="table">
    /// <listheader><term><paramref name="flags" /> shape</term><description>Result</description></listheader>
    /// <item><term>empty (no <c>[Nullable]</c>, no <c>[NullableContext]</c> anywhere)</term>
    /// <description><see cref="ClrNullabilityState.Oblivious" /></description></item>
    /// <item><term>length 1, <c>flags[0] == 0</c> (oblivious context)</term>
    /// <description><see cref="ClrNullabilityState.Oblivious" /></description></item>
    /// <item><term>length 1, <c>flags[0] == 1</c></term>
    /// <description><see cref="ClrNullabilityState.NotAnnotated" /></description></item>
    /// <item><term>length 1, <c>flags[0] == 2</c></term>
    /// <description><see cref="ClrNullabilityState.Annotated" /></description></item>
    /// <item><term>length &gt; 1, <c>flags[index] == 0</c></term>
    /// <description><see cref="ClrNullabilityState.Oblivious" /></description></item>
    /// <item><term>length &gt; 1, <c>flags[index] == 1</c></term>
    /// <description><see cref="ClrNullabilityState.NotAnnotated" /></description></item>
    /// <item><term>length &gt; 1, <c>flags[index] == 2</c></term>
    /// <description><see cref="ClrNullabilityState.Annotated" /></description></item>
    /// <item><term>length &gt; 1, <c>index</c> beyond the array</term>
    /// <description><see cref="ClrNullabilityState.Oblivious" /> — the declaration
    /// supplied no byte for this position, which is the same statement as
    /// supplying none at all</description></item>
    /// </list>
    /// ```
    ///
    /// A scalar/context byte is a genuine statement about <em>every</em>
    /// position, so it is classified directly rather than treated as absent.
    /// @param flags The nullable-flags byte array (possibly empty or scalar).
    /// @param index The DFS position index of the reference-type position.
    /// @returns What the declaration says about that position.
    @NullabilityFunnel
    internal func ClassifyPosition(flags ImmutableArray[uint8], index int32) ClrNullabilityState {
        if flags.IsDefaultOrEmpty {
            // No annotation and no context anywhere → the declarer said nothing.
            return ClrNullabilityState.Oblivious
        }
        if flags.Length == 1 {
            // Scalar/context byte applies to every position.
            return ClassifyFlag(flags[0])
        }
        // Per-position array: index directly; beyond-length positions were
        // never described, which is obliviousness by another route.
        return if index < flags.Length {
            ClassifyFlag(flags[index])
        } else {
            ClrNullabilityState.Oblivious
        }
    }

    /// ADR-0186 §2: maps one C# nullable-metadata byte onto what it says. The
    /// per-byte half of (cref:ClassifyPosition), kept separate because
    /// `NullableFlagsBuilder` reads bytes out of an already-expanded array
    /// and so has no position to classify.
    ///
    /// Any byte other than `1` or `2` is (cref:ClrNullabilityState.Oblivious).
    /// That is not leniency: `0` <em>is</em> the oblivious byte, and csc
    /// emits no other value, so an unexpected byte can only mean the reader has
    /// been handed something it cannot interpret — for which "the declarer said
    /// nothing" is the honest reading and the safe one.
    /// @param flag A single C# nullable-metadata byte (0, 1 or 2).
    /// @returns What that byte says.
    @NullabilityFunnel
    internal func ClassifyFlag(flag uint8) ClrNullabilityState -> switch flag {
        case 1: ClrNullabilityState.NotAnnotated
        case 2: ClrNullabilityState.Annotated
        default: ClrNullabilityState.Oblivious
    }

    /// ADR-0186 §2: the single place that turns a
    /// (cref:ClrNullabilityState) into a G# type, and therefore the single
    /// cell of ADR-0136's table that this ADR changes.
    /// - (cref:ClrNullabilityState.NotAnnotated) → `T`.
    /// - (cref:ClrNullabilityState.Annotated) → `T?`.
    /// - (cref:ClrNullabilityState.Oblivious) → `T!` under (cref:NullabilityMode.PlatformTypes), and `T?`
    /// otherwise — ADR-0136's answer, which is what keeps `--nullability=platform-types` a genuine no-op
    /// while it is off.
    ///
    /// ADR-0193 §1: under platform types this is
    /// (cref:NullabilityImportRule.ApplyConcrete) — the rule, not a
    /// copy of it. The `--nullability=enabled` arm is the mode #4372
    /// retires, and it stays here, outside the rule, until then.
    /// @param baseSymbol The unwrapped position type.
    /// @param state What the declaration says about the position.
    /// @returns The nullability-aware type symbol.
    internal func SymbolForState(baseSymbol TypeSymbol, state ClrNullabilityState) TypeSymbol {
        if NullabilityOptions.PlatformTypesEnabled {
            return NullabilityImportRule.ApplyConcrete(baseSymbol, state)
        }
        return if state == ClrNullabilityState.NotAnnotated {
            baseSymbol
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(baseSymbol))
        }
    }

    /// Issue #1354, issue #3705 family 2 — <b>the</b> predicate that turns one
    /// C# nullable-metadata byte into G#'s answer, and the only place in the
    /// compiler allowed to decide it.
    ///
    /// G#'s import rule is the inverse of C#'s. C# reads "nullable iff the byte
    /// is `2`", so oblivious (`0`) and absent metadata mean non-null.
    /// G# reads "non-null iff the byte is `1`", so oblivious <b>and</b>
    /// absent both mean `T?`. Two readers open-coding the two rules is
    /// exactly how the #3705 nullability family kept producing member kinds
    /// that disagreed about the same declaration, so the rule lives here and
    /// (cref:IsPositionNonNull) and
    /// `NullableFlagsBuilder.MergeDeclarationNullability` both defer to it
    /// rather than comparing bytes themselves.
    ///
    /// ADR-0186 §2 preserves that single-predicate principle and gives it a
    /// third value: the byte classifier is now (cref:ClassifyFlag) and
    /// this predicate is a projection of it. G#'s rule "non-null iff the byte
    /// is `1`" is unchanged; what changed is that the <em>other</em> two
    /// answers are no longer the same answer, because `0`/absent means
    /// `T!` and only `2` means `T?`.
    /// @param flag A single C# nullable-metadata byte (0, 1 or 2).
    /// @returns `true` only for `1` (not-annotated).
    @NullabilityFunnel
    internal func IsFlagNonNull(flag uint8) bool -> ClassifyFlag(flag) == ClrNullabilityState.NotAnnotated

    /// Gets the declaration type with function-pointer calling conventions retained.
    internal func GetSignatureType(declaration ICustomAttributeProvider) Type {
        let type = switch declaration {
            case field is FieldInfo: field.FieldType
            case property is PropertyInfo: property.PropertyType
            case parameter is ParameterInfo: parameter.ParameterType
            default: throw ArgumentException("A field, property, or parameter declaration is required.")
        }
        if !ContainsFunctionPointer(type) {
            return type
        }
        return switch declaration {
            case field is FieldInfo: field.GetModifiedFieldType()
            case property is PropertyInfo: property.GetModifiedPropertyType()
            case parameter is ParameterInfo: parameter.GetModifiedParameterType()
            default: throw ArgumentException("A field, property, or parameter declaration is required.")
        }
    }

    internal func ContainsFunctionPointer(type Type) bool {
        if type.IsFunctionPointer || (type.HasElementType && ContainsFunctionPointer(type.GetElementType()!!)) {
            return true
        }
        if type.IsGenericType {
            for argument in type.GetGenericArguments() {
                if ContainsFunctionPointer(argument) {
                    return true
                }
            }
        }
        return false
    }

    /// Constructs a (cref:TypeSymbol) for [`clrType`](paramref) by
    /// reading the nullability byte at [`offset`](paramref) within
    /// [`flags`](paramref), and (for generic or array types with further
    /// inner bytes) wrapping the result in a
    /// (cref:NullabilityAnnotatedTypeSymbol).
    /// @param clrType The CLR type to map.
    /// @param flags The full nullable-flags byte array.
    /// @param offset The index within [`flags`](paramref) where this type's byte lives.
    /// @returns The appropriately-nullified (cref:TypeSymbol).
    @NullabilityFunnel
    internal func SymbolFromFlagsOffset(clrType Type, flags ImmutableArray[uint8], offset int32) TypeSymbol {
        if NullableLifting.GetValueTypeNullableUnderlyingClr(clrType) is {} nullableUnderlying {
            return NullableLifting.WrapValueTypeNullable(SymbolFromFlagsOffset(nullableUnderlying, flags, offset))
        }
        let baseSymbol = TypeSymbol.FromClrType(clrType)
        if ContainsFunctionPointer(clrType) {
            return NullableFlagsBuilder.MergeDeclarationNullability(
                baseSymbol,
                clrType,
                GetNullableFlagsForSubtree(clrType, flags, offset)
            )
        }
        if IsNotNullableValueTypeParameter(clrType) {
            return baseSymbol
        }
        // Issue #2176: pointers are not reference types — never nullable-wrap on import.
        if clrType.IsPointer || (baseSymbol is PointerTypeSymbol or FunctionPointerTypeSymbol) {
            return baseSymbol
        }
        if clrType.IsArray {
            if clrType.GetArrayRank() > 1 {
                let elementType = SymbolFromFlagsOffset(
                    Invariant.Required(
                        clrType.GetElementType(),
                        "an array type has an element type",
                        expression: "clrType.GetElementType()"
                    ),
                    flags,
                    offset + 1
                )
                let rectangular = RectangularArrayTypeSymbol.Get(elementType, clrType.GetArrayRank())
                return SymbolForState(rectangular, ClassifyPosition(flags, offset))
            }
            var array = baseSymbol
            if CountNullabilityBytes(clrType) > 1 {
                array = NullabilityAnnotatedTypeSymbol(baseSymbol, GetNullableFlagsForSubtree(clrType, flags, offset))
            }
            return SymbolForState(array, ClassifyPosition(flags, offset))
        }
        if clrType.IsValueType {
            if baseSymbol is TupleTypeSymbol && CountNullabilityBytes(clrType) > 1 {
                return BuildTupleTypeSymbol(clrType, flags, offset)
            }
            // A closed generic value type carries a leading zero placeholder.
            // Keep its annotation wrapper when arguments add further positions.
            if clrType.IsGenericType && !clrType.IsGenericTypeDefinition && CountNullabilityBytes(clrType) > 1 {
                return NullabilityAnnotatedTypeSymbol(baseSymbol, GetNullableFlagsForSubtree(clrType, flags, offset))
            }
            return baseSymbol
        }
        // Issue #1354: a reference position is non-null only for an explicit `1`.
        // ADR-0186 §2: the other two bytes are no longer the same answer —
        // `2` is `T?` and `0`/absent is `T!`. `SymbolForState` is where that
        // one changed cell lives, and while `--nullability=platform-types` is
        // off it still returns ADR-0136's `T?` for both.
        let state = ClassifyPosition(flags, offset)
        var result = SymbolForState(baseSymbol, state)
        // Propagate inner flags when the type is a closed generic.
        if clrType.IsGenericType && !clrType.IsGenericTypeDefinition && CountNullabilityBytes(clrType) > 1 {
            // Slice from `offset` so that NullabilityAnnotatedTypeSymbol.NullableFlags[0]
            // is the byte for this type itself, matching the layout convention.
            let slicedFlags = GetNullableFlagsForSubtree(clrType, flags, offset)
            let annotated = NullabilityAnnotatedTypeSymbol(baseSymbol, slicedFlags)
            result = SymbolForState(annotated, state)
        }
        return result
    }

    /// Decodes nullable flags described by an open metadata signature onto its
    /// reflected closed CLR type.
    /// @param actualType Closed reflected type to decode.
    /// @param layoutType Open metadata type that defines flag positions.
    /// @param flags Nullable flags in [`layoutType`](paramref) order.
    /// @returns Decoded closed type symbol.
    internal func SymbolFromLayoutFlags(actualType Type, layoutType Type, flags ImmutableArray[uint8]) TypeSymbol {
        // Function-pointer FullName is nil, so name equality cannot prove matching nullable layouts.
        let projectedFlags = if object.ReferenceEquals(actualType, layoutType) ||
            (
            !ContainsFunctionPointer(actualType) && !ContainsFunctionPointer(layoutType) && ClrTypeUtilities.AreSame(
                actualType,
                layoutType
            )
        ) {
            flags
        } else {
            ProjectNullableFlags(actualType, layoutType, flags)
        }
        return SymbolFromFlagsOffset(actualType, projectedFlags, 0)
    }

    /// Rewrites the nullable flags an open declaration carries
    /// ([`layoutType`](paramref) order) into the layout of the closed
    /// type [`actualType`](paramref) that substitutes it — the projection
    /// reader. Open slots resolve through
    /// (cref:NullabilityImportRule.ApplyOpenSlotToFlags) under platform
    /// types (ADR-0193 §1).
    /// @param actualType Closed reflected type to project onto.
    /// @param layoutType Open metadata type that defines flag positions.
    /// @param flags Nullable flags in [`layoutType`](paramref) order.
    /// @returns Flags in [`actualType`](paramref) order.
    @NullabilityFunnel
    internal func ProjectNullableFlags(actualType Type, layoutType Type, flags ImmutableArray[uint8]) ImmutableArray[
        uint8
    ] {
        let layoutFlags = ExpandNullableFlags(layoutType, flags)
        let builder = ImmutableArray.CreateBuilder[uint8]()
        var layoutOffset = 0
        let Append = func (actual Type, layout Type) {
            var actual = actual
            var layout = layout
            if NullableLifting.GetValueTypeNullableUnderlyingClr(actual) is {} actualUnderlying {
                actual = actualUnderlying
            }
            if NullableLifting.GetValueTypeNullableUnderlyingClr(layout) is {} layoutUnderlying {
                layout = layoutUnderlying
            }
            if actual.IsByRef && layout.IsByRef {
                Append(actual.GetElementType()!!, layout.GetElementType()!!)
                return
            }
            if layout.IsGenericParameter {
                let flag = layoutFlags[layoutOffset++]
                // ADR-0186 §2's open-type-parameter carve-out, applied to the
                // PROJECTION path — "Open type parameters keep ADR-0136's
                // exclusion, unchanged. An open slot still widens only for an
                // explicit `[Nullable(2)]`."
                //
                // This arm stamps the byte the OPEN declaration carries onto
                // the SUBSTITUTED argument, which is exactly what §2 says must
                // not happen for anything but an explicit `2`. Under ADR-0136
                // the mis-stamp was invisible: it produced `T?`, and
                // `Conversion.ClassifyCore` strips inner nullability before
                // any rule runs, so nothing downstream could tell. Under
                // ADR-0186 it produces `T!`, which §3 rule 3 treats as a
                // genuinely different constructed type — and the mis-stamp
                // becomes a compile error on ordinary code.
                //
                // Measured, twice, both reduced from the self-migration guard
                // and from `samples/`:
                //
                //   let a = t.GetConstructors().Cast[MethodBase]()
                //   let b = cast[IEnumerable[MethodBase]](t.GetMethods())
                //   let c = if true { a } else { b }
                //   // GS0263: "branches have no common result type — the true
                //   // branch is 'IEnumerable[MethodBase]' and the false branch
                //   // is 'IEnumerable[MethodBase]'"
                //
                // `Enumerable.Cast<TResult>`'s return carries byte `0` at its
                // unconstrained `TResult` slot (csc's encoding for an open
                // parameter that may be a value type), so `a` came back as
                // `IEnumerable[MethodBase!]` — obliviousness invented for a
                // position whose nullability arrives with the ARGUMENT, and a
                // diagnostic that named one type twice because a nested
                // argument's `!` did not reach the display (it does now:
                // `SymbolDisplay` renders nested platform arguments).
                // `Dictionary[string, int32].Enumerator` in
                // `samples/NestedTypeOfConstructedGeneric.gs` is the same
                // defect through the enclosing type's arguments.
                //
                // Gated on the mode, and that is deliberate rather than
                // timid: with `--nullability=enabled` the fabricated byte is
                // `2`, which is the answer ADR-0136 has given for its whole
                // life and which several emit and read paths are pinned to.
                // Changing it there would be an ADR-0136 semantics change
                // smuggled into an ADR-0186 step. Under platform types the
                // fabrication is observable, so §2's rule is applied and the
                // argument is left to speak for itself.
                //
                // NOT gated on whether the declaration described the slot,
                // and issue #4361 is what that gate cost. An earlier version
                // applied §2 only to an EXPLICIT `0` (the annotated BCL's
                // `Enumerable.Cast<TResult>`) and let an ABSENT byte — a
                // `#nullable disable` or netstandard2.0 assembly, which
                // carries no nullable metadata at all — fall through to this
                // expansion's own `0` fill and stamp `T!` onto the argument.
                // §2 draws no such line: an open slot is not a concrete
                // reference position however silent its declaration is, and
                // "absent" is precisely the case the rule was written for
                // (under ADR-0136 the same fabricated byte was a `2`). The
                // stamp made every open slot of an unannotated generic
                // produce a NESTED platform type, which §3 rule 3 then
                // correctly refused to convert:
                //
                //   var a []?string = Array.Empty[string]()      // netstandard2.0
                //   // GS0155: '[]string!' to '[]?string'
                //   let p = x ?? Enumerable.Empty[string]()
                //   // GS0129: '??' on 'IEnumerable[string]?' and 'IEnumerable[string!]!'
                //   let r []string = Array.FindAll(xs, pred)     // T inferred from `xs`
                //   return Arb.From(TypeGen)!!                   // FsCheck: 'Arbitrary[Type!]'
                //
                // — which is what took `main`'s nightly self-migration corpus
                // red (`Gsharp.NET.Sdk` targets netstandard2.0; `Core.Tests`
                // uses FsCheck). The argument really was `string` (explicit,
                // or inferred from a fully-typed `[]string`/`Gen[Type]`), so
                // `string!` was invented, not read.
                //
                // This is also the rule the MERGE reader already applies
                // (`NullableFlagsBuilder.MergeDeclarationNullability`'s
                // open-parameter arm: "Absent and oblivious leave it alone"),
                // so the projection path no longer disagrees with its sibling
                // about the same declaration — the #3705 family-2 shape
                // ADR-0136's single-predicate rule exists to prevent.
                //
                // The gate had been added for issue #4322: a `nil` tuple
                // element passed to an oblivious `params T[]` whose `T` is
                // inferred from a non-null sibling (`AnyEqual((nil, false),
                // ("x", false))`). With the argument winning, that call is
                // rejected exactly as the same call to a G#-declared
                // `func AnyEqual[T](values ...T)` always has been: `T` is
                // `(string, bool)`, and `nil -> string` is an error. It only
                // compiled before because the oblivious slot fabricated a
                // `T?` (ADR-0136) and then a `T!`; neither is §2's answer.
                // `Issue4044NilTupleInferenceTests` pins the parity.
                //
                // ADR-0193 §1: the platform-types decision is
                // `NullabilityImportRule`'s, not this arm's. Routing it there
                // also fixed a drift from the merge reader that the §4
                // reader-agreement test found: an explicit `2` used to be
                // expanded over EVERY position of the argument, so
                // `[Nullable(2)] TSource` at `TSource := List<string>` read
                // `List<string?>?` here and `List<string>?` through
                // `MergeDeclarationNullability`. The slot's `?` belongs to the
                // argument's root only, and a value-type argument takes none.
                if NullabilityOptions.PlatformTypesEnabled {
                    if NullabilityImportRule.IsUnsubstitutedSlot(actual, layout) {
                        // No substitution happened (see IsUnsubstitutedSlot):
                        // this arm's pre-ADR-0193 answer, which only an
                        // explicit `2` widens.
                        builder.Add(
                            if ClassifyFlag(flag) == ClrNullabilityState.Annotated {
                                uint8(2)
                            } else {
                                uint8(1)
                            }
                        )
                        return
                    }
                    builder.AddRange(NullabilityImportRule.ApplyOpenSlotToFlags(actual, ClassifyFlag(flag)))
                    return
                }
                builder.AddRange(ExpandNullableFlags(actual, ImmutableArray.Create(flag)))
                return
            }
            if actual.IsArray && layout.IsArray {
                builder.Add(layoutFlags[layoutOffset])
                layoutOffset++
                Append(
                    Invariant.Required(
                        actual.GetElementType(),
                        "an array type has an element type",
                        expression: "actual.GetElementType()"
                    ),
                    Invariant.Required(
                        layout.GetElementType(),
                        "an array type has an element type",
                        expression: "layout.GetElementType()"
                    )
                )
                return
            }
            if actual.IsPointer && layout.IsPointer {
                builder.Add(uint8(0))
                layoutOffset++
                Append(actual.GetElementType()!!, layout.GetElementType()!!)
                return
            }
            if actual.IsFunctionPointer && layout.IsFunctionPointer {
                builder.Add(uint8(0))
                layoutOffset++
                Append(actual.GetFunctionPointerReturnType(), layout.GetFunctionPointerReturnType())
                let actualParameters = actual.GetFunctionPointerParameterTypes()
                let layoutParameters = layout.GetFunctionPointerParameterTypes()
                for var i = 0; i < actualParameters.Length; i++ {
                    Append(actualParameters[i], layoutParameters[i])
                }
                return
            }
            let actualGeneric = actual.IsGenericType && !actual.IsGenericTypeDefinition
            let layoutGeneric = layout.IsGenericType && !layout.IsGenericTypeDefinition
            if actualGeneric && layoutGeneric && ClrTypeUtilities.AreSame(
                actual.UnderlyingSystemType.GetGenericTypeDefinition(),
                layout.UnderlyingSystemType.GetGenericTypeDefinition()
            ) {
                builder.Add(
                    if actual.IsValueType {
                        uint8(0)
                    } else {
                        layoutFlags[layoutOffset]
                    }
                )
                layoutOffset++
                let actualArguments = actual.GetGenericArguments()
                let layoutArguments = layout.GetGenericArguments()
                for var i = 0; i < actualArguments.Length; i++ {
                    Append(actualArguments[i], layoutArguments[i])
                }
                return
            }
            let actualCount = CountNullabilityBytes(actual)
            let layoutCount = CountNullabilityBytes(layout)
            if actualCount > 0 {
                let flag = if layoutCount > 0 {
                    layoutFlags[layoutOffset]
                } else {
                    uint8(1)
                }
                builder.AddRange(ExpandNullableFlags(actual, ImmutableArray.Create(flag)))
            }
            layoutOffset += layoutCount
        }
        Append(actualType, layoutType)
        return builder.ToImmutable()
    }

    /// ADR-0186 §2: returns the byte an absent position expands to, which is
    /// not a detail but <b>the rule itself</b> written as a value.
    ///
    /// ADR-0136 says an absent position means `T?`, so the fill is
    /// `2`. ADR-0186 says it means `T!`, so under
    /// (cref:NullabilityMode.PlatformTypes) the fill becomes `0` —
    /// the oblivious byte, which (cref:ClassifyPosition) then reads as
    /// (cref:ClrNullabilityState.Oblivious).
    ///
    /// This must track the mode, and an implementer who leaves it at `2`
    /// gets a silent drift rather than a failure: the layout/projection paths
    /// ((cref:SymbolFromLayoutFlags) → `ProjectNullableFlags`, and
    /// `NullableFlagsBuilder.MergeDeclarationNullability`'s
    /// `declaredFlags`) would expand an absent byte to `2` and read
    /// the position as `T?`, while the direct path
    /// ((cref:SymbolFromFlagsOffset) over the raw flags) reads the very
    /// same declaration as `T!`. Two readers disagreeing about one
    /// declaration is precisely the #3705 family-2 defect ADR-0136's
    /// single-predicate rule exists to prevent, and ADR-0186 explicitly
    /// preserves that rule.
    ///
    /// Platform-types is the default since ADR-0186 step 3, so `0` is the
    /// ordinary answer. Under `--nullability=enabled` this is the literal
    /// constant `2` the two-argument overload always used, so that mode
    /// keeps ADR-0136's reading unchanged.
    /// @returns The fill byte for positions the declaration did not supply.
    private func DefaultAbsentFill() uint8 -> if NullabilityOptions.PlatformTypesEnabled {
        uint8(0)
    } else {
        uint8(2)
    }

    private func BuildTupleTypeSymbol(clrType Type, flags ImmutableArray[uint8], offset int32) TupleTypeSymbol {
        return MapTupleTypeSymbol(
            clrType,
            offset,
            (argument Type, position int32) -> SymbolFromFlagsOffset(argument, flags, position)
        )
    }

    /// Maps flattened tuple positions through the CLR layout, including Rest placeholders.
    internal func MapTupleTypeSymbol(
        clrType Type,
        offset int32,
        project(Type, int32) -> TypeSymbol,
        names ImmutableArray[string?] = default(ImmutableArray[string?])
    ) TupleTypeSymbol {
        let elements = ImmutableArray.CreateBuilder[TypeSymbol]()
        var position = offset
        let AppendElements = func (tupleType Type) {
            position++ // Generic value-type placeholder.
            let arguments = tupleType.GetGenericArguments()
            let directCount = if arguments.Length == 8 {
                7
            } else {
                arguments.Length
            }
            for var i = 0; i < directCount; i++ {
                let argument = arguments[i]
                elements.Add(project(argument, position))
                position += CountNullabilityBytes(argument)
            }
            if arguments.Length == 8 {
                AppendElements(arguments[7])
            }
        }
        AppendElements(clrType)
        return TupleTypeSymbol.Get(elements.ToImmutable(), names)
    }

    @NullabilityFunnel
    private func ApplyReferenceNullabilityFull(
        baseSymbol TypeSymbol,
        clrType Type?,
        declaration ICustomAttributeProvider,
        enclosingMember MemberInfo?,
        layoutType Type? = nil
    ) TypeSymbol {
        if clrType == nil {
            return baseSymbol
        }
        let flags = ReadNullableFlags(declaration, enclosingMember)
        return if layoutType == nil {
            SymbolFromFlagsOffset(clrType, flags, 0)
        } else {
            SymbolFromLayoutFlags(clrType, layoutType, flags)
        }
    }

    private func ReadNotNullIfNotNullParameters(method MethodInfo)[]string {
        // Prefer the open metadata definition: on a constructed generic the
        // reflected `ReturnParameter` may not surface the attribute data.
        let definition = GetMetadataDefinition(method) as MethodInfo ?? method
        var names = ReadNotNullIfNotNullParameters(definition.ReturnParameter)
        if names.Length == 0 && !object.ReferenceEquals(definition, method) {
            names = ReadNotNullIfNotNullParameters(method.ReturnParameter)
        }
        return names
    }

    private func ReadNotNullIfNotNullParameters(returnParameter ParameterInfo?)[]string {
        if returnParameter == nil {
            return Array.Empty[string]()
        }
        let attrs IList[CustomAttributeData]? = SafeGetCustomAttributesData(returnParameter)
        if attrs == nil {
            return Array.Empty[string]()
        }
        var builder ImmutableArray[string].Builder? = nil
        for ad in attrs {
            if ad.AttributeType?.FullName != NotNullIfNotNullAttributeFullName || ad.ConstructorArguments.Count == 0 {
                continue
            }
            for arg in ad.ConstructorArguments {
                CollectStringOrArray(arg, &builder)
            }
        }
        return if builder == nil {
            Array.Empty[string]()
        } else {
            builder.ToArray()
        }
    }

    /// ADR-0193 §4: the open declaration of a field or property reached
    /// through a constructed generic type, whose type defines the positions
    /// the `[Nullable]` bytes describe — exactly as
    /// (cref:GetMetadataDefinition) is for a method. Reading a closed
    /// `Box<List<string>>.Value` against its own closed type
    /// misaligned the open declaration's bytes and stamped the slot's byte onto
    /// the argument (`string!` for an oblivious `T Value`), which the
    /// method and parameter readers stopped doing when they gained a layout;
    /// the reader-agreement test found the field and property readers never
    /// had one.
    /// @typeparam TMember The member kind.
    /// @param member The possibly-closed member.
    /// @returns The open member, or `null` when [`member`](paramref) is not on a constructed generic.
    private func GetOpenDefinition[TMember MemberInfo](member TMember) TMember? {
        let declaringType Type? = member.DeclaringType
        if declaringType == nil || !declaringType.IsGenericType || declaringType.IsGenericTypeDefinition {
            return nil
        }
        try {
            const All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
            return ClrTypeUtilities.FindMetadataDefinition(
                declaringType.GetGenericTypeDefinition(),
                member,
                All
            ) as TMember
        } catch (exception Exception) when exception is TypeLoadException ||
            exception is NotSupportedException ||
            exception is FileNotFoundException {
            // An unresolvable open definition reads as before: no layout.
            RecordMetadataReadFailure()
        }
        return nil
    }

    private func GetMetadataDefinition(method MethodBase) MethodBase? {
        var definition = method
        if method is MethodInfo genericMethod &&
            genericMethod.IsGenericMethod &&
            !genericMethod.IsGenericMethodDefinition {
            definition = genericMethod.GetGenericMethodDefinition()
        }
        let declaringType Type? = definition.DeclaringType
        if declaringType == nil || !declaringType.IsGenericType || declaringType.IsGenericTypeDefinition {
            return definition
        }
        let openType = declaringType.GetGenericTypeDefinition()
        let flags = if definition is ConstructorInfo {
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        } else {
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
        }
        return ClrTypeUtilities.FindMetadataDefinition(openType, definition, flags) as MethodBase ?? definition
    }

    private func TryGetBoolAttributeValue(parameter ParameterInfo, attributeFullName string, out value bool) bool {
        let attrs IList[CustomAttributeData]? = SafeGetCustomAttributesData(parameter)
        if attrs != nil {
            for ad in attrs {
                if ad
                    .AttributeType
                    ?.FullName == attributeFullName &&
                    ad
                    .ConstructorArguments
                    .Count == 1 &&
                    ad
                    .ConstructorArguments[0]
                    .Value is bool boolValue {
                    value = boolValue
                    return true
                }
            }
        }
        value = false
        return false
    }

    private func CollectStringOrArray(arg CustomAttributeTypedArgument, ref builder ImmutableArray[string].Builder?) {
        if arg.Value is string s && !string.IsNullOrEmpty(s) {
            (
                (
                    if builder == nil {
                        (builder = ImmutableArray.CreateBuilder[string]())
                    } else {
                        builder
                    }
                )!!
            ).Add(s)
        } else if arg.Value is ReadOnlyCollection[CustomAttributeTypedArgument]arr {
            for elem in arr {
                if elem.Value is string es && !string.IsNullOrEmpty(es) {
                    (
                        (
                            if builder == nil {
                                (builder = ImmutableArray.CreateBuilder[string]())
                            } else {
                                builder
                            }
                        )!!
                    ).Add(es)
                }
            }
        }
    }

    private func SafeGetCustomAttributesData(provider ICustomAttributeProvider) IList[CustomAttributeData]? {
        CompilationMeasurements.Count("metadata.attribute-requests")
        if AttributesCache.TryGetValue(provider, out var cached) {
            return cached
        }
        try {
            CompilationMeasurements.Count("metadata.attribute-reads")
            let attrs = switch provider {
                case mi is MemberInfo: mi.GetCustomAttributesData()?.ToList()
                case pi is ParameterInfo: pi.GetCustomAttributesData()?.ToList()
                default: default(List[CustomAttributeData]?)
            }
            return if attrs == nil {
                RecordMetadataReadFailure()
                default(IList[CustomAttributeData]?)
            } else {
                AttributesCache.GetValue(provider, (_ ICustomAttributeProvider) -> attrs)
            }
        } catch {
            RecordMetadataReadFailure()
            return nil
        }
    }
}
