// <copyright file="ExternalClrOverrideResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection

/// Resolves override declarations against virtual members inherited from an
/// imported CLR base class.
internal shared class ExternalClrOverrideResolver {
    private enum SourceSlotStatus {
        Missing,
        Implemented,
        AbstractMethod,
        AbstractAccessor
    }

    private enum AccessorKind {
        Getter,
        Setter,
        Add,
        Remove,
        Raise
    }

    internal data struct UnimplementedAbstractMember(
        DeclaringTypeName string,
        MemberName string,
        ReportedBySourceAbstractMethod bool
    ) : IEquatable[UnimplementedAbstractMember] { }

    internal struct MatchResult[T MemberInfo] {
        init(member T?, containingType TypeSymbol?, sawName bool, isSealed bool) {
            Member = member
            ContainingType = containingType
            SawName = sawName
            IsSealed = isSealed
        }

        prop Member T? {
            get;
        }

        prop ContainingType TypeSymbol? {
            get;
        }

        prop SawName bool {
            get;
        }

        prop IsSealed bool {
            get;
        }
    }

    private data struct TypeArgumentSubstitution(
        OpenDefinition Type?,
        TypeArguments ImmutableArray[TypeSymbol]
    ) : IEquatable[TypeArgumentSubstitution] { }

    internal func FindMethod(
        derivedType StructSymbol,
        name string,
        parameters ImmutableArray[ParameterSymbol],
        returnType TypeSymbol,
        returnRefKind RefKind,
        typeParameters ImmutableArray[TypeParameterSymbol],
        accessibility Accessibility,
        isAsync bool,
        isAsyncVoid bool,
        isValueTask bool,
        isSuspending bool,
        references ReferenceResolver
    ) MatchResult[MethodInfo] {
        var sawName = false
        let externalBase = FindExternalBaseType(derivedType)
        let reflectionBaseType = GetReflectionBaseType(externalBase)
        let typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase)
        let methodTypeArguments = BuildMethodTypeArguments(typeParameters)
        for method in EnumerateMethods(reflectionBaseType, name) {
            if !IsAccessibleOverrideTarget(method, accessibility, references) {
                continue
            }
            sawName = true
            // Issue #4413 / ADR-0174: compare imported G# suspend methods by
            // their source signature, while retaining the physical MethodInfo
            // for the emitted MethodImpl.
            let methodParameters = ImportedFunctionSymbol.GetLogicalParameters(method, out var hasHiddenContext)
            let importedIsSuspending = ImportedFunctionSymbol.IsSuspendingMethod(method)
            if importedIsSuspending != isSuspending || (importedIsSuspending && !hasHiddenContext) {
                continue
            }
            if method.GetGenericArguments()
                .Length != typeParameters.Length ||
                !ParametersMatch(methodParameters, parameters, typeSubstitutions, method, methodTypeArguments) ||
                !ReturnMatches(
                ClrNullability.GetSignatureType(method.ReturnParameter),
                returnType,
                returnRefKind,
                typeSubstitutions,
                method,
                methodTypeArguments,
                isAsync || isSuspending,
                isAsyncVoid,
                isValueTask || isSuspending,
                allowCovariantReturn: !isSuspending
            ) {
                continue
            }
            if !method.IsVirtual || method.IsFinal {
                return MatchResult[MethodInfo](nil, externalBase, sawName, isSealed: true)
            }
            return MatchResult[MethodInfo](method, externalBase, sawName, isSealed: false)
        }
        return MatchResult[MethodInfo](nil, externalBase, sawName, isSealed: false)
    }

    internal func FindProperty(
        derivedType StructSymbol,
        name string,
        indexParameters ImmutableArray[ParameterSymbol],
        propertyType TypeSymbol,
        hasGetter bool,
        hasSetter bool,
        isInitOnly bool,
        getterAccessibility Accessibility,
        setterAccessibility Accessibility,
        references ReferenceResolver,
        returnRefKind RefKind = RefKind.None
    ) MatchResult[PropertyInfo] {
        var sawName = false
        let externalBase = FindExternalBaseType(derivedType)
        let reflectionBaseType = GetReflectionBaseType(externalBase)
        let typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase)
        for property in EnumerateProperties(reflectionBaseType, name) {
            let getter MethodInfo? = property.GetGetMethod(nonPublic: true)
            let setter MethodInfo? = property.GetSetMethod(nonPublic: true)
            if getter == nil && setter == nil {
                continue
            }
            if (hasGetter && getter == nil) ||
                (hasSetter && setter == nil) ||
                (!hasGetter && getter != nil) ||
                (!hasSetter && setter != nil) ||
                (getter != nil && !IsAccessibleOverrideTarget(getter, getterAccessibility, references)) ||
                (setter != nil && !IsAccessibleOverrideTarget(setter, setterAccessibility, references)) {
                continue
            }
            sawName = true
            if setter != nil && ImportedTypeSymbol.IsInitOnlySetter(setter) != isInitOnly {
                continue
            }
            // Issue #3879: the by-ref return is part of the property signature,
            // not a decoration on it. A CLR by-ref property reports its type as
            // `T&`, so BOTH halves have to be compared against the G# side —
            // the ref-kind, and then the POINTEE against the declared type.
            // Without this an `override prop P ref T` silently matched a
            // by-value base slot (and a real override of an external `T&`
            // property could never match, because `T&` never equals `T`).
            // A mismatch falls through to the `sawName` arm below, which is the
            // signature-mismatch diagnostic rather than "no base to override".
            let signatureType = ClrNullability.GetSignatureType(property)
            let externalIsByRef = signatureType.IsByRef
            if RefCapabilities.GetReturnRefKind(property) != returnRefKind {
                continue
            }
            let comparablePropertyType = if externalIsByRef {
                signatureType.GetElementType()
            } else {
                signatureType
            }
            if !ParametersMatch(property.GetIndexParameters(), indexParameters, typeSubstitutions) ||
                !PropertyTypeMatches(comparablePropertyType, propertyType, hasSetter, typeSubstitutions) {
                continue
            }
            if (getter != nil && (!getter.IsVirtual || getter.IsFinal)) ||
                (setter != nil && (!setter.IsVirtual || setter.IsFinal)) {
                return MatchResult[PropertyInfo](nil, externalBase, sawName, isSealed: true)
            }
            return MatchResult[PropertyInfo](property, externalBase, sawName, isSealed: false)
        }
        return MatchResult[PropertyInfo](nil, externalBase, sawName, isSealed: false)
    }

    internal func FindEvent(
        derivedType StructSymbol,
        name string,
        handlerType TypeSymbol,
        accessibility Accessibility,
        references ReferenceResolver
    ) MatchResult[EventInfo] {
        var sawName = false
        let externalBase = FindExternalBaseType(derivedType)
        let reflectionBaseType = GetReflectionBaseType(externalBase)
        let typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase)
        for eventInfo in EnumerateEvents(reflectionBaseType, name) {
            let add MethodInfo? = eventInfo.GetAddMethod(nonPublic: true)
            let remove MethodInfo? = eventInfo.GetRemoveMethod(nonPublic: true)
            let raise MethodInfo? = eventInfo.GetRaiseMethod(nonPublic: true)
            if (add == nil && remove == nil) ||
                (add != nil && !IsAccessibleOverrideTarget(add, accessibility, references)) ||
                (remove != nil && !IsAccessibleOverrideTarget(remove, accessibility, references)) ||
                (raise != nil && !IsAccessibleOverrideTarget(raise, accessibility, references)) {
                continue
            }
            sawName = true
            if !TypeMatches(eventInfo.EventHandlerType, handlerType, typeSubstitutions) {
                continue
            }
            if (add != nil && (!add.IsVirtual || add.IsFinal)) ||
                (remove != nil && (!remove.IsVirtual || remove.IsFinal)) {
                return MatchResult[EventInfo](nil, externalBase, sawName, isSealed: true)
            }
            return MatchResult[EventInfo](eventInfo, externalBase, sawName, isSealed: false)
        }
        return MatchResult[EventInfo](nil, externalBase, sawName, isSealed: false)
    }

    internal func GetUnimplementedAbstractMembers(derivedType StructSymbol) ImmutableArray[
        UnimplementedAbstractMember
    ] {
        let externalBase = FindDeclaredExternalBaseType(derivedType)
        let reflectionBaseType Type? = GetReflectionBaseType(externalBase)
        if reflectionBaseType == nil || !reflectionBaseType.IsAbstract {
            return ImmutableArray[UnimplementedAbstractMember].Empty
        }
        let typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase)
        var builder ImmutableArray[UnimplementedAbstractMember].Builder? = nil
        for slot in GetEffectiveAbstractSlots(reflectionBaseType, typeSubstitutions) {
            let sourceStatus = GetSourceSlotStatus(derivedType, slot)
            if sourceStatus == SourceSlotStatus.Implemented {
                continue
            }
            builder ??= ImmutableArray.CreateBuilder[UnimplementedAbstractMember]()
            builder!!.Add(
                UnimplementedAbstractMember(
                    GetDeclaringTypeDisplayName(slot.DeclaringType),
                    GetMemberDisplayName(slot),
                    sourceStatus == SourceSlotStatus.AbstractMethod
                )
            )
        }
        return builder?.ToImmutable() ?? ImmutableArray[UnimplementedAbstractMember].Empty
    }

    internal func HasUnimplementedAbstractMembers(derivedType StructSymbol) bool -> !GetUnimplementedAbstractMembers(
        derivedType
    ).IsDefaultOrEmpty

    private func FindDeclaredExternalBaseType(type StructSymbol) TypeSymbol? {
        for current in GetStructHierarchy(type) {
            if current.ImportedBaseType != nil {
                return current.ImportedBaseType!!
            }
        }
        return nil
    }

    private func FindExternalBaseType(type StructSymbol?) TypeSymbol? {
        let declaredBase TypeSymbol? = FindDeclaredExternalBaseType(type!!)
        if declaredBase != nil {
            return declaredBase
        }
        for current in GetStructHierarchy(type!!) {
            if current.IsAttributeClass {
                // Attribute sugar emits System.Attribute rather than the CLR
                // implicit Object base handled by this fallback.
                return nil
            }
        }
        return if type != nil {
            TypeSymbol.Object
        } else {
            default(TypeSymbol?)
        }
    }

    private func GetEffectiveAbstractSlots(
        reflectionBaseType Type,
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution]
    ) ImmutableArray[MethodInfo] {
        let hierarchy = GetTypeHierarchy(reflectionBaseType)
        hierarchy.Reverse()
        // Reconstruct effective CLR virtual slots base-first. A newslot method
        // must not satisfy a same-signature abstract slot hidden beneath it.
        let slots = List[MethodInfo]()
        for current in hierarchy {
            let declaredMethods = ClrTypeUtilities.SafeGetMethods(
                current,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )
            for method in declaredMethods {
                if method.IsStatic || !method.IsVirtual {
                    continue
                }
                if ClrTypeUtilities.SafeIsOverride(method) {
                    var overriddenSlot = -1
                    for var i = slots.Count - 1; i >= 0; i-- {
                        if SlotSignaturesMatch(method, slots[i], typeSubstitutions) {
                            overriddenSlot = i
                            break
                        }
                    }
                    if overriddenSlot >= 0 {
                        slots[overriddenSlot] = method
                        continue
                    }
                }
                slots.Add(method)
            }
        }
        let abstractSlots = ImmutableArray.CreateBuilder[MethodInfo]()
        for method in slots {
            if method.IsAbstract {
                abstractSlots.Add(method)
            }
        }
        return abstractSlots.ToImmutable()
    }

    @NullabilityFunnel
    private func SlotSignaturesMatch(
        derived MethodInfo,
        baseMethod MethodInfo,
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution]
    ) bool {
        var derived = derived
        var baseMethod = baseMethod
        derived = GetOpenDeclaringMethod(derived)
        baseMethod = GetOpenDeclaringMethod(baseMethod)
        if !string.Equals(derived.Name, baseMethod.Name, StringComparison.Ordinal) {
            return false
        }
        let derivedMethodArguments = derived.GetGenericArguments()
        let baseMethodArguments = baseMethod.GetGenericArguments()
        if derivedMethodArguments.Length != baseMethodArguments.Length {
            return false
        }
        let derivedParameters = derived.GetParameters()
        let baseParameters = baseMethod.GetParameters()
        if derivedParameters.Length != baseParameters.Length {
            return false
        }
        let canonicalMethodArguments = BuildCanonicalMethodTypeArguments(derivedMethodArguments.Length)
        let derivedSubstitution = FindTypeArgumentSubstitution(derived.DeclaringType, typeSubstitutions)
        let baseSubstitution = FindTypeArgumentSubstitution(baseMethod.DeclaringType, typeSubstitutions)
        for var i = 0; i < derivedParameters.Length; i++ {
            // ADR-0193 Phase 2: [NullabilityFunnel] on purpose. A CLR override
            // slot is matched by signature identity, which carries no
            // nullability — C# lets an override differ from its base in
            // annotations alone — so both sides are projected unmerged and
            // compared as shapes.
            let derivedType = MemberLookup.MapOpenClrTypeToSymbolic(
                ClrNullability.GetSignatureType(derivedParameters[i]),
                derivedSubstitution.OpenDefinition,
                derivedSubstitution.TypeArguments,
                derived,
                canonicalMethodArguments
            )
            let baseType = MemberLookup.MapOpenClrTypeToSymbolic(
                ClrNullability.GetSignatureType(baseParameters[i]),
                baseSubstitution.OpenDefinition,
                baseSubstitution.TypeArguments,
                baseMethod,
                canonicalMethodArguments
            )
            if !DeclarationBinder.TypeSignaturesEquivalent(derivedType, baseType) {
                return false
            }
        }
        return true
    }

    private func GetOpenDeclaringMethod(method MethodInfo) MethodInfo {
        let declaringType = method.DeclaringType
        if !(
            declaringType != nil &&
                declaringType.IsGenericType == true &&
                declaringType.IsGenericTypeDefinition == false
        ) {
            return method
        }
        try {
            let openDefinition = declaringType.GetGenericTypeDefinition()
            for candidate in ClrTypeUtilities.SafeGetMethods(
                openDefinition,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            ) {
                if candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module {
                    return candidate
                }
            }
        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) { }
        return method
    }

    private func BuildCanonicalMethodTypeArguments(arity int32) ImmutableArray[TypeSymbol?] {
        if arity == 0 {
            return default(ImmutableArray[TypeSymbol?])
        }
        let builder = ImmutableArray.CreateBuilder[TypeSymbol?](arity)
        for var i = 0; i < arity; i++ {
            builder.Add(
                TypeParameterSymbol("T$i", i, TypeParameterConstraint.Any, TypeParameterVariance.None){
                    IsMethodTypeParameter = true
                }
            )
        }
        return builder.MoveToImmutable()
    }

    private func FindTypeArgumentSubstitution(
        declaringType Type?,
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution]
    ) TypeArgumentSubstitution {
        let declaringDefinition Type? = GetGenericDefinition(declaringType)
        if declaringDefinition == nil {
            return default(TypeArgumentSubstitution)
        }
        for substitution in typeSubstitutions {
            if ClrTypeUtilities.AreSame(GetGenericDefinition(substitution.OpenDefinition), declaringDefinition) {
                return substitution
            }
        }
        return default(TypeArgumentSubstitution)
    }

    private func GetGenericDefinition(type Type?) Type? -> if type?.IsGenericType == true {
        (
            if type!!.IsGenericTypeDefinition {
                type
            } else {
                type!!.GetGenericTypeDefinition()
            }
        )
    } else {
        type
    }

    // Issue #4164: this used to be its own unguarded copy of the hierarchy
    // walk, independently reachable (via FindMethod/FindProperty/FindEvent)
    // during declaration-time `override func`/`override prop`/`override
    // event` base-member lookup, before the post-bind cycle detector (#973)
    // has run. Forwards to StructSymbol's single guarded walk (fixed by
    // #4162) instead of keeping a second copy that can drift out of sync
    // with its fix again.
    private func GetStructHierarchy(type StructSymbol) List[StructSymbol] -> type.GetHierarchy()

    private func GetTypeHierarchy(type Type?) List[Type] {
        let hierarchy = List[Type]()
        var current Type? = type
        while current != nil {
            hierarchy.Add(current)
            current = current.BaseType
        }
        return hierarchy
    }

    private func GetSourceSlotStatus(derivedType StructSymbol, slot MethodInfo) SourceSlotStatus {
        for current in GetStructHierarchy(derivedType) {
            for method in current.Methods {
                if TargetsExternalSlot(method, slot) {
                    return if method.IsAbstract {
                        SourceSlotStatus.AbstractMethod
                    } else {
                        SourceSlotStatus.Implemented
                    }
                }
            }
            for property in current.Properties {
                if TryGetPropertyAccessorKind(property, slot, out var accessorKind) {
                    return if IsPropertyAccessorImplemented(property, accessorKind) {
                        SourceSlotStatus.Implemented
                    } else {
                        SourceSlotStatus.AbstractAccessor
                    }
                }
            }
            for eventSymbol in current.Events {
                if TryGetEventAccessorKind(eventSymbol, slot, out var accessorKind) {
                    return if IsEventAccessorImplemented(eventSymbol, accessorKind) {
                        SourceSlotStatus.Implemented
                    } else {
                        SourceSlotStatus.AbstractAccessor
                    }
                }
            }
        }
        return SourceSlotStatus.Missing
    }

    private func TargetsExternalSlot(method FunctionSymbol, slot MethodInfo) bool {
        var current FunctionSymbol? = method
        while current != nil {
            if SameMethod(current.ExternalOverriddenMethod, slot) {
                return true
            }
            current = current.OverriddenMethod
        }
        return false
    }

    private func TryGetPropertyAccessorKind(
        property PropertySymbol,
        slot MethodInfo,
        out accessorKind AccessorKind
    ) bool {
        var current PropertySymbol? = property
        while current != nil {
            if SameMethod(current.ExternalOverriddenGetter, slot) {
                accessorKind = AccessorKind.Getter
                return true
            }
            if SameMethod(current.ExternalOverriddenSetter, slot) {
                accessorKind = AccessorKind.Setter
                return true
            }
            current = current.OverriddenProperty
        }
        accessorKind = default(AccessorKind)
        return false
    }

    private func IsPropertyAccessorImplemented(
        property PropertySymbol,
        accessorKind AccessorKind
    ) bool -> switch accessorKind {
        case AccessorKind.Getter: property.HasGetter &&
            (
            property.IsAutoProperty || property.GetterBodySyntax != nil || property.GetterSymbol is {IsAbstract: false}
        )
        case AccessorKind.Setter: property.HasSetter &&
            (
            property.IsAutoProperty || property.SetterBodySyntax != nil || property.SetterSymbol is {IsAbstract: false}
        )
        default: false
    }

    private func TryGetEventAccessorKind(eventSymbol EventSymbol, slot MethodInfo, out accessorKind AccessorKind) bool {
        var current EventSymbol? = eventSymbol
        while current != nil {
            if SameMethod(current.ExternalOverriddenAddMethod, slot) {
                accessorKind = AccessorKind.Add
                return true
            }
            if SameMethod(current.ExternalOverriddenRemoveMethod, slot) {
                accessorKind = AccessorKind.Remove
                return true
            }
            if SameMethod(current.ExternalOverriddenRaiseMethod, slot) {
                accessorKind = AccessorKind.Raise
                return true
            }
            current = current.OverriddenEvent
        }
        accessorKind = default(AccessorKind)
        return false
    }

    private func IsEventAccessorImplemented(
        eventSymbol EventSymbol,
        accessorKind AccessorKind
    ) bool -> switch accessorKind {
        case AccessorKind.Add: eventSymbol.IsFieldLike || eventSymbol.AddBodySyntax != nil
        case AccessorKind.Remove: eventSymbol.IsFieldLike || eventSymbol.RemoveBodySyntax != nil
        case AccessorKind.Raise: eventSymbol.RaiseBodySyntax != nil
        default: false
    }

    private func SameMethod(left MethodInfo?, right MethodInfo) bool {
        if left == nil {
            return false
        }
        if object.ReferenceEquals(left, right) {
            return true
        }
        try {
            return left.MetadataToken == right.MetadataToken && ClrTypeUtilities.AreSame(
                left.DeclaringType,
                right.DeclaringType
            )
        } catch (Exception) {
            return false
        }
    }

    private func GetDeclaringTypeDisplayName(declaringType Type?) string {
        let name = declaringType?.Name ?? "?"
        let arityMarker = name.IndexOf('`')
        return if arityMarker >= 0 {
            name[.. arityMarker]
        } else {
            name
        }
    }

    private func GetMemberDisplayName(slot MethodInfo) string {
        let name = slot.Name
        if name.StartsWith("get_", StringComparison.Ordinal) {
            return name[4 ..] + ".get"
        }
        if name.StartsWith("set_", StringComparison.Ordinal) {
            return name[4 ..] + ".set"
        }
        if name.StartsWith("add_", StringComparison.Ordinal) {
            return name[4 ..] + ".add"
        }
        if name.StartsWith("remove_", StringComparison.Ordinal) {
            return name[7 ..] + ".remove"
        }
        if name.StartsWith("raise_", StringComparison.Ordinal) {
            return name[6 ..] + ".raise"
        }
        return name
    }

    private func GetReflectionBaseType(importedBase TypeSymbol?) Type? -> if importedBase is ImportedTypeSymbol{
        OpenDefinition: not nil
    } imported &&
        imported.HasSubstitutableTypeArgument {
        imported.OpenDefinition
    } else {
        importedBase?.ClrType
    }

    private func GetSymbolicTypeArguments(importedBase TypeSymbol?) ImmutableArray[
        TypeSymbol
    ] -> if importedBase is ImportedTypeSymbol{OpenDefinition: not nil, HasSubstitutableTypeArgument: true} imported {
        imported.TypeArguments
    } else {
        ImmutableArray[TypeSymbol].Empty
    }

    private func BuildTypeArgumentSubstitutions(externalBase TypeSymbol?) ImmutableArray[TypeArgumentSubstitution] {
        let root = TypeArgumentSubstitution(GetReflectionBaseType(externalBase), GetSymbolicTypeArguments(externalBase))
        if externalBase is not ImportedTypeSymbol{OpenDefinition: not nil} imported ||
            imported
            .TypeArguments
            .IsDefaultOrEmpty {
            return ImmutableArray.Create(root)
        }
        let substitutions = ImmutableArray.CreateBuilder[TypeArgumentSubstitution]()
        substitutions.Add(root)
        for current in GetTypeHierarchy(imported.OpenDefinition!!.BaseType) {
            if !current.IsGenericType {
                continue
            }
            let openDefinition = if current.IsGenericTypeDefinition {
                current
            } else {
                current.GetGenericTypeDefinition()
            }
            if ClrTypeUtilities.AreSame(openDefinition, imported.OpenDefinition) ||
                !MemberLookup.TryMapConstructedTypeArgumentsThroughHierarchy(
                imported,
                openDefinition,
                out var mappedArguments
            ) {
                continue
            }
            substitutions.Add(TypeArgumentSubstitution(openDefinition, mappedArguments))
        }
        return substitutions.ToImmutable()
    }

    private func BuildMethodTypeArguments(typeParameters ImmutableArray[TypeParameterSymbol]) ImmutableArray[
        TypeSymbol?
    ] {
        if typeParameters.IsDefaultOrEmpty {
            return default(ImmutableArray[TypeSymbol?])
        }
        let typeArguments = ImmutableArray.CreateBuilder[TypeSymbol?](typeParameters.Length)
        for typeParameter in typeParameters {
            typeArguments.Add(typeParameter)
        }
        return typeArguments.MoveToImmutable()
    }

    private func EnumerateMethods(baseType Type?, name string) sequence[MethodInfo] {
        for var current Type? = baseType; current != nil; current = current!!.BaseType {
            var methods[]MethodInfo
            try {
                methods = current.GetMethods(
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
            } catch (ex Exception) when ex is NotSupportedException || ex is InvalidOperationException {
                continue
            }
            for method in methods {
                if string.Equals(method.Name, name, StringComparison.Ordinal) {
                    yield method
                }
            }
        }
    }

    private func EnumerateProperties(baseType Type?, name string) sequence[PropertyInfo] {
        for var current Type? = baseType; current != nil; current = current!!.BaseType {
            var properties[]PropertyInfo
            try {
                properties = current.GetProperties(
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
            } catch (ex Exception) when ex is NotSupportedException || ex is InvalidOperationException {
                continue
            }
            for property in properties {
                if string.Equals(property.Name, name, StringComparison.Ordinal) {
                    yield property
                }
            }
        }
    }

    private func EnumerateEvents(baseType Type?, name string) sequence[EventInfo] {
        for var current Type? = baseType; current != nil; current = current!!.BaseType {
            var events[]EventInfo
            try {
                events = current.GetEvents(
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
            } catch (ex Exception) when ex is NotSupportedException || ex is InvalidOperationException {
                continue
            }
            for eventInfo in events {
                if string.Equals(eventInfo.Name, name, StringComparison.Ordinal) {
                    yield eventInfo
                }
            }
        }
    }

    private func ParametersMatch(
        clrParameters[]ParameterInfo,
        parameters ImmutableArray[ParameterSymbol],
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution],
        openMethodDefinition MethodInfo? = nil,
        methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
    ) bool {
        if clrParameters.Length != parameters.Length {
            return false
        }
        for var i = 0; i < clrParameters.Length; i++ {
            let clrParameter = clrParameters[i]
            var clrType = ClrNullability.GetSignatureType(clrParameter)
            var clrRefKind = RefKind.None
            if clrType.IsByRef {
                clrRefKind = if clrParameter.IsOut {
                    RefKind.Out
                } else {
                    (
                        if clrParameter.IsIn {
                            RefKind.In
                        } else {
                            RefKind.Ref
                        }
                    )
                }
                clrType = clrType.GetElementType()!!
            }
            if clrRefKind != parameters[i].RefKind ||
                !TypeMatches(
                clrType,
                parameters[i].Type,
                typeSubstitutions,
                openMethodDefinition,
                methodTypeArguments
            ) {
                return false
            }
        }
        return true
    }

    private func ReturnMatches(
        clrReturnType Type?,
        returnType TypeSymbol,
        returnRefKind RefKind,
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution],
        openMethodDefinition MethodInfo? = nil,
        methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?]),
        isAsync bool = false,
        isAsyncVoid bool = false,
        isValueTask bool = false,
        allowCovariantReturn bool = true
    ) bool {
        var clrReturnType = clrReturnType
        if clrReturnType == nil {
            return false
        }
        let clrReturnsByRef = clrReturnType.IsByRef
        if (returnRefKind != RefKind.None) != clrReturnsByRef ||
            (openMethodDefinition != nil && RefCapabilities.GetReturnRefKind(openMethodDefinition) != returnRefKind) {
            return false
        }
        if clrReturnsByRef {
            clrReturnType = clrReturnType.GetElementType()
            if clrReturnType == nil {
                return false
            }
        }
        if isAsyncVoid {
            return returnRefKind == RefKind.None && clrReturnType.IsSameAs(typeof(Void)) && object.ReferenceEquals(
                returnType,
                TypeSymbol.Void
            )
        }
        if isAsync && IsClrNonGenericAsyncReturnType(clrReturnType!!, isValueTask) {
            return returnRefKind == RefKind.None && returnType == TypeSymbol.Void
        }
        if isAsync && !TryUnwrapClrAsyncReturnType(clrReturnType!!, isValueTask, out clrReturnType) {
            return false
        }
        if TypeMatches(clrReturnType, returnType, typeSubstitutions, openMethodDefinition, methodTypeArguments) {
            return true
        }
        return allowCovariantReturn && returnRefKind == RefKind.None && IsCovariantReturn(clrReturnType, returnType)
    }

    private func TryUnwrapClrAsyncReturnType(
        clrReturnType Type,
        isValueTask bool,
        @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out awaitedType Type?
    ) bool {
        let expectedName = if isValueTask {
            "System.Threading.Tasks.ValueTask"
        } else {
            "System.Threading.Tasks.Task"
        }
        if !clrReturnType.IsGenericType {
            awaitedType = if string.Equals(clrReturnType.FullName, expectedName, StringComparison.Ordinal) {
                clrReturnType.Assembly.GetType("System.Void")
            } else {
                default(Type?)
            }
            return awaitedType != nil
        }
        let genericDefinition = clrReturnType.UnderlyingSystemType.GetGenericTypeDefinition()
        if string.Equals(genericDefinition.FullName, expectedName + "`1", StringComparison.Ordinal) {
            awaitedType = clrReturnType.GetGenericArguments()[0]
            return true
        }
        awaitedType = nil
        return false
    }

    private func IsClrNonGenericAsyncReturnType(type Type, isValueTask bool) bool {
        let expectedName = if isValueTask {
            "System.Threading.Tasks.ValueTask"
        } else {
            "System.Threading.Tasks.Task"
        }
        return !type.IsGenericType && string.Equals(type.FullName, expectedName, StringComparison.Ordinal)
    }

    private func PropertyTypeMatches(
        clrPropertyType Type?,
        propertyType TypeSymbol,
        hasSetter bool,
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution]
    ) bool -> TypeMatches(clrPropertyType, propertyType, typeSubstitutions) ||
        (!hasSetter && IsCovariantReturn(clrPropertyType, propertyType))

    @NullabilityFunnel
    private func TypeMatches(
        clrType Type?,
        type TypeSymbol,
        typeSubstitutions ImmutableArray[TypeArgumentSubstitution],
        openMethodDefinition MethodInfo? = nil,
        methodTypeArguments ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
    ) bool {
        var type = type
        type = switch type {
            case annotated is NullabilityAnnotatedTypeSymbol: annotated.BaseType
            default: type
        }
        for substitution in typeSubstitutions {
            // ADR-0193 Phase 2: [NullabilityFunnel] on purpose, for the same
            // reason as SlotSignaturesMatch: slot identity is nullability-free.
            let substituted = MemberLookup.MapOpenClrTypeToSymbolic(
                clrType,
                substitution.OpenDefinition,
                substitution.TypeArguments,
                openMethodDefinition,
                methodTypeArguments
            )
            if DeclarationBinder.TypeSignaturesEquivalent(substituted, type) {
                return true
            }
        }
        let effectiveClrType Type? = NullableLifting.GetEffectiveClrType(type)
        if effectiveClrType != nil && clrType != nil {
            return ClrTypeUtilities.AreSame(clrType, effectiveClrType)
        }
        return false
    }

    private func IsCovariantReturn(baseReturnType Type?, derivedReturnType TypeSymbol) bool {
        if baseReturnType == nil {
            return false
        }
        let derivedClrType Type? = NullableLifting.GetEffectiveClrType(derivedReturnType)
        if derivedClrType != nil {
            return !baseReturnType.IsValueType && !derivedClrType.IsValueType && ClrTypeUtilities.IsAssignableByName(
                baseReturnType,
                derivedClrType
            )
        }
        if derivedReturnType is StructSymbol derivedStruct && derivedStruct.IsClass {
            for current in GetStructHierarchy(derivedStruct) {
                if current.ImportedBaseType?.ClrType is Type imported && ClrTypeUtilities.IsAssignableByName(
                    baseReturnType,
                    imported
                ) {
                    return true
                }
            }
        }
        return false
    }

    private func IsAccessibleOverrideTarget(
        method MethodInfo,
        accessibility Accessibility,
        references ReferenceResolver
    ) bool {
        if method.IsPublic {
            return accessibility == Accessibility.Public
        }
        if method.IsFamily || method.IsFamilyOrAssembly {
            return accessibility == Accessibility.Protected
        }
        if method.IsAssembly {
            return accessibility == Accessibility.Internal && references.CanAccessInternalMembers(
                method.DeclaringType?.Assembly
            )
        }
        // FamANDAssem requires private-protected visibility. G# cannot emit
        // that combined accessibility, and Family would widen the override.
        return false
    }
}
