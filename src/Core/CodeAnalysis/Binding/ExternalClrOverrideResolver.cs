// <copyright file="ExternalClrOverrideResolver.cs" company="GSharp">
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
/// Resolves override declarations against virtual members inherited from an
/// imported CLR base class.
/// </summary>
internal static class ExternalClrOverrideResolver
{
    private enum SourceSlotStatus
    {
        Missing,
        Implemented,
        AbstractMethod,
        AbstractAccessor,
    }

    private enum AccessorKind
    {
        Getter,
        Setter,
        Add,
        Remove,
        Raise,
    }

    internal static MatchResult<MethodInfo> FindMethod(
        StructSymbol derivedType,
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        RefKind returnRefKind,
        ImmutableArray<TypeParameterSymbol> typeParameters,
        Accessibility accessibility,
        ReferenceResolver references)
    {
        bool sawName = false;
        var externalBase = FindExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        var methodTypeArguments = BuildMethodTypeArguments(typeParameters);
        foreach (var method in EnumerateMethods(reflectionBaseType, name))
        {
            if (!IsAccessibleOverrideTarget(method, accessibility, references))
            {
                continue;
            }

            sawName = true;
            if (method.GetGenericArguments().Length != typeParameters.Length
                || !ParametersMatch(method.GetParameters(), parameters, typeSubstitutions, method, methodTypeArguments)
                || !ReturnMatches(method.ReturnType, returnType, returnRefKind, typeSubstitutions, method, methodTypeArguments))
            {
                continue;
            }

            if (!method.IsVirtual || method.IsFinal)
            {
                return new MatchResult<MethodInfo>(null, externalBase, sawName, isSealed: true);
            }

            return new MatchResult<MethodInfo>(method, externalBase, sawName, isSealed: false);
        }

        return new MatchResult<MethodInfo>(null, externalBase, sawName, isSealed: false);
    }

    internal static MatchResult<PropertyInfo> FindProperty(
        StructSymbol derivedType,
        string name,
        ImmutableArray<ParameterSymbol> indexParameters,
        TypeSymbol propertyType,
        bool hasGetter,
        bool hasSetter,
        Accessibility getterAccessibility,
        Accessibility setterAccessibility,
        ReferenceResolver references)
    {
        bool sawName = false;
        var externalBase = FindExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        foreach (var property in EnumerateProperties(reflectionBaseType, name))
        {
            var getter = property.GetGetMethod(nonPublic: true);
            var setter = property.GetSetMethod(nonPublic: true);
            if (getter == null && setter == null)
            {
                continue;
            }

            if ((hasGetter && getter == null)
                || (hasSetter && setter == null)
                || (!hasGetter && getter != null)
                || (!hasSetter && setter != null)
                || (getter != null && !IsAccessibleOverrideTarget(getter, getterAccessibility, references))
                || (setter != null && !IsAccessibleOverrideTarget(setter, setterAccessibility, references)))
            {
                continue;
            }

            sawName = true;
            if (!ParametersMatch(property.GetIndexParameters(), indexParameters, typeSubstitutions)
                || !PropertyTypeMatches(property.PropertyType, propertyType, hasSetter, typeSubstitutions))
            {
                continue;
            }

            if ((getter != null && (!getter.IsVirtual || getter.IsFinal))
                || (setter != null && (!setter.IsVirtual || setter.IsFinal)))
            {
                return new MatchResult<PropertyInfo>(null, externalBase, sawName, isSealed: true);
            }

            return new MatchResult<PropertyInfo>(property, externalBase, sawName, isSealed: false);
        }

        return new MatchResult<PropertyInfo>(null, externalBase, sawName, isSealed: false);
    }

    internal static MatchResult<EventInfo> FindEvent(
        StructSymbol derivedType,
        string name,
        TypeSymbol handlerType,
        Accessibility accessibility,
        ReferenceResolver references)
    {
        bool sawName = false;
        var externalBase = FindExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        foreach (var eventInfo in EnumerateEvents(reflectionBaseType, name))
        {
            var add = eventInfo.GetAddMethod(nonPublic: true);
            var remove = eventInfo.GetRemoveMethod(nonPublic: true);
            var raise = eventInfo.GetRaiseMethod(nonPublic: true);
            if ((add == null && remove == null)
                || (add != null && !IsAccessibleOverrideTarget(add, accessibility, references))
                || (remove != null && !IsAccessibleOverrideTarget(remove, accessibility, references))
                || (raise != null && !IsAccessibleOverrideTarget(raise, accessibility, references)))
            {
                continue;
            }

            sawName = true;
            if (!TypeMatches(eventInfo.EventHandlerType, handlerType, typeSubstitutions))
            {
                continue;
            }

            if ((add != null && (!add.IsVirtual || add.IsFinal))
                || (remove != null && (!remove.IsVirtual || remove.IsFinal)))
            {
                return new MatchResult<EventInfo>(null, externalBase, sawName, isSealed: true);
            }

            return new MatchResult<EventInfo>(eventInfo, externalBase, sawName, isSealed: false);
        }

        return new MatchResult<EventInfo>(null, externalBase, sawName, isSealed: false);
    }

    internal static ImmutableArray<UnimplementedAbstractMember> GetUnimplementedAbstractMembers(
        StructSymbol derivedType)
    {
        var externalBase = FindDeclaredExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        if (reflectionBaseType == null || !reflectionBaseType.IsAbstract)
        {
            return ImmutableArray<UnimplementedAbstractMember>.Empty;
        }

        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        ImmutableArray<UnimplementedAbstractMember>.Builder? builder = null;
        foreach (var slot in GetEffectiveAbstractSlots(reflectionBaseType, typeSubstitutions))
        {
            var sourceStatus = GetSourceSlotStatus(derivedType, slot);
            if (sourceStatus == SourceSlotStatus.Implemented)
            {
                continue;
            }

            builder ??= ImmutableArray.CreateBuilder<UnimplementedAbstractMember>();
            builder.Add(new UnimplementedAbstractMember(
                GetDeclaringTypeDisplayName(slot.DeclaringType),
                GetMemberDisplayName(slot),
                sourceStatus == SourceSlotStatus.AbstractMethod));
        }

        return builder?.ToImmutable() ?? ImmutableArray<UnimplementedAbstractMember>.Empty;
    }

    internal static bool HasUnimplementedAbstractMembers(StructSymbol derivedType)
        => !GetUnimplementedAbstractMembers(derivedType).IsDefaultOrEmpty;

    private static TypeSymbol? FindDeclaredExternalBaseType(StructSymbol type)
    {
        foreach (var current in GetStructHierarchy(type))
        {
            if (current.ImportedBaseType != null)
            {
                return current.ImportedBaseType;
            }
        }

        return null;
    }

    private static TypeSymbol? FindExternalBaseType(StructSymbol type)
    {
        var declaredBase = FindDeclaredExternalBaseType(type);
        if (declaredBase != null)
        {
            return declaredBase;
        }

        foreach (var current in GetStructHierarchy(type))
        {
            if (current.IsAttributeClass)
            {
                // Attribute sugar emits System.Attribute rather than the CLR
                // implicit Object base handled by this fallback.
                return null;
            }
        }

        return type != null ? TypeSymbol.Object : null;
    }

    private static ImmutableArray<MethodInfo> GetEffectiveAbstractSlots(
        Type reflectionBaseType,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions)
    {
        var hierarchy = GetTypeHierarchy(reflectionBaseType);
        hierarchy.Reverse();

        // Reconstruct effective CLR virtual slots base-first. A newslot method
        // must not satisfy a same-signature abstract slot hidden beneath it.
        var slots = new List<MethodInfo>();
        foreach (var current in hierarchy)
        {
            var declaredMethods = ClrTypeUtilities.SafeGetMethods(
                current,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            foreach (var method in declaredMethods)
            {
                if (method.IsStatic || !method.IsVirtual)
                {
                    continue;
                }

                if (ClrTypeUtilities.SafeIsOverride(method))
                {
                    var overriddenSlot = -1;
                    for (var i = slots.Count - 1; i >= 0; i--)
                    {
                        if (SlotSignaturesMatch(method, slots[i], typeSubstitutions))
                        {
                            overriddenSlot = i;
                            break;
                        }
                    }

                    if (overriddenSlot >= 0)
                    {
                        slots[overriddenSlot] = method;
                        continue;
                    }
                }

                slots.Add(method);
            }
        }

        return slots.Where(method => method.IsAbstract).ToImmutableArray();
    }

    private static bool SlotSignaturesMatch(
        MethodInfo derived,
        MethodInfo baseMethod,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions)
    {
        derived = GetOpenDeclaringMethod(derived);
        baseMethod = GetOpenDeclaringMethod(baseMethod);

        if (!string.Equals(derived.Name, baseMethod.Name, StringComparison.Ordinal))
        {
            return false;
        }

        var derivedMethodArguments = derived.GetGenericArguments();
        var baseMethodArguments = baseMethod.GetGenericArguments();
        if (derivedMethodArguments.Length != baseMethodArguments.Length)
        {
            return false;
        }

        var derivedParameters = derived.GetParameters();
        var baseParameters = baseMethod.GetParameters();
        if (derivedParameters.Length != baseParameters.Length)
        {
            return false;
        }

        var canonicalMethodArguments = BuildCanonicalMethodTypeArguments(derivedMethodArguments.Length);
        var derivedSubstitution = FindTypeArgumentSubstitution(derived.DeclaringType, typeSubstitutions);
        var baseSubstitution = FindTypeArgumentSubstitution(baseMethod.DeclaringType, typeSubstitutions);
        for (var i = 0; i < derivedParameters.Length; i++)
        {
            var derivedType = MemberLookup.MapOpenClrTypeToSymbolic(
                derivedParameters[i].ParameterType,
                derivedSubstitution.OpenDefinition,
                derivedSubstitution.TypeArguments,
                derived,
                canonicalMethodArguments);
            var baseType = MemberLookup.MapOpenClrTypeToSymbolic(
                baseParameters[i].ParameterType,
                baseSubstitution.OpenDefinition,
                baseSubstitution.TypeArguments,
                baseMethod,
                canonicalMethodArguments);
            if (!DeclarationBinder.TypeSignaturesEquivalent(derivedType, baseType))
            {
                return false;
            }
        }

        return true;
    }

    private static MethodInfo GetOpenDeclaringMethod(MethodInfo method)
    {
        var declaringType = method.DeclaringType;
        if (declaringType is not { IsGenericType: true, IsGenericTypeDefinition: false })
        {
            return method;
        }

        try
        {
            var openDefinition = declaringType.GetGenericTypeDefinition();
            foreach (var candidate in ClrTypeUtilities.SafeGetMethods(
                openDefinition,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                if (candidate.MetadataToken == method.MetadataToken && candidate.Module == method.Module)
                {
                    return candidate;
                }
            }
        }
        catch (Exception ex) when (ClrTypeUtilities.IsMetadataLoadFailure(ex))
        {
        }

        return method;
    }

    private static ImmutableArray<TypeSymbol?> BuildCanonicalMethodTypeArguments(int arity)
    {
        if (arity == 0)
        {
            return default;
        }

        var builder = ImmutableArray.CreateBuilder<TypeSymbol?>(arity);
        for (var i = 0; i < arity; i++)
        {
            builder.Add(new TypeParameterSymbol(
                $"T{i}",
                i,
                TypeParameterConstraint.Any,
                TypeParameterVariance.None)
            {
                IsMethodTypeParameter = true,
            });
        }

        return builder.MoveToImmutable();
    }

    private static TypeArgumentSubstitution FindTypeArgumentSubstitution(
        Type? declaringType,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions)
    {
        var declaringDefinition = GetGenericDefinition(declaringType);
        if (declaringDefinition == null)
        {
            return default;
        }

        foreach (var substitution in typeSubstitutions)
        {
            if (ClrTypeUtilities.AreSame(
                GetGenericDefinition(substitution.OpenDefinition),
                declaringDefinition))
            {
                return substitution;
            }
        }

        return default;
    }

    private static Type? GetGenericDefinition(Type? type)
        => type?.IsGenericType == true
            ? type.IsGenericTypeDefinition ? type : type.GetGenericTypeDefinition()
            : type;

    private static List<StructSymbol> GetStructHierarchy(StructSymbol type)
    {
        var hierarchy = new List<StructSymbol>();
        StructSymbol? current = type;
        while (current != null)
        {
            hierarchy.Add(current);
            current = current.BaseClass;
        }

        return hierarchy;
    }

    private static List<Type> GetTypeHierarchy(Type? type)
    {
        var hierarchy = new List<Type>();
        var current = type;
        while (current != null)
        {
            hierarchy.Add(current);
            current = current.BaseType;
        }

        return hierarchy;
    }

    private static SourceSlotStatus GetSourceSlotStatus(StructSymbol derivedType, MethodInfo slot)
    {
        foreach (var current in GetStructHierarchy(derivedType))
        {
            foreach (var method in current.Methods)
            {
                if (TargetsExternalSlot(method, slot))
                {
                    return method.IsAbstract
                        ? SourceSlotStatus.AbstractMethod
                        : SourceSlotStatus.Implemented;
                }
            }

            foreach (var property in current.Properties)
            {
                if (TryGetPropertyAccessorKind(property, slot, out var accessorKind))
                {
                    return IsPropertyAccessorImplemented(property, accessorKind)
                        ? SourceSlotStatus.Implemented
                        : SourceSlotStatus.AbstractAccessor;
                }
            }

            foreach (var eventSymbol in current.Events)
            {
                if (TryGetEventAccessorKind(eventSymbol, slot, out var accessorKind))
                {
                    return IsEventAccessorImplemented(eventSymbol, accessorKind)
                        ? SourceSlotStatus.Implemented
                        : SourceSlotStatus.AbstractAccessor;
                }
            }
        }

        return SourceSlotStatus.Missing;
    }

    private static bool TargetsExternalSlot(FunctionSymbol method, MethodInfo slot)
    {
        FunctionSymbol? current = method;
        while (current != null)
        {
            if (SameMethod(current.ExternalOverriddenMethod, slot))
            {
                return true;
            }

            current = current.OverriddenMethod;
        }

        return false;
    }

    private static bool TryGetPropertyAccessorKind(
        PropertySymbol property,
        MethodInfo slot,
        out AccessorKind accessorKind)
    {
        PropertySymbol? current = property;
        while (current != null)
        {
            if (SameMethod(current.ExternalOverriddenGetter, slot))
            {
                accessorKind = AccessorKind.Getter;
                return true;
            }

            if (SameMethod(current.ExternalOverriddenSetter, slot))
            {
                accessorKind = AccessorKind.Setter;
                return true;
            }

            current = current.OverriddenProperty;
        }

        accessorKind = default;
        return false;
    }

    private static bool IsPropertyAccessorImplemented(
        PropertySymbol property,
        AccessorKind accessorKind)
        => accessorKind switch
        {
            AccessorKind.Getter => property.HasGetter
                && (property.IsAutoProperty
                    || property.GetterBodySyntax != null
                    || property.GetterSymbol is { IsAbstract: false }),
            AccessorKind.Setter => property.HasSetter
                && (property.IsAutoProperty
                    || property.SetterBodySyntax != null
                    || property.SetterSymbol is { IsAbstract: false }),
            _ => false,
        };

    private static bool TryGetEventAccessorKind(
        EventSymbol eventSymbol,
        MethodInfo slot,
        out AccessorKind accessorKind)
    {
        EventSymbol? current = eventSymbol;
        while (current != null)
        {
            if (SameMethod(current.ExternalOverriddenAddMethod, slot))
            {
                accessorKind = AccessorKind.Add;
                return true;
            }

            if (SameMethod(current.ExternalOverriddenRemoveMethod, slot))
            {
                accessorKind = AccessorKind.Remove;
                return true;
            }

            if (SameMethod(current.ExternalOverriddenRaiseMethod, slot))
            {
                accessorKind = AccessorKind.Raise;
                return true;
            }

            current = current.OverriddenEvent;
        }

        accessorKind = default;
        return false;
    }

    private static bool IsEventAccessorImplemented(
        EventSymbol eventSymbol,
        AccessorKind accessorKind)
        => accessorKind switch
        {
            AccessorKind.Add => eventSymbol.IsFieldLike || eventSymbol.AddBodySyntax != null,
            AccessorKind.Remove => eventSymbol.IsFieldLike || eventSymbol.RemoveBodySyntax != null,
            AccessorKind.Raise => eventSymbol.RaiseBodySyntax != null,
            _ => false,
        };

    private static bool SameMethod(MethodInfo? left, MethodInfo right)
    {
        if (left == null)
        {
            return false;
        }

        if (ReferenceEquals(left, right))
        {
            return true;
        }

        try
        {
            return left.MetadataToken == right.MetadataToken
                && ClrTypeUtilities.AreSame(left.DeclaringType, right.DeclaringType);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static string GetDeclaringTypeDisplayName(Type? declaringType)
    {
        var name = declaringType?.Name ?? "?";
        var arityMarker = name.IndexOf('`');
        return arityMarker >= 0 ? name[..arityMarker] : name;
    }

    private static string GetMemberDisplayName(MethodInfo slot)
    {
        var name = slot.Name;
        if (name.StartsWith("get_", StringComparison.Ordinal))
        {
            return name[4..] + ".get";
        }

        if (name.StartsWith("set_", StringComparison.Ordinal))
        {
            return name[4..] + ".set";
        }

        if (name.StartsWith("add_", StringComparison.Ordinal))
        {
            return name[4..] + ".add";
        }

        if (name.StartsWith("remove_", StringComparison.Ordinal))
        {
            return name[7..] + ".remove";
        }

        if (name.StartsWith("raise_", StringComparison.Ordinal))
        {
            return name[6..] + ".raise";
        }

        return name;
    }

    private static Type? GetReflectionBaseType(TypeSymbol? importedBase)
        => importedBase is ImportedTypeSymbol { OpenDefinition: not null } imported
            && imported.HasSubstitutableTypeArgument
                ? imported.OpenDefinition
                : importedBase?.ClrType;

    private static ImmutableArray<TypeSymbol> GetSymbolicTypeArguments(TypeSymbol? importedBase)
        => importedBase is ImportedTypeSymbol { OpenDefinition: not null, HasSubstitutableTypeArgument: true } imported
            ? imported.TypeArguments
            : ImmutableArray<TypeSymbol>.Empty;

    private static ImmutableArray<TypeArgumentSubstitution> BuildTypeArgumentSubstitutions(TypeSymbol? externalBase)
    {
        var root = new TypeArgumentSubstitution(
            GetReflectionBaseType(externalBase),
            GetSymbolicTypeArguments(externalBase));
        if (externalBase is not ImportedTypeSymbol { OpenDefinition: not null } imported
            || imported.TypeArguments.IsDefaultOrEmpty)
        {
            return ImmutableArray.Create(root);
        }

        var substitutions = ImmutableArray.CreateBuilder<TypeArgumentSubstitution>();
        substitutions.Add(root);
        foreach (var current in GetTypeHierarchy(imported.OpenDefinition.BaseType))
        {
            if (!current.IsGenericType)
            {
                continue;
            }

            var openDefinition = current.IsGenericTypeDefinition
                ? current
                : current.GetGenericTypeDefinition();
            if (ClrTypeUtilities.AreSame(openDefinition, imported.OpenDefinition)
                || !MemberLookup.TryMapConstructedTypeArgumentsThroughHierarchy(
                    imported,
                    openDefinition,
                    out var mappedArguments))
            {
                continue;
            }

            substitutions.Add(new TypeArgumentSubstitution(openDefinition, mappedArguments));
        }

        return substitutions.ToImmutable();
    }

    private static ImmutableArray<TypeSymbol?> BuildMethodTypeArguments(
        ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        if (typeParameters.IsDefaultOrEmpty)
        {
            return default;
        }

        var typeArguments = ImmutableArray.CreateBuilder<TypeSymbol?>(typeParameters.Length);
        foreach (var typeParameter in typeParameters)
        {
            typeArguments.Add(typeParameter);
        }

        return typeArguments.MoveToImmutable();
    }

    private static List<MethodInfo> EnumerateMethods(Type? baseType, string name)
    {
        var result = new List<MethodInfo>();
        foreach (var current in GetTypeHierarchy(baseType))
        {
            MethodInfo[] methods;
            try
            {
                methods = current.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            }
            catch (Exception ex) when (ex is NotSupportedException or InvalidOperationException)
            {
                continue;
            }

            foreach (var method in methods)
            {
                if (string.Equals(method.Name, name, StringComparison.Ordinal))
                {
                    result.Add(method);
                }
            }
        }

        return result;
    }

    private static List<PropertyInfo> EnumerateProperties(Type? baseType, string name)
    {
        var result = new List<PropertyInfo>();
        foreach (var current in GetTypeHierarchy(baseType))
        {
            PropertyInfo[] properties;
            try
            {
                properties = current.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            }
            catch (Exception ex) when (ex is NotSupportedException or InvalidOperationException)
            {
                continue;
            }

            foreach (var property in properties)
            {
                if (string.Equals(property.Name, name, StringComparison.Ordinal))
                {
                    result.Add(property);
                }
            }
        }

        return result;
    }

    private static List<EventInfo> EnumerateEvents(Type? baseType, string name)
    {
        var result = new List<EventInfo>();
        foreach (var current in GetTypeHierarchy(baseType))
        {
            EventInfo[] events;
            try
            {
                events = current.GetEvents(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            }
            catch (Exception ex) when (ex is NotSupportedException or InvalidOperationException)
            {
                continue;
            }

            foreach (var eventInfo in events)
            {
                if (string.Equals(eventInfo.Name, name, StringComparison.Ordinal))
                {
                    result.Add(eventInfo);
                }
            }
        }

        return result;
    }

    private static bool ParametersMatch(
        ParameterInfo[] clrParameters,
        ImmutableArray<ParameterSymbol> parameters,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions,
        MethodInfo? openMethodDefinition = null,
        ImmutableArray<TypeSymbol?> methodTypeArguments = default)
    {
        if (clrParameters.Length != parameters.Length)
        {
            return false;
        }

        for (var i = 0; i < clrParameters.Length; i++)
        {
            var clrParameter = clrParameters[i];
            var clrType = clrParameter.ParameterType;
            var clrRefKind = RefKind.None;
            if (clrType.IsByRef)
            {
                clrRefKind = clrParameter.IsOut
                    ? RefKind.Out
                    : clrParameter.IsIn
                        ? RefKind.In
                        : RefKind.Ref;
                clrType = clrType.GetElementType();
            }

            if (clrRefKind != parameters[i].RefKind
                || !TypeMatches(
                    clrType,
                    parameters[i].Type,
                    typeSubstitutions,
                    openMethodDefinition,
                    methodTypeArguments))
            {
                return false;
            }
        }

        return true;
    }

    private static bool ReturnMatches(
        Type? clrReturnType,
        TypeSymbol returnType,
        RefKind returnRefKind,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions,
        MethodInfo? openMethodDefinition = null,
        ImmutableArray<TypeSymbol?> methodTypeArguments = default)
    {
        if (clrReturnType == null)
        {
            return false;
        }

        var clrReturnsByRef = clrReturnType.IsByRef;
        if ((returnRefKind == RefKind.Ref) != clrReturnsByRef)
        {
            return false;
        }

        if (clrReturnsByRef)
        {
            clrReturnType = clrReturnType.GetElementType();
            if (clrReturnType == null)
            {
                return false;
            }
        }

        if (TypeMatches(
            clrReturnType,
            returnType,
            typeSubstitutions,
            openMethodDefinition,
            methodTypeArguments))
        {
            return true;
        }

        return returnRefKind == RefKind.None && IsCovariantReturn(clrReturnType, returnType);
    }

    private static bool PropertyTypeMatches(
        Type? clrPropertyType,
        TypeSymbol propertyType,
        bool hasSetter,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions)
        => TypeMatches(
            clrPropertyType,
            propertyType,
            typeSubstitutions)
            || (!hasSetter && IsCovariantReturn(clrPropertyType, propertyType));

    private static bool TypeMatches(
        Type? clrType,
        TypeSymbol type,
        ImmutableArray<TypeArgumentSubstitution> typeSubstitutions,
        MethodInfo? openMethodDefinition = null,
        ImmutableArray<TypeSymbol?> methodTypeArguments = default)
    {
        type = type switch
        {
            NullabilityAnnotatedTypeSymbol annotated => annotated.BaseType,
            _ => type,
        };

        foreach (var substitution in typeSubstitutions)
        {
            var substituted = MemberLookup.MapOpenClrTypeToSymbolic(
                clrType,
                substitution.OpenDefinition,
                substitution.TypeArguments,
                openMethodDefinition,
                methodTypeArguments);
            if (DeclarationBinder.TypeSignaturesEquivalent(substituted, type))
            {
                return true;
            }
        }

        var effectiveClrType = NullableLifting.GetEffectiveClrType(type);
        if (effectiveClrType != null && clrType != null)
        {
            return ClrTypeUtilities.AreSame(clrType, effectiveClrType);
        }

        return false;
    }

    private static bool IsCovariantReturn(Type? baseReturnType, TypeSymbol derivedReturnType)
    {
        if (baseReturnType == null)
        {
            return false;
        }

        var derivedClrType = NullableLifting.GetEffectiveClrType(derivedReturnType);
        if (derivedClrType != null)
        {
            return !baseReturnType.IsValueType
                && !derivedClrType.IsValueType
                && ClrTypeUtilities.IsAssignableByName(baseReturnType, derivedClrType);
        }

        if (derivedReturnType is StructSymbol derivedStruct && derivedStruct.IsClass)
        {
            foreach (var current in GetStructHierarchy(derivedStruct))
            {
                if (current.ImportedBaseType?.ClrType is Type imported
                    && ClrTypeUtilities.IsAssignableByName(baseReturnType, imported))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool IsAccessibleOverrideTarget(
        MethodInfo method,
        Accessibility accessibility,
        ReferenceResolver references)
    {
        if (method.IsPublic)
        {
            return accessibility == Accessibility.Public;
        }

        if (method.IsFamily || method.IsFamilyOrAssembly)
        {
            return accessibility == Accessibility.Protected;
        }

        if (method.IsAssembly)
        {
            return accessibility == Accessibility.Internal
                && references.CanAccessInternalMembers(method.DeclaringType?.Assembly);
        }

        // FamANDAssem requires private-protected visibility. G# cannot emit
        // that combined accessibility, and Family would widen the override.
        return false;
    }

    internal readonly record struct UnimplementedAbstractMember(
        string DeclaringTypeName,
        string MemberName,
        bool ReportedBySourceAbstractMethod);

    internal readonly struct MatchResult<T>
        where T : MemberInfo
    {
        public MatchResult(
            T? member,
            TypeSymbol? containingType,
            bool sawName,
            bool isSealed)
        {
            Member = member;
            ContainingType = containingType;
            SawName = sawName;
            IsSealed = isSealed;
        }

        public T? Member { get; }

        public TypeSymbol? ContainingType { get; }

        public bool SawName { get; }

        public bool IsSealed { get; }
    }

    private readonly record struct TypeArgumentSubstitution(
        Type? OpenDefinition,
        ImmutableArray<TypeSymbol> TypeArguments);
}
