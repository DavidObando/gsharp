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
        StructSymbol userType = null,
        ConstructorSymbol userConstructor = null,
        ConstructorInfo clrConstructor = null)
    {
        Kind = kind;
        UserType = userType;
        UserConstructor = userConstructor;
        ClrConstructor = clrConstructor;
    }

    public StructuralProjectionConstructionKind Kind { get; }

    public StructSymbol UserType { get; }

    public ConstructorSymbol UserConstructor { get; }

    public ConstructorInfo ClrConstructor { get; }
}

internal sealed class StructuralProjectionSlot
{
    public StructuralProjectionSlot(
        string name,
        TypeSymbol targetType,
        StructuralProjectionSourceMember source,
        FieldSymbol targetField = null,
        StructSymbol targetDeclaringType = null,
        PropertySymbol targetProperty = null,
        MemberInfo targetClrMember = null,
        ParameterSymbol userDefaultParameter = null,
        ParameterInfo clrDefaultParameter = null)
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
    public StructuralProjectionSourceMember Source { get; }

    public FieldSymbol TargetField { get; }

    public StructSymbol TargetDeclaringType { get; }

    public PropertySymbol TargetProperty { get; }

    public MemberInfo TargetClrMember { get; }

    public ParameterSymbol UserDefaultParameter { get; }

    public ParameterInfo ClrDefaultParameter { get; }
}

internal sealed class StructuralProjectionSourceMember
{
    public StructuralProjectionSourceMember(
        string name,
        TypeSymbol type,
        FieldSymbol field = null,
        StructSymbol declaringType = null,
        PropertySymbol property = null,
        MemberInfo clrMember = null)
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

    public FieldSymbol Field { get; }

    public StructSymbol DeclaringType { get; }

    public PropertySymbol Property { get; }

    public MemberInfo ClrMember { get; }
}

internal static class StructuralProjectionPlanner
{
    private const BindingFlags PublicInstance = BindingFlags.Public | BindingFlags.Instance;

    public static bool CanProject(TypeSymbol source, TypeSymbol target)
        => TryCreate(source, target, strict: true, explicitMemberNames: null, out _, out _);

    public static bool TryCreate(
        TypeSymbol source,
        TypeSymbol target,
        bool strict,
        ISet<string> explicitMemberNames,
        out StructuralProjectionPlan plan,
        out string failure)
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
        ISet<string> explicitNames,
        out StructuralProjectionPlan plan,
        out string failure)
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

            if (!TryCreateSlot(parameter.Name, parameterType, sourceMembers, explicitNames, required: true, out var slot, out failure))
            {
                return false;
            }

            constructorSlots.Add(slot);
        }

        var initializerSlots = ImmutableArray.CreateBuilder<StructuralProjectionSlot>();
        var targetNames = new HashSet<string>(constructorNames, StringComparer.Ordinal);
        for (var current = target; current != null; current = current.BaseClass)
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

    private static StructuralProjectionConstruction SelectUserConstruction(
        StructSymbol target,
        Dictionary<string, StructuralProjectionSourceMember> sourceMembers,
        ISet<string> explicitNames,
        out ImmutableArray<(ParameterSymbol Parameter, TypeSymbol Type)> parameters,
        out string failure)
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
            ConstructorSymbol selected = null;
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
        ISet<string> explicitNames,
        out StructuralProjectionPlan plan,
        out string failure)
    {
        plan = null;
        failure = null;
        var clrType = target.ClrType;
        if (clrType == null || clrType.IsInterface || clrType.IsAbstract || clrType.ContainsGenericParameters)
        {
            return false;
        }

        ConstructorInfo constructor = null;
        ParameterInfo[] constructorParameters = Array.Empty<ParameterInfo>();
        var constructors = ClrTypeUtilities.SafeGetConstructors(clrType, PublicInstance);
        if (!clrType.IsValueType)
        {
            constructor = constructors.FirstOrDefault(c => c.GetParameters().Length == 0);
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
            constructor = constructors.FirstOrDefault(c => c.GetParameters().Length == 0);
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

            if (!TryCreateSlot(parameterName, parameterType, sourceMembers, explicitNames, required: true, out var slot, out failure))
            {
                return false;
            }

            constructorSlots.Add(slot);
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
        ISet<string> explicitNames,
        bool required,
        out StructuralProjectionSlot slot,
        out string failure)
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
        ISet<string> explicitNames)
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
        ISet<string> explicitNames)
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

    private static bool HasMappedSlot(StructuralProjectionPlan plan, ISet<string> explicitNames)
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
            for (var current = structSource; current != null; current = current.BaseClass)
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
