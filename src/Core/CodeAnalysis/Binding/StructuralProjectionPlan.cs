// <copyright file="StructuralProjectionPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal enum StructuralProjectionConstructionKind
{
    /// <summary>Default construction of a user type.</summary>
    UserDefault,

    /// <summary>Primary construction of a user type.</summary>
    UserPrimary,

    /// <summary>Explicit construction of a user type.</summary>
    UserExplicit,

    /// <summary>Default initialization of a CLR value type.</summary>
    ClrDefaultValue,

    /// <summary>Public CLR constructor invocation.</summary>
    ClrConstructor,
}

/// <summary>
/// ADR-0148 compile-time plan for constructing one concrete object shape from
/// another through public readable/writable members.
/// </summary>
internal sealed class StructuralProjectionPlan
{
    public StructuralProjectionPlan(
        TypeSymbol sourceType,
        TypeSymbol targetType,
        StructuralProjectionConstruction construction,
        ImmutableArray<StructuralProjectionSlot> constructorSlots,
        ImmutableArray<StructuralProjectionSlot> initializerSlots)
    {
        SourceType = sourceType;
        TargetType = targetType;
        Construction = construction;
        ConstructorSlots = constructorSlots;
        InitializerSlots = initializerSlots;
    }

    public TypeSymbol SourceType { get; }

    public TypeSymbol TargetType { get; }

    public StructuralProjectionConstruction Construction { get; }

    public ImmutableArray<StructuralProjectionSlot> ConstructorSlots { get; }

    public ImmutableArray<StructuralProjectionSlot> InitializerSlots { get; }
}

internal sealed class StructuralProjectionConstruction
{
    public StructuralProjectionConstruction(
        StructuralProjectionConstructionKind kind,
        StructSymbol? userType = null,
        ConstructorSymbol? userConstructor = null,
        ConstructorInfo? clrConstructor = null)
    {
        Kind = kind;
        UserType = userType;
        UserConstructor = userConstructor;
        ClrConstructor = clrConstructor;
    }

    public StructuralProjectionConstructionKind Kind { get; }

    public StructSymbol? UserType { get; }

    public ConstructorSymbol? UserConstructor { get; }

    public ConstructorInfo? ClrConstructor { get; }
}

internal sealed class StructuralProjectionSlot
{
    public StructuralProjectionSlot(
        string name,
        TypeSymbol targetType,
        StructuralProjectionSourceMember? source,
        FieldSymbol? targetField = null,
        StructSymbol? targetDeclaringType = null,
        PropertySymbol? targetProperty = null,
        MemberInfo? targetClrMember = null,
        ParameterSymbol? userDefaultParameter = null,
        ParameterInfo? clrDefaultParameter = null)
    {
        Name = name;
        TargetType = targetType;
        Source = source;
        TargetField = targetField;
        TargetDeclaringType = targetDeclaringType;
        TargetProperty = targetProperty;
        TargetClrMember = targetClrMember;
        UserDefaultParameter = userDefaultParameter;
        ClrDefaultParameter = clrDefaultParameter;
    }

    public string Name { get; }

    public TypeSymbol TargetType { get; }

    /// <summary>
    /// Gets the selected source member, or <see langword="null"/> when an
    /// explicit target-literal initializer supplies this slot.
    /// </summary>
    public StructuralProjectionSourceMember? Source { get; }

    public FieldSymbol? TargetField { get; }

    public StructSymbol? TargetDeclaringType { get; }

    public PropertySymbol? TargetProperty { get; }

    public MemberInfo? TargetClrMember { get; }

    public ParameterSymbol? UserDefaultParameter { get; }

    public ParameterInfo? ClrDefaultParameter { get; }
}

internal sealed class StructuralProjectionSourceMember
{
    public StructuralProjectionSourceMember(
        string name,
        TypeSymbol type,
        FieldSymbol? field = null,
        StructSymbol? declaringType = null,
        PropertySymbol? property = null,
        MemberInfo? clrMember = null)
    {
        Name = name;
        Type = type;
        Field = field;
        DeclaringType = declaringType;
        Property = property;
        ClrMember = clrMember;
    }

    public string Name { get; }

    public TypeSymbol Type { get; }

    public FieldSymbol? Field { get; }

    public StructSymbol? DeclaringType { get; }

    public PropertySymbol? Property { get; }

    public MemberInfo? ClrMember { get; }
}

internal static class StructuralProjectionPlanner
{
    private static readonly BindingFlags PublicInstance = BindingFlags.Public | BindingFlags.Instance;

    public static bool CanProject(TypeSymbol? source, TypeSymbol? target)
        => TryCreate(source, target, strict: true, explicitMemberNames: null, out _, out _);

    public static bool TryCreate(
        TypeSymbol? source,
        TypeSymbol? target,
        bool strict,
        ISet<string>? explicitMemberNames,
        out StructuralProjectionPlan? plan,
        out string? failure)
    {
        plan = null;
        failure = null;

        if (source == null || target == null
            || source == TypeSymbol.Error || target == TypeSymbol.Error
            || !IsProjectionObjectType(source)
            || !IsProjectionObjectType(target)
            || target is InterfaceSymbol
            || target is TypeParameterSymbol)
        {
            return false;
        }

        var sourceMembers = CollectSourceMembers(source);
        if (IsDistinctConstructionOfTheSameClrGeneric(source, target)
            && !MemberSurfaceCarriesTheDifference(sourceMembers, target))
        {
            failure = $"Type '{target}' is another construction of the same generic type as '{source}', and the two expose an identical public member surface, so a projection between them would silently discard the state the type argument names.";
            return false;
        }

        if (sourceMembers.Count == 0)
        {
            if (source is StructSymbol sourceStruct
                && (sourceStruct.Fields.Any(f => !f.IsStatic && !f.IsConst)
                    || sourceStruct.Properties.Any(p => !p.IsStatic && !p.IsIndexer)))
            {
                failure = $"Source type '{source}' does not provide any public readable instance members.";
            }

            return false;
        }

        return target is StructSymbol userTarget
            ? TryCreateUserTargetPlan(source, userTarget, sourceMembers, strict, explicitMemberNames, out plan, out failure)
            : TryCreateClrTargetPlan(source, target, sourceMembers, strict, explicitMemberNames, out plan, out failure);
    }

    private static bool TryCreateUserTargetPlan(
        TypeSymbol source,
        StructSymbol target,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        bool strict,
        ISet<string>? explicitNames,
        out StructuralProjectionPlan? plan,
        out string? failure)
    {
        plan = null;
        failure = null;
        if (target.IsAbstract || target.IsGenericDefinition)
        {
            return false;
        }

        var construction = SelectUserConstruction(target, sourceMembers, explicitNames, out var parameters, out failure);
        if (construction == null)
        {
            return false;
        }

        var constructorSlots = ImmutableArray.CreateBuilder<StructuralProjectionSlot>(parameters.Length);
        var constructorNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (parameter, parameterType) in parameters)
        {
            constructorNames.Add(parameter.Name);
            if (explicitNames?.Contains(parameter.Name) != true
                && !sourceMembers.ContainsKey(parameter.Name)
                && parameter.HasExplicitDefaultValue)
            {
                constructorSlots.Add(new StructuralProjectionSlot(
                    parameter.Name,
                    parameterType,
                    source: null,
                    userDefaultParameter: parameter));
                continue;
            }

            if (!TryCreateSlot(parameter.Name, parameterType, sourceMembers, explicitNames, required: true, out var slot, out failure)
                || slot is not { } resolvedSlot)
            {
                return false;
            }

            constructorSlots.Add(resolvedSlot);
        }

        var initializerSlots = ImmutableArray.CreateBuilder<StructuralProjectionSlot>();
        var targetNames = new HashSet<string>(constructorNames, StringComparer.Ordinal);
        foreach (var current in target.GetHierarchy())
        {
            foreach (var field in current.Fields)
            {
                if (field.Accessibility != Accessibility.Public
                    || field.IsStatic || field.IsConst || field.IsReadOnly
                    || !targetNames.Add(field.Name))
                {
                    continue;
                }

                if (!TryCreateSlot(field.Name, field.Type, sourceMembers, explicitNames, strict, out var slot, out failure))
                {
                    return false;
                }

                if (slot != null)
                {
                    initializerSlots.Add(new StructuralProjectionSlot(
                        slot.Name,
                        slot.TargetType,
                        slot.Source,
                        targetField: field,
                        targetDeclaringType: current));
                }
            }

            foreach (var property in current.Properties)
            {
                if (property.Accessibility != Accessibility.Public
                    || property.IsStatic || property.IsIndexer || !property.HasSetter
                    || !targetNames.Add(property.Name))
                {
                    continue;
                }

                if (!TryCreateSlot(property.Name, property.Type, sourceMembers, explicitNames, strict, out var slot, out failure))
                {
                    return false;
                }

                if (slot != null)
                {
                    initializerSlots.Add(new StructuralProjectionSlot(
                        slot.Name,
                        slot.TargetType,
                        slot.Source,
                        targetDeclaringType: current,
                        targetProperty: property));
                }
            }
        }

        plan = new StructuralProjectionPlan(
            source,
            target,
            construction,
            constructorSlots.ToImmutable(),
            initializerSlots.ToImmutable());
        return HasMappedSlot(plan, explicitNames);
    }

    private static StructuralProjectionConstruction? SelectUserConstruction(
        StructSymbol target,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        ISet<string>? explicitNames,
        out ImmutableArray<(ParameterSymbol Parameter, TypeSymbol Type)> parameters,
        out string? failure)
    {
        failure = null;
        if (target.HasPrimaryConstructor)
        {
            parameters = target.PrimaryConstructorParameters
                .Select(parameter => (parameter, parameter.Type))
                .ToImmutableArray();
            return new StructuralProjectionConstruction(StructuralProjectionConstructionKind.UserPrimary, userType: target);
        }

        var explicitConstructors = target.EffectiveExplicitConstructors;
        if (!explicitConstructors.IsDefaultOrEmpty)
        {
            ConstructorSymbol? selected = null;
            foreach (var candidate in explicitConstructors)
            {
                if (candidate.Function.Accessibility != Accessibility.Public
                    || !ParametersCanBeSupplied(
                        candidate.Parameters,
                        target.GetConstructorParameterTypesForConstruction(candidate),
                        sourceMembers,
                        explicitNames))
                {
                    continue;
                }

                if (selected != null)
                {
                    parameters = ImmutableArray<(ParameterSymbol, TypeSymbol)>.Empty;
                    failure = $"Type '{target}' has more than one applicable public constructor.";
                    return null;
                }

                selected = candidate;
            }

            if (selected == null)
            {
                parameters = ImmutableArray<(ParameterSymbol, TypeSymbol)>.Empty;
                failure = $"Type '{target}' has no applicable public constructor.";
                return null;
            }

            var selectedTypes = target.GetConstructorParameterTypesForConstruction(selected);
            var selectedParameters = ImmutableArray.CreateBuilder<(ParameterSymbol, TypeSymbol)>(selected.Parameters.Length);
            for (var i = 0; i < selected.Parameters.Length; i++)
            {
                selectedParameters.Add((selected.Parameters[i], selectedTypes[i]));
            }

            parameters = selectedParameters.ToImmutable();
            return new StructuralProjectionConstruction(
                StructuralProjectionConstructionKind.UserExplicit,
                userType: target,
                userConstructor: selected);
        }

        parameters = ImmutableArray<(ParameterSymbol, TypeSymbol)>.Empty;
        return new StructuralProjectionConstruction(StructuralProjectionConstructionKind.UserDefault, userType: target);
    }

    private static bool TryCreateClrTargetPlan(
        TypeSymbol source,
        TypeSymbol target,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        bool strict,
        ISet<string>? explicitNames,
        out StructuralProjectionPlan? plan,
        out string? failure)
    {
        plan = null;
        failure = null;
        var clrType = target.ClrType;
        if (clrType == null || clrType.IsInterface || clrType.IsAbstract || clrType.ContainsGenericParameters)
        {
            return false;
        }

        ConstructorInfo? constructor = null;
        ParameterInfo[] constructorParameters = Array.Empty<ParameterInfo>();
        var constructors = ClrTypeUtilities.SafeGetConstructors(clrType, PublicInstance);
        ConstructorInfo? parameterlessConstructor = null;
        foreach (var candidate in constructors)
        {
            if (candidate.GetParameters().Length == 0)
            {
                parameterlessConstructor = candidate;
                break;
            }
        }

        if (!clrType.IsValueType)
        {
            constructor = parameterlessConstructor;
            if (constructor == null)
            {
                foreach (var candidate in constructors)
                {
                    var candidateParameters = candidate.GetParameters();
                    if (!ParametersCanBeSupplied(candidateParameters, sourceMembers, explicitNames))
                    {
                        continue;
                    }

                    if (constructor != null)
                    {
                        failure = $"Type '{target}' has more than one applicable public constructor.";
                        return false;
                    }

                    constructor = candidate;
                    constructorParameters = candidateParameters;
                }
            }
        }
        else
        {
            constructor = parameterlessConstructor;
            if (constructor == null)
            {
                foreach (var candidate in constructors)
                {
                    var candidateParameters = candidate.GetParameters();
                    if (!ParametersCanBeSupplied(candidateParameters, sourceMembers, explicitNames))
                    {
                        continue;
                    }

                    if (constructor != null)
                    {
                        failure = $"Type '{target}' has more than one applicable public constructor.";
                        return false;
                    }

                    constructor = candidate;
                    constructorParameters = candidateParameters;
                }
            }
        }

        if (!clrType.IsValueType && constructor == null)
        {
            failure = $"Type '{target}' has no applicable public constructor.";
            return false;
        }

        if (constructor != null && constructorParameters.Length == 0)
        {
            constructorParameters = constructor.GetParameters();
        }

        var constructorSlots = ImmutableArray.CreateBuilder<StructuralProjectionSlot>(constructorParameters.Length);
        var targetNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var parameter in constructorParameters)
        {
            var parameterName = parameter.Name;
            if (string.IsNullOrEmpty(parameterName))
            {
                failure = $"Type '{target}' has a constructor parameter without a name.";
                return false;
            }

            var parameterType = TypeSymbol.FromClrType(parameter.ParameterType);
            targetNames.Add(parameterName);
            if (explicitNames?.Contains(parameterName) != true
                && !sourceMembers.ContainsKey(parameterName)
                && parameter.IsOptional)
            {
                constructorSlots.Add(new StructuralProjectionSlot(
                    parameterName,
                    parameterType,
                    source: null,
                    clrDefaultParameter: parameter));
                continue;
            }

            if (!TryCreateSlot(parameterName, parameterType, sourceMembers, explicitNames, required: true, out var slot, out failure)
                || slot is not { } resolvedSlot)
            {
                return false;
            }

            constructorSlots.Add(resolvedSlot);
        }

        var initializerSlots = ImmutableArray.CreateBuilder<StructuralProjectionSlot>();
        foreach (var property in ClrTypeUtilities.SafeGetProperties(clrType, PublicInstance))
        {
            var setter = property.GetSetMethod(nonPublic: false);
            if (property.GetIndexParameters().Length != 0 || setter == null || !targetNames.Add(property.Name))
            {
                continue;
            }

            var propertyType = TypeSymbol.FromClrType(property.PropertyType);
            if (!TryCreateSlot(property.Name, propertyType, sourceMembers, explicitNames, strict, out var slot, out failure))
            {
                return false;
            }

            if (slot != null)
            {
                initializerSlots.Add(new StructuralProjectionSlot(
                    slot.Name,
                    slot.TargetType,
                    slot.Source,
                    targetClrMember: property));
            }
        }

        foreach (var field in ClrTypeUtilities.SafeGetFields(clrType, PublicInstance))
        {
            if (field.IsStatic || field.IsLiteral || field.IsInitOnly || !targetNames.Add(field.Name))
            {
                continue;
            }

            var fieldType = TypeSymbol.FromClrType(field.FieldType);
            if (!TryCreateSlot(field.Name, fieldType, sourceMembers, explicitNames, strict, out var slot, out failure))
            {
                return false;
            }

            if (slot != null)
            {
                initializerSlots.Add(new StructuralProjectionSlot(
                    slot.Name,
                    slot.TargetType,
                    slot.Source,
                    targetClrMember: field));
            }
        }

        var constructionKind = constructor != null
            ? StructuralProjectionConstructionKind.ClrConstructor
            : StructuralProjectionConstructionKind.ClrDefaultValue;
        plan = new StructuralProjectionPlan(
            source,
            target,
            new StructuralProjectionConstruction(constructionKind, clrConstructor: constructor),
            constructorSlots.ToImmutable(),
            initializerSlots.ToImmutable());
        return HasMappedSlot(plan, explicitNames);
    }

    private static bool TryCreateSlot(
        string name,
        TypeSymbol targetType,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        ISet<string>? explicitNames,
        bool required,
        out StructuralProjectionSlot? slot,
        out string? failure)
    {
        failure = null;
        if (explicitNames?.Contains(name) == true)
        {
            slot = new StructuralProjectionSlot(name, targetType, source: null);
            return true;
        }

        if (!sourceMembers.TryGetValue(name, out var sourceMember))
        {
            slot = null;
            if (required)
            {
                failure = $"Source type does not provide public readable member '{name}'.";
                return false;
            }

            return true;
        }

        if (!HasImplicitMemberConversion(sourceMember.Type, targetType))
        {
            slot = null;
            failure = $"Source member '{name}' of type '{sourceMember.Type}' is not implicitly convertible to '{targetType}'.";
            return false;
        }

        slot = new StructuralProjectionSlot(name, targetType, sourceMember);
        return true;
    }

    private static bool ParametersCanBeSupplied(
        ImmutableArray<ParameterSymbol> parameters,
        ImmutableArray<TypeSymbol> parameterTypes,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        ISet<string>? explicitNames)
    {
        for (var i = 0; i < parameters.Length; i++)
        {
            var parameter = parameters[i];
            if (string.IsNullOrEmpty(parameter.Name))
            {
                return false;
            }

            if (explicitNames?.Contains(parameter.Name) == true)
            {
                continue;
            }

            if (!sourceMembers.TryGetValue(parameter.Name, out var source)
                || !HasImplicitMemberConversion(source.Type, parameterTypes[i]))
            {
                if (!parameter.HasExplicitDefaultValue)
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool ParametersCanBeSupplied(
        ParameterInfo[] parameters,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        ISet<string>? explicitNames)
    {
        foreach (var parameter in parameters)
        {
            if (string.IsNullOrEmpty(parameter.Name))
            {
                return false;
            }

            if (explicitNames?.Contains(parameter.Name) == true)
            {
                continue;
            }

            var targetType = TypeSymbol.FromClrType(parameter.ParameterType);
            if (!sourceMembers.TryGetValue(parameter.Name, out var source)
                || !HasImplicitMemberConversion(source.Type, targetType))
            {
                if (!parameter.IsOptional)
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool HasImplicitMemberConversion(TypeSymbol source, TypeSymbol target)
    {
        var conversion = Conversion.ClassifyNonStructural(source, target);
        return conversion.IsImplicit
            || ConversionClassifier.HasUserDefinedImplicitConversionForTypes(source, target);
    }

    private static bool HasMappedSlot(StructuralProjectionPlan plan, ISet<string>? explicitNames)
    {
        foreach (var slot in plan.ConstructorSlots.Concat(plan.InitializerSlots))
        {
            if (slot.Source != null || explicitNames?.Contains(slot.Name) == true)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #4014: true when <paramref name="source"/> and <paramref
    /// name="target"/> are two DIFFERENT closed constructions of the SAME CLR
    /// generic definition — e.g. <c>List[int32]</c> and <c>List[string]</c>.
    /// <para>
    /// The planner's question is "can the target be constructed from the
    /// source's public member surface?", and for two constructions of one
    /// generic that question answers yes for a reason that has nothing to do
    /// with the values involved: the two share a member surface BY
    /// CONSTRUCTION, and the members whose types actually differ (the ones
    /// mentioning the type argument) are exactly the ones a projection cannot
    /// carry. For <c>List</c> the incidental overlap is a parameterless
    /// constructor plus a settable <c>Capacity</c>, so the plan built a NEW,
    /// EMPTY <c>List&lt;string&gt;</c> and copied a capacity — measured on the
    /// parent, <c>let zs List[string] = xs</c> for an <c>xs List[int32]</c>
    /// holding one element compiled, IL-verified, and printed <c>0</c>.
    /// </para>
    /// <para>
    /// The verdict lives HERE rather than in <see cref="Conversion"/>'s
    /// projection arm because THREE callers ask the planner directly — <see
    /// cref="Conversion"/>, applicability's structural-projection argument
    /// check (#4006), and <c>ClrOverloadResolution</c>'s argument check — and
    /// closing only the conversion arm leaves the other two open, which is
    /// literally the #4006 shape.
    /// </para>
    /// <para>
    /// Deliberately scoped to pairs whose CLOSED CLR types are BOTH GENUINE and
    /// DIFFER, and — see <see cref="MemberSurfaceCarriesTheDifference"/>, which
    /// the caller ands with this — whose member surfaces do NOT expose the
    /// difference. Two exclusions are load-bearing here, and both were measured
    /// rather than assumed:
    /// </para>
    /// <list type="bullet">
    /// <item><b>Identical closed types are not touched</b> — that is identity,
    /// not a projection.</item>
    /// <item><b>An ADR-0004 ERASURE SURROGATE is not a closed type.</b> A
    /// constructed generic over a same-compilation element has no CLR identity
    /// while binding, so its <c>ClrType</c> is a surrogate: #2889's
    /// <c>List[Mode]</c> over a same-compilation enum presents as
    /// <c>List&lt;object&gt;</c> while the <c>Action[List[Mode]]</c> slot it
    /// must reach presents as <c>List&lt;int&gt;</c>. Those two closed types
    /// differ for a reason that has nothing to do with the values — the
    /// SYMBOLIC arguments are the same type. Comparing closed types alone
    /// refused that pair (measured: <c>GS0131</c>, the whole
    /// <c>Issue2889LambdaThunkNestedGenericTests</c> row went red), so the rule
    /// additionally requires that NEITHER side carries a type argument the CLR
    /// type does not: an argument whose own <c>ClrType</c> is null is exactly
    /// the erasure this cannot see through. Note this is a SHAPE test on the
    /// symbols — it does not call <c>Conversion.Classify</c>, because #4006
    /// measured that narrowing a projection callback that way breaks the same
    /// #2889 row for a second, independent reason.</item>
    /// <item><b>A same-compilation G# generic is untouched</b> — its own
    /// <c>ClrType</c> is null. Measured: a user <c>class Box[T]</c> projects
    /// <c>Box[int32]</c> to <c>Box[int64]</c> and CARRIES the value, because a
    /// G# class's public fields ARE its state. Refusing that would break a
    /// faithful conversion for no soundness reason.</item>
    /// </list>
    /// </summary>
    /// <param name="source">The projection source type.</param>
    /// <param name="target">The projection target type.</param>
    /// <returns><see langword="true"/> when the pair must not project.</returns>
    private static bool IsDistinctConstructionOfTheSameClrGeneric(TypeSymbol source, TypeSymbol target)
    {
        var sourceClr = source.ClrType;
        var targetClr = target.ClrType;
        if (sourceClr == null || targetClr == null
            || !sourceClr.IsGenericType || !targetClr.IsGenericType
            || sourceClr.IsGenericTypeDefinition || targetClr.IsGenericTypeDefinition)
        {
            return false;
        }

        // Guard test #835: reference identity is forbidden for CLR types that
        // may have come from a MetadataLoadContext.
        if (sourceClr.IsSameAs(targetClr))
        {
            return false;
        }

        if (HasErasedTypeArgument(source) || HasErasedTypeArgument(target))
        {
            return false;
        }

        return ClrTypeUtilities.IsSameAs(
            SafeGetGenericTypeDefinition(sourceClr),
            SafeGetGenericTypeDefinition(targetClr));
    }

    /// <summary>
    /// Issue #4014: true when <paramref name="type"/> is a constructed generic
    /// carrying a SYMBOLIC type argument that its <see cref="TypeSymbol.ClrType"/>
    /// cannot represent — an argument with no CLR identity of its own while
    /// binding (a same-compilation class, struct or enum). The container's
    /// <c>ClrType</c> is then an ADR-0004 erasure surrogate rather than the
    /// type the source actually denotes, so comparing closed CLR types across
    /// such a pair compares surrogates. Recursive, so a nested
    /// <c>List[List[Mode]]</c> is caught too.
    /// </summary>
    /// <param name="type">The candidate constructed generic.</param>
    /// <returns><see langword="true"/> when an erased argument is present.</returns>
    private static bool HasErasedTypeArgument(TypeSymbol type)
    {
        if (type is not ImportedTypeSymbol imported || imported.TypeArguments.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var argument in imported.TypeArguments)
        {
            if (argument.ClrType == null || HasErasedTypeArgument(argument))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #4014, Copilot review on PR #4029: true when the two
    /// constructions' public member surfaces THEMSELVES differ — i.e. at least
    /// one same-named member has a different type on the two sides, because it
    /// mentions the generic definition's type parameter.
    /// </summary>
    /// <remarks>
    /// <para>This is the discriminator between the two situations the
    /// same-definition test alone cannot tell apart, and both were measured on
    /// the parent:</para>
    /// <list type="bullet">
    /// <item>An imported <c>Box&lt;T&gt;</c> with a settable <c>T Value</c>
    /// EXPOSES the difference: <c>Box[int32]</c> has <c>Value int32</c> where
    /// <c>Box[string]</c> has <c>Value string</c>. The author can therefore see
    /// the incompatible member and SUPPLY it, which is exactly what ADR-0148 §B
    /// explicit object spread is for — <c>Box[string]{ ...boxOfInt, Value:
    /// "replacement" }</c> compiled on the parent and printed
    /// <c>replacement</c>. Refusing that outright was a regression. The
    /// ordinary member rules already decide this pair correctly in BOTH
    /// directions: without the override, the parent reports (and this branch
    /// still reports) <c>GS0490: Source member 'Value' of type 'int32' is not
    /// implicitly convertible to 'string'</c>, at the spread and at an implicit
    /// assignment alike.</item>
    /// <item><c>List&lt;T&gt;</c> does NOT expose the difference: its
    /// projectable surface is <c>Capacity</c>/<c>Count</c>, identically
    /// <c>int32</c> on both sides, and the elements live in private state. The
    /// author cannot supply what they cannot name, so every spelling loses
    /// them — measured on the parent, the implicit assignment, the argument
    /// position, <c>List[string]{ ...xs }</c> and <c>List[string]{ ...xs,
    /// Capacity: 4 }</c> all compiled and all printed <c>0</c>. That is the
    /// case this refuses.</item>
    /// </list>
    /// <para>Deliberately NOT expressed as "only refuse strict/implicit
    /// projection", which is what the review proposed. Both spread spellings
    /// above reach the planner with <c>strict: false</c>
    /// (<c>ExpressionBinder.Literals.BindStructuralSpreadLiteral</c>), so
    /// gating on that flag would have fixed the reported regression while
    /// reopening a measured element loss. The surface test does both.</para>
    /// </remarks>
    /// <param name="sourceMembers">The source's collected public readable members.</param>
    /// <param name="target">The projection target, a sibling construction.</param>
    /// <returns><see langword="true"/> when the difference is visible in the surface.</returns>
    private static bool MemberSurfaceCarriesTheDifference(
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        TypeSymbol target)
    {
        var targetMembers = CollectSourceMembers(target);
        foreach (var (name, sourceMember) in sourceMembers)
        {
            if (!targetMembers.TryGetValue(name, out var targetMember))
            {
                continue;
            }

            if (sourceMember.Type != targetMember.Type
                && !ClrTypeUtilities.IsSameAs(sourceMember.Type.ClrType, targetMember.Type.ClrType))
            {
                return true;
            }
        }

        return false;
    }

    private static Type? SafeGetGenericTypeDefinition(Type type)
    {
        try
        {
            return type.GetGenericTypeDefinition();
        }
        catch (InvalidOperationException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    private static bool IsProjectionObjectType(TypeSymbol type)
    {
        if (type is StructSymbol aggregate)
        {
            return !aggregate.IsInline && !aggregate.IsRefStruct;
        }

        if (type is not ImportedTypeSymbol)
        {
            return false;
        }

        var clrType = type.ClrType;
        return clrType != null
            && !clrType.IsSameAs(typeof(object))
            && !clrType.IsSameAs(typeof(string))
            && !clrType.IsPrimitive
            && !clrType.IsEnum
            && !clrType.IsArray
            && !clrType.IsPointer
            && !clrType.IsByRefLike
            && !ClrTypeUtilities.IsDelegateType(clrType);
    }

    private static Dictionary<string, StructuralProjectionSourceMember> CollectSourceMembers(TypeSymbol source)
    {
        var result = new Dictionary<string, StructuralProjectionSourceMember>(StringComparer.Ordinal);
        if (source is StructSymbol structSource)
        {
            foreach (var current in structSource.GetHierarchy())
            {
                foreach (var property in current.Properties)
                {
                    if (property.Accessibility == Accessibility.Public
                        && property.HasGetter && !property.IsStatic && !property.IsIndexer
                        && !result.ContainsKey(property.Name))
                    {
                        result.Add(property.Name, new StructuralProjectionSourceMember(
                            property.Name,
                            property.Type,
                            declaringType: current,
                            property: property));
                    }
                }

                foreach (var field in current.Fields)
                {
                    if (field.Accessibility == Accessibility.Public
                        && !field.IsStatic && !field.IsConst
                        && !result.ContainsKey(field.Name))
                    {
                        result.Add(field.Name, new StructuralProjectionSourceMember(
                            field.Name,
                            field.Type,
                            field: field,
                            declaringType: current));
                    }
                }
            }

            return result;
        }

        var clrType = source.ClrType;
        if (clrType == null)
        {
            return result;
        }

        foreach (var property in ClrTypeUtilities.SafeGetProperties(clrType, PublicInstance))
        {
            if (property.GetIndexParameters().Length == 0
                && property.GetGetMethod(nonPublic: false) != null
                && !result.ContainsKey(property.Name))
            {
                result.Add(property.Name, new StructuralProjectionSourceMember(
                    property.Name,
                    TypeSymbol.FromClrType(property.PropertyType),
                    clrMember: property));
            }
        }

        foreach (var field in ClrTypeUtilities.SafeGetFields(clrType, PublicInstance))
        {
            if (!field.IsStatic && !field.IsLiteral && !result.ContainsKey(field.Name))
            {
                result.Add(field.Name, new StructuralProjectionSourceMember(
                    field.Name,
                    TypeSymbol.FromClrType(field.FieldType),
                    clrMember: field));
            }
        }

        return result;
    }
}
