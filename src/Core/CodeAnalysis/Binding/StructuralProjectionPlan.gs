// <copyright file="StructuralProjectionPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal enum StructuralProjectionConstructionKind {
    UserDefault,
    UserPrimary,
    UserExplicit,
    ClrDefaultValue,
    ClrConstructor
}

/// ADR-0148 compile-time plan for constructing one concrete object shape from
/// another through public readable/writable members.
internal class StructuralProjectionPlan {
    init(
        sourceType TypeSymbol,
        targetType TypeSymbol,
        construction StructuralProjectionConstruction,
        constructorSlots ImmutableArray[StructuralProjectionSlot],
        initializerSlots ImmutableArray[StructuralProjectionSlot]
    ) {
        SourceType = sourceType
        TargetType = targetType
        Construction = construction
        ConstructorSlots = constructorSlots
        InitializerSlots = initializerSlots
    }

    prop SourceType TypeSymbol {
        get;
    }

    prop TargetType TypeSymbol {
        get;
    }

    prop Construction StructuralProjectionConstruction {
        get;
    }

    prop ConstructorSlots ImmutableArray[StructuralProjectionSlot] {
        get;
    }

    prop InitializerSlots ImmutableArray[StructuralProjectionSlot] {
        get;
    }
}

internal class StructuralProjectionConstruction {
    init(
        kind StructuralProjectionConstructionKind,
        userType StructSymbol? = nil,
        userConstructor ConstructorSymbol? = nil,
        clrConstructor ConstructorInfo? = nil
    ) {
        Kind = kind
        UserType = userType
        UserConstructor = userConstructor
        ClrConstructor = clrConstructor
    }

    prop Kind StructuralProjectionConstructionKind {
        get;
    }

    prop UserType StructSymbol? {
        get;
    }

    prop UserConstructor ConstructorSymbol? {
        get;
    }

    prop ClrConstructor ConstructorInfo? {
        get;
    }
}

internal class StructuralProjectionSlot {
    init(
        name string,
        targetType TypeSymbol,
        source StructuralProjectionSourceMember?,
        targetField FieldSymbol? = nil,
        targetDeclaringType StructSymbol? = nil,
        targetProperty PropertySymbol? = nil,
        targetClrMember MemberInfo? = nil,
        userDefaultParameter ParameterSymbol? = nil,
        clrDefaultParameter ParameterInfo? = nil
    ) {
        Name = name
        TargetType = targetType
        Source = source
        TargetField = targetField
        TargetDeclaringType = targetDeclaringType
        TargetProperty = targetProperty
        TargetClrMember = targetClrMember
        UserDefaultParameter = userDefaultParameter
        ClrDefaultParameter = clrDefaultParameter
    }

    prop Name string {
        get;
    }

    prop TargetType TypeSymbol {
        get;
    }

    /// Gets the selected source member, or `null` when an
    /// explicit target-literal initializer supplies this slot.
    prop Source StructuralProjectionSourceMember? {
        get;
    }

    prop TargetField FieldSymbol? {
        get;
    }

    prop TargetDeclaringType StructSymbol? {
        get;
    }

    prop TargetProperty PropertySymbol? {
        get;
    }

    prop TargetClrMember MemberInfo? {
        get;
    }

    prop UserDefaultParameter ParameterSymbol? {
        get;
    }

    prop ClrDefaultParameter ParameterInfo? {
        get;
    }
}

internal class StructuralProjectionSourceMember {
    init(
        name string,
        type TypeSymbol,
        field FieldSymbol? = nil,
        declaringType StructSymbol? = nil,
        property PropertySymbol? = nil,
        clrMember MemberInfo? = nil
    ) {
        Name = name
        Type = type
        Field = field
        DeclaringType = declaringType
        Property = property
        ClrMember = clrMember
    }

    prop Name string {
        get;
    }

    prop Type TypeSymbol {
        get;
    }

    prop Field FieldSymbol? {
        get;
    }

    prop DeclaringType StructSymbol? {
        get;
    }

    prop Property PropertySymbol? {
        get;
    }

    prop ClrMember MemberInfo? {
        get;
    }
}

internal shared class StructuralProjectionPlanner {
    private let PublicInstance BindingFlags = BindingFlags.Public | BindingFlags.Instance
    func CanProject(source TypeSymbol?, target TypeSymbol?) bool -> TryCreate(
        source,
        target,
        strict: true,
        explicitMemberNames: nil,
        out _,
        out _
    )

    func TryCreate(
        source TypeSymbol?,
        target TypeSymbol?,
        strict bool,
        explicitMemberNames ISet[string]?,
        out plan StructuralProjectionPlan?,
        out failure string?
    ) bool {
        plan = nil
        failure = nil
        if source == nil ||
            target == nil ||
            source == TypeSymbol.Error ||
            target == TypeSymbol.Error ||
            NativeSliceTypes.TryGetElement(source, out _, out _) || NativeSliceTypes.TryGetElement(
            target,
            out _,
            out _
        ) ||
            !IsProjectionObjectType(source) ||
            !IsProjectionObjectType(target) ||
            target is InterfaceSymbol ||
            target is TypeParameterSymbol {
            return false
        }
        let sourceMembers = CollectSourceMembers(source)
        if IsDistinctConstructionOfTheSameClrGeneric(source, target) &&
            !MemberSurfaceCarriesTheDifference(sourceMembers, target) {
            failure = "Type '$target' is another construction of the same generic type as '$source', and the two expose an identical public member surface, so a projection between them would silently discard the state the type argument names."
            return false
        }
        if sourceMembers.Count == 0 {
            if source is StructSymbol sourceStruct &&
                (
                sourceStruct.Fields.Any((f FieldSymbol) -> !f.IsStatic && !f.IsConst) || sourceStruct.Properties.Any(
                    (p PropertySymbol) -> !p.IsStatic && !p.IsIndexer
                )
            ) {
                failure = "Source type '$source' does not provide any public readable instance members."
            }
            return false
        }
        return if target is StructSymbol userTarget {
            TryCreateUserTargetPlan(
                source,
                userTarget,
                sourceMembers,
                strict,
                explicitMemberNames,
                out plan,
                out failure
            )
        } else {
            TryCreateClrTargetPlan(source, target, sourceMembers, strict, explicitMemberNames, out plan, out failure)
        }
    }

    private func TryCreateUserTargetPlan(
        source TypeSymbol,
        target StructSymbol,
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        strict bool,
        explicitNames ISet[string]?,
        out plan StructuralProjectionPlan?,
        out failure string?
    ) bool {
        plan = nil
        failure = nil
        if target.IsAbstract || target.IsGenericDefinition {
            return false
        }
        let construction StructuralProjectionConstruction? = SelectUserConstruction(
            target,
            sourceMembers,
            explicitNames,
            out var parameters,
            out failure
        )
        if construction == nil {
            return false
        }
        let constructorSlots = ImmutableArray.CreateBuilder[StructuralProjectionSlot](parameters.Length)
        let constructorNames = HashSet[string](StringComparer.Ordinal)
        for (parameter, parameterType) in parameters {
            constructorNames.Add(parameter.Name)
            if explicitNames?.Contains(parameter.Name) != true && !sourceMembers.ContainsKey(parameter.Name) &&
                parameter
                .HasExplicitDefaultValue {
                constructorSlots.Add(
                    StructuralProjectionSlot(
                        parameter.Name,
                        parameterType,
                        source: nil,
                        userDefaultParameter: parameter
                    )
                )
                continue
            }
            if !TryCreateSlot(
                parameter.Name,
                parameterType,
                sourceMembers,
                explicitNames,
                required: true,
                out var slot,
                out failure
            ) ||
                slot is not{} resolvedSlot {
                return false
            }
            constructorSlots.Add(resolvedSlot)
        }
        let initializerSlots = ImmutableArray.CreateBuilder[StructuralProjectionSlot]()
        let targetNames = HashSet[string](constructorNames, StringComparer.Ordinal)
        for current in target.GetHierarchy() {
            for field in current.Fields {
                if field.Accessibility != Accessibility.Public ||
                    field.IsStatic ||
                    field.IsConst ||
                    field.IsReadOnly ||
                    !targetNames.Add(field.Name) {
                    continue
                }
                if !TryCreateSlot(
                    field.Name,
                    field.Type,
                    sourceMembers,
                    explicitNames,
                    strict,
                    out var slot,
                    out failure
                ) {
                    return false
                }
                if slot != nil {
                    initializerSlots.Add(
                        StructuralProjectionSlot(
                            slot.Name,
                            slot.TargetType,
                            slot.Source,
                            targetField: field,
                            targetDeclaringType: current
                        )
                    )
                }
            }
            for property in current.Properties {
                if property.Accessibility != Accessibility.Public ||
                    property.IsStatic ||
                    property.IsIndexer ||
                    !property.HasSetter ||
                    !targetNames.Add(property.Name) {
                    continue
                }
                if !TryCreateSlot(
                    property.Name,
                    property.Type,
                    sourceMembers,
                    explicitNames,
                    strict,
                    out var slot,
                    out failure
                ) {
                    return false
                }
                if slot != nil {
                    initializerSlots.Add(
                        StructuralProjectionSlot(
                            slot.Name,
                            slot.TargetType,
                            slot.Source,
                            targetDeclaringType: current,
                            targetProperty: property
                        )
                    )
                }
            }
        }
        plan = StructuralProjectionPlan(
            source,
            target,
            construction,
            constructorSlots.ToImmutable(),
            initializerSlots.ToImmutable()
        )
        return HasMappedSlot(plan!!, explicitNames)
    }

    private func SelectUserConstruction(
        target StructSymbol,
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        explicitNames ISet[string]?,
        out parameters ImmutableArray[(Parameter ParameterSymbol, Type TypeSymbol)],
        out failure string?
    ) StructuralProjectionConstruction? {
        failure = nil
        if target.HasDataConstructionPrimary ||
            (!target.UsesConstructorOwnedDataConstruction && target.HasPrimaryConstructor) {
            parameters = target
                .PrimaryConstructorParameters
                .Select((parameter ParameterSymbol) -> (parameter, parameter.Type))
                .ToImmutableArray()
            return StructuralProjectionConstruction(StructuralProjectionConstructionKind.UserPrimary, userType: target)
        }
        if target.UsesConstructorOwnedDataConstruction {
            parameters = ImmutableArray[(ParameterSymbol, TypeSymbol)].Empty
            return StructuralProjectionConstruction(StructuralProjectionConstructionKind.UserDefault, userType: target)
        }
        let explicitConstructors = target.EffectiveExplicitConstructors
        if !explicitConstructors.IsDefaultOrEmpty {
            var selected ConstructorSymbol? = nil
            for candidate in explicitConstructors {
                if candidate
                    .Function
                    .Accessibility != Accessibility.Public ||
                    !ParametersCanBeSupplied(
                    candidate.Parameters,
                    target.GetConstructorParameterTypesForConstruction(candidate),
                    sourceMembers,
                    explicitNames
                ) {
                    continue
                }
                if selected != nil {
                    parameters = ImmutableArray[(ParameterSymbol, TypeSymbol)].Empty
                    failure = "Type '$target' has more than one applicable public constructor."
                    return nil
                }
                selected = candidate
            }
            if selected == nil {
                parameters = ImmutableArray[(ParameterSymbol, TypeSymbol)].Empty
                failure = "Type '$target' has no applicable public constructor."
                return nil
            }
            let selectedTypes = target.GetConstructorParameterTypesForConstruction(selected)
            let selectedParameters = ImmutableArray.CreateBuilder[(ParameterSymbol, TypeSymbol)](
                selected.Parameters.Length
            )
            for var i = 0; i < selected.Parameters.Length; i++ {
                selectedParameters.Add((selected.Parameters[i], selectedTypes[i]))
            }
            parameters = selectedParameters.ToImmutable()
            return StructuralProjectionConstruction(
                StructuralProjectionConstructionKind.UserExplicit,
                userType: target,
                userConstructor: selected
            )
        }
        parameters = ImmutableArray[(ParameterSymbol, TypeSymbol)].Empty
        return StructuralProjectionConstruction(StructuralProjectionConstructionKind.UserDefault, userType: target)
    }

    private func TryCreateClrTargetPlan(
        source TypeSymbol,
        target TypeSymbol,
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        strict bool,
        explicitNames ISet[string]?,
        out plan StructuralProjectionPlan?,
        out failure string?
    ) bool {
        plan = nil
        failure = nil
        let clrType Type? = target.ClrType
        if clrType == nil || clrType.IsInterface || clrType.IsAbstract || clrType.ContainsGenericParameters {
            return false
        }
        var constructor ConstructorInfo? = nil
        var constructorParameters = Array.Empty[ParameterInfo]()
        let constructors = ClrTypeUtilities.SafeGetConstructors(clrType, PublicInstance)
        var parameterlessConstructor ConstructorInfo? = nil
        for candidate in constructors {
            if candidate.GetParameters().Length == 0 {
                parameterlessConstructor = candidate
                break
            }
        }
        if !clrType.IsValueType {
            constructor = parameterlessConstructor
            if constructor == nil {
                for candidate in constructors {
                    let candidateParameters = candidate.GetParameters()
                    if !ParametersCanBeSupplied(candidateParameters, sourceMembers, explicitNames) {
                        continue
                    }
                    if constructor != nil {
                        failure = "Type '$target' has more than one applicable public constructor."
                        return false
                    }
                    constructor = candidate
                    constructorParameters = candidateParameters
                }
            }
        } else {
            constructor = parameterlessConstructor
            if constructor == nil {
                for candidate in constructors {
                    let candidateParameters = candidate.GetParameters()
                    if !ParametersCanBeSupplied(candidateParameters, sourceMembers, explicitNames) {
                        continue
                    }
                    if constructor != nil {
                        failure = "Type '$target' has more than one applicable public constructor."
                        return false
                    }
                    constructor = candidate
                    constructorParameters = candidateParameters
                }
            }
        }
        if !clrType.IsValueType && constructor == nil {
            failure = "Type '$target' has no applicable public constructor."
            return false
        }
        if constructor != nil && constructorParameters.Length == 0 {
            constructorParameters = constructor.GetParameters()
        }
        let constructorSlots = ImmutableArray.CreateBuilder[StructuralProjectionSlot](constructorParameters.Length)
        let targetNames = HashSet[string](StringComparer.Ordinal)
        for parameter in constructorParameters {
            let parameterName = parameter.Name
            if string.IsNullOrEmpty(parameterName) {
                failure = "Type '$target' has a constructor parameter without a name."
                return false
            }
            let parameterType = ClrNullability.GetParameterTypeSymbol(parameter)
            targetNames.Add(parameterName)
            if explicitNames?.Contains(parameterName) != true && !sourceMembers.ContainsKey(parameterName) &&
                parameter
                .IsOptional {
                constructorSlots.Add(
                    StructuralProjectionSlot(parameterName, parameterType, source: nil, clrDefaultParameter: parameter)
                )
                continue
            }
            if !TryCreateSlot(
                parameterName,
                parameterType,
                sourceMembers,
                explicitNames,
                required: true,
                out var slot,
                out failure
            ) ||
                slot is not{} resolvedSlot {
                return false
            }
            constructorSlots.Add(resolvedSlot)
        }
        let initializerSlots = ImmutableArray.CreateBuilder[StructuralProjectionSlot]()
        for property in ClrTypeUtilities.SafeGetProperties(clrType, PublicInstance) {
            let setter MethodInfo? = property.GetSetMethod(nonPublic: false)
            if property.GetIndexParameters().Length != 0 || setter == nil || !targetNames.Add(property.Name) {
                continue
            }
            let propertyType = ClrNullability.GetPropertyTypeSymbol(property)
            if !TryCreateSlot(
                property.Name,
                propertyType,
                sourceMembers,
                explicitNames,
                strict,
                out var slot,
                out failure
            ) {
                return false
            }
            if slot != nil {
                initializerSlots.Add(
                    StructuralProjectionSlot(slot.Name, slot.TargetType, slot.Source, targetClrMember: property)
                )
            }
        }
        for field in ClrTypeUtilities.SafeGetFields(clrType, PublicInstance) {
            if field.IsStatic || field.IsLiteral || field.IsInitOnly || !targetNames.Add(field.Name) {
                continue
            }
            let fieldType = ClrNullability.GetFieldTypeSymbol(field)
            if !TryCreateSlot(field.Name, fieldType, sourceMembers, explicitNames, strict, out var slot, out failure) {
                return false
            }
            if slot != nil {
                initializerSlots.Add(
                    StructuralProjectionSlot(slot.Name, slot.TargetType, slot.Source, targetClrMember: field)
                )
            }
        }
        let constructionKind = if constructor != nil {
            StructuralProjectionConstructionKind.ClrConstructor
        } else {
            StructuralProjectionConstructionKind.ClrDefaultValue
        }
        plan = StructuralProjectionPlan(
            source,
            target,
            StructuralProjectionConstruction(constructionKind, clrConstructor: constructor),
            constructorSlots.ToImmutable(),
            initializerSlots.ToImmutable()
        )
        return HasMappedSlot(plan!!, explicitNames)
    }

    private func TryCreateSlot(
        name string,
        targetType TypeSymbol,
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        explicitNames ISet[string]?,
        required bool,
        out slot StructuralProjectionSlot?,
        out failure string?
    ) bool {
        failure = nil
        if explicitNames?.Contains(name) == true {
            slot = StructuralProjectionSlot(name, targetType, source: nil)
            return true
        }
        if !sourceMembers.TryGetValue(name, out var sourceMember) {
            slot = nil
            if required {
                failure = "Source type does not provide public readable member '$name'."
                return false
            }
            return true
        }
        if !HasImplicitMemberConversion(sourceMember.Type, targetType) {
            slot = nil
            failure = "Source member '$name' of type '${sourceMember.Type}' is not implicitly convertible to '$targetType'."
            return false
        }
        slot = StructuralProjectionSlot(name, targetType, sourceMember)
        return true
    }

    private func ParametersCanBeSupplied(
        parameters ImmutableArray[ParameterSymbol],
        parameterTypes ImmutableArray[TypeSymbol],
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        explicitNames ISet[string]?
    ) bool {
        for var i = 0; i < parameters.Length; i++ {
            let parameter = parameters[i]
            if string.IsNullOrEmpty(parameter.Name) {
                return false
            }
            if explicitNames?.Contains(parameter.Name) == true {
                continue
            }
            if !sourceMembers.TryGetValue(parameter.Name, out var source) ||
                !HasImplicitMemberConversion(source.Type, parameterTypes[i]) {
                if !parameter.HasExplicitDefaultValue {
                    return false
                }
            }
        }
        return true
    }

    private func ParametersCanBeSupplied(
        parameters[]ParameterInfo,
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        explicitNames ISet[string]?
    ) bool {
        for parameter in parameters {
            if string.IsNullOrEmpty(parameter.Name) {
                return false
            }
            if explicitNames?.Contains(parameter.Name!!) == true {
                continue
            }
            let targetType = ClrNullability.GetParameterTypeSymbol(parameter)
            if !sourceMembers.TryGetValue(parameter.Name!!, out var source) ||
                !HasImplicitMemberConversion(source.Type, targetType) {
                if !parameter.IsOptional {
                    return false
                }
            }
        }
        return true
    }

    private func HasImplicitMemberConversion(source TypeSymbol, target TypeSymbol) bool {
        let conversion = Conversion.ClassifyNonStructural(source, target)
        return conversion.IsImplicit || ConversionClassifier.HasUserDefinedImplicitConversionForTypes(source, target)
    }

    private func HasMappedSlot(plan StructuralProjectionPlan, explicitNames ISet[string]?) bool {
        for slot in plan.ConstructorSlots.Concat(plan.InitializerSlots) {
            if slot.Source != nil || explicitNames?.Contains(slot.Name) == true {
                return true
            }
        }
        return false
    }

    /// Issue #4014: true when [`source`](paramref) and [`target`](paramref) are two DIFFERENT closed
    /// constructions of the SAME CLR
    /// generic definition — e.g. `List[int32]` and `List[string]`.
    ///
    /// The planner's question is "can the target be constructed from the
    /// source's public member surface?", and for two constructions of one
    /// generic that question answers yes for a reason that has nothing to do
    /// with the values involved: the two share a member surface BY
    /// CONSTRUCTION, and the members whose types actually differ (the ones
    /// mentioning the type argument) are exactly the ones a projection cannot
    /// carry. For `List` the incidental overlap is a parameterless
    /// constructor plus a settable `Capacity`, so the plan built a NEW,
    /// EMPTY `List<string>` and copied a capacity — measured on the
    /// parent, `let zs List[string] = xs` for an `xs List[int32]`
    /// holding one element compiled, IL-verified, and printed `0`.
    ///
    /// The verdict lives HERE rather than in (cref:Conversion)'s
    /// projection arm because THREE callers ask the planner directly — (cref:Conversion), applicability's
    /// structural-projection argument
    /// check (#4006), and `ClrOverloadResolution`'s argument check — and
    /// closing only the conversion arm leaves the other two open, which is
    /// literally the #4006 shape.
    ///
    /// Deliberately scoped to pairs whose CLOSED CLR types are BOTH GENUINE and
    /// DIFFER, and — see (cref:MemberSurfaceCarriesTheDifference), which
    /// the caller ands with this — whose member surfaces do NOT expose the
    /// difference. Two exclusions are load-bearing here, and both were measured
    /// rather than assumed:
    ///
    /// - <b>Identical closed types are not touched</b> — that is identity, not a projection.
    /// - <b>An ADR-0004 ERASURE SURROGATE is not a closed type.</b> A constructed generic over a
    /// same-compilation element has no CLR identity while binding, so its `ClrType` is a surrogate: #2889's
    /// `List[Mode]` over a same-compilation enum presents as `List<object>` while the `Action[List[Mode]]`
    /// slot it must reach presents as `List<int>`. Those two closed types differ for a reason that has
    /// nothing to do with the values — the SYMBOLIC arguments are the same type. Comparing closed types
    /// alone refused that pair (measured: `GS0131`, the whole `Issue2889LambdaThunkNestedGenericTests` row
    /// went red), so the rule additionally requires that NEITHER side carries a type argument the CLR type
    /// does not: an argument whose own `ClrType` is null is exactly the erasure this cannot see through.
    /// Note this is a SHAPE test on the symbols — it does not call `Conversion.Classify`, because #4006
    /// measured that narrowing a projection callback that way breaks the same #2889 row for a second,
    /// independent reason.
    /// - <b>A same-compilation G# generic is untouched</b> — its own `ClrType` is null. Measured: a user
    /// `class Box[T]` projects `Box[int32]` to `Box[int64]` and CARRIES the value, because a G# class's
    /// public fields ARE its state. Refusing that would break a faithful conversion for no soundness
    /// reason.
    /// @param source The projection source type.
    /// @param target The projection target type.
    /// @returns `true` when the pair must not project.
    private func IsDistinctConstructionOfTheSameClrGeneric(source TypeSymbol, target TypeSymbol) bool {
        let sourceClr Type? = source.ClrType
        let targetClr Type? = target.ClrType
        if sourceClr == nil ||
            targetClr == nil ||
            !sourceClr.IsGenericType ||
            !targetClr.IsGenericType ||
            sourceClr.IsGenericTypeDefinition ||
            targetClr.IsGenericTypeDefinition {
            return false
        }
        // Guard test #835: reference identity is forbidden for CLR types that
        // may have come from a MetadataLoadContext.
        if sourceClr.IsSameAs(targetClr) {
            return false
        }
        if HasErasedTypeArgument(source) || HasErasedTypeArgument(target) {
            return false
        }
        return SafeGetGenericTypeDefinition(sourceClr).IsSameAs(SafeGetGenericTypeDefinition(targetClr))
    }

    /// Issue #4014: true when [`type`](paramref) is a constructed generic
    /// carrying a SYMBOLIC type argument that its (cref:TypeSymbol.ClrType)
    /// cannot represent — an argument with no CLR identity of its own while
    /// binding (a same-compilation class, struct or enum). The container's
    /// `ClrType` is then an ADR-0004 erasure surrogate rather than the
    /// type the source actually denotes, so comparing closed CLR types across
    /// such a pair compares surrogates. Recursive, so a nested
    /// `List[List[Mode]]` is caught too.
    /// @param type The candidate constructed generic.
    /// @returns `true` when an erased argument is present.
    private func HasErasedTypeArgument(type TypeSymbol) bool {
        if type is not ImportedTypeSymbol imported || imported.TypeArguments.IsDefaultOrEmpty {
            return false
        }
        for argument in imported.TypeArguments {
            if argument.ClrType == nil || HasErasedTypeArgument(argument) {
                return true
            }
        }
        return false
    }

    /// Issue #4014, Copilot review on PR #4029: true when the two
    /// constructions' public member surfaces THEMSELVES differ — i.e. at least
    /// one same-named member has a different type on the two sides, because it
    /// mentions the generic definition's type parameter.
    /// @remarks This is the discriminator between the two situations the
    /// same-definition test alone cannot tell apart, and both were measured on
    /// the parent:
    ///
    /// - An imported `Box<T>` with a settable `T Value` EXPOSES the difference: `Box[int32]` has
    /// `Value int32` where `Box[string]` has `Value string`. The author can therefore see the incompatible
    /// member and SUPPLY it, which is exactly what ADR-0148 §B explicit object spread is for —
    /// `Box[string]{ ...boxOfInt, Value: "replacement" }` compiled on the parent and printed `replacement`.
    /// Refusing that outright was a regression. The ordinary member rules already decide this pair
    /// correctly in BOTH directions: without the override, the parent reports (and this branch still
    /// reports) `GS0490: Source member 'Value' of type 'int32' is not implicitly convertible to 'string'`,
    /// at the spread and at an implicit assignment alike.
    /// - `List<T>` does NOT expose the difference: its projectable surface is `Capacity`/`Count`,
    /// identically `int32` on both sides, and the elements live in private state. The author cannot supply
    /// what they cannot name, so every spelling loses them — measured on the parent, the implicit
    /// assignment, the argument position, `List[string]{ ...xs }` and `List[string]{ ...xs, Capacity: 4 }`
    /// all compiled and all printed `0`. That is the case this refuses.
    ///
    /// Deliberately NOT expressed as "only refuse strict/implicit
    /// projection", which is what the review proposed. Both spread spellings
    /// above reach the planner with `strict: false`
    /// (`ExpressionBinder.Literals.BindStructuralSpreadLiteral`), so
    /// gating on that flag would have fixed the reported regression while
    /// reopening a measured element loss. The surface test does both.
    /// @param sourceMembers The source's collected public readable members.
    /// @param target The projection target, a sibling construction.
    /// @returns `true` when the difference is visible in the surface.
    private func MemberSurfaceCarriesTheDifference(
        sourceMembers Dictionary[string, StructuralProjectionSourceMember],
        target TypeSymbol
    ) bool {
        let targetMembers = CollectSourceMembers(target)
        for (name, sourceMember) in sourceMembers {
            if !targetMembers.TryGetValue(name, out var targetMember) {
                continue
            }
            if sourceMember.Type != targetMember.Type &&
                !sourceMember
                .Type
                .ClrType
                .IsSameAs(targetMember.Type.ClrType) {
                return true
            }
        }
        return false
    }

    private func SafeGetGenericTypeDefinition(type Type) Type? {
        try {
            return type.GetGenericTypeDefinition()
        } catch (InvalidOperationException) {
            return nil
        } catch (NotSupportedException) {
            return nil
        }
    }

    private func IsProjectionObjectType(type TypeSymbol) bool {
        if type is StructSymbol aggregate {
            return !aggregate.IsInline && !aggregate.IsRefStruct
        }
        if !(type is ImportedTypeSymbol) {
            return false
        }
        let clrType Type? = type.ClrType
        return clrType != nil && !clrType.IsSameAs(typeof(object)) && !clrType.IsSameAs(typeof(string)) &&
            !clrType.IsPrimitive &&
            !clrType.IsEnum &&
            !clrType.IsArray &&
            !clrType.IsPointer &&
            !clrType.IsByRefLike &&
            !ClrTypeUtilities.IsDelegateType(clrType)
    }

    private func CollectSourceMembers(source TypeSymbol) Dictionary[string, StructuralProjectionSourceMember] {
        let result = Dictionary[string, StructuralProjectionSourceMember](StringComparer.Ordinal)
        if source is StructSymbol structSource {
            for current in structSource.GetHierarchy() {
                for property in current.Properties {
                    if property.Accessibility == Accessibility.Public &&
                        property.HasGetter &&
                        !property.IsStatic &&
                        !property.IsIndexer &&
                        !result
                        .ContainsKey(property.Name) {
                        result.Add(
                            property.Name,
                            StructuralProjectionSourceMember(
                                property.Name,
                                property.Type,
                                declaringType: current,
                                property: property
                            )
                        )
                    }
                }
                for field in current.Fields {
                    if field.Accessibility == Accessibility.Public &&
                        !field.IsStatic &&
                        !field.IsConst &&
                        !result
                        .ContainsKey(field.Name) {
                        result.Add(
                            field.Name,
                            StructuralProjectionSourceMember(
                                field.Name,
                                field.Type,
                                field: field,
                                declaringType: current
                            )
                        )
                    }
                }
            }
            return result
        }
        let clrType Type? = source.ClrType
        if clrType == nil {
            return result
        }
        for property in ClrTypeUtilities.SafeGetProperties(clrType, PublicInstance) {
            if property.GetIndexParameters().Length == 0 && property.GetGetMethod(nonPublic: false) != nil &&
                !result
                .ContainsKey(property.Name) {
                result.Add(
                    property.Name,
                    StructuralProjectionSourceMember(
                        property.Name,
                        ClrNullability.GetPropertyTypeSymbol(property),
                        clrMember: property
                    )
                )
            }
        }
        for field in ClrTypeUtilities.SafeGetFields(clrType, PublicInstance) {
            if !field.IsStatic && !field.IsLiteral && !result.ContainsKey(field.Name) {
                result.Add(
                    field.Name,
                    StructuralProjectionSourceMember(
                        field.Name,
                        ClrNullability.GetFieldTypeSymbol(field),
                        clrMember: field
                    )
                )
            }
        }
        return result
    }
}
