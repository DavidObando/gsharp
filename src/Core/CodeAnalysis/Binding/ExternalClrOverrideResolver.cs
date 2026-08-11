// <copyright file="ExternalClrOverrideResolver.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Resolves override declarations against virtual members inherited from an
/// imported CLR base class.
/// </summary>
internal static class ExternalClrOverrideResolver
{
    internal static MatchResult<MethodInfo> FindMethod(
        StructSymbol derivedType,
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        RefKind returnRefKind,
        ImmutableArray<TypeParameterSymbol> typeParameters,
        Accessibility accessibility)
    {
        bool sawName = false;
        var externalBase = FindExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        var methodTypeArguments = BuildMethodTypeArguments(typeParameters);
        foreach (var method in EnumerateMethods(reflectionBaseType, name))
        {
            if (!IsAccessibleOverrideTarget(method, accessibility))
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
                return new MatchResult<MethodInfo>(null, externalBase, sawName, IsSealed: true);
            }

            return new MatchResult<MethodInfo>(method, externalBase, sawName, IsSealed: false);
        }

        return new MatchResult<MethodInfo>(null, externalBase, sawName, IsSealed: false);
    }

    internal static MatchResult<PropertyInfo> FindProperty(
        StructSymbol derivedType,
        string name,
        ImmutableArray<ParameterSymbol> indexParameters,
        TypeSymbol propertyType,
        bool hasGetter,
        bool hasSetter,
        Accessibility accessibility)
    {
        bool sawName = false;
        var externalBase = FindExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        foreach (var property in EnumerateProperties(reflectionBaseType, name))
        {
            var getter = property.GetGetMethod(nonPublic: true);
            var setter = property.GetSetMethod(nonPublic: true);
            var representative = getter ?? setter;
            if (representative == null || !IsAccessibleOverrideTarget(representative, accessibility))
            {
                continue;
            }

            sawName = true;
            if ((hasGetter && getter == null)
                || (hasSetter && setter == null)
                || (!hasGetter && getter != null)
                || (!hasSetter && setter != null)
                || !ParametersMatch(property.GetIndexParameters(), indexParameters, typeSubstitutions)
                || !PropertyTypeMatches(property.PropertyType, propertyType, hasSetter, typeSubstitutions))
            {
                continue;
            }

            if ((getter != null && (!getter.IsVirtual || getter.IsFinal))
                || (setter != null && (!setter.IsVirtual || setter.IsFinal)))
            {
                return new MatchResult<PropertyInfo>(null, externalBase, sawName, IsSealed: true);
            }

            return new MatchResult<PropertyInfo>(property, externalBase, sawName, IsSealed: false);
        }

        return new MatchResult<PropertyInfo>(null, externalBase, sawName, IsSealed: false);
    }

    internal static MatchResult<EventInfo> FindEvent(
        StructSymbol derivedType,
        string name,
        TypeSymbol handlerType,
        Accessibility accessibility)
    {
        bool sawName = false;
        var externalBase = FindExternalBaseType(derivedType);
        var reflectionBaseType = GetReflectionBaseType(externalBase);
        var typeSubstitutions = BuildTypeArgumentSubstitutions(externalBase);
        foreach (var eventInfo in EnumerateEvents(reflectionBaseType, name))
        {
            var add = eventInfo.GetAddMethod(nonPublic: true);
            var remove = eventInfo.GetRemoveMethod(nonPublic: true);
            var representative = add ?? remove;
            if (representative == null || !IsAccessibleOverrideTarget(representative, accessibility))
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
                return new MatchResult<EventInfo>(null, externalBase, sawName, IsSealed: true);
            }

            return new MatchResult<EventInfo>(eventInfo, externalBase, sawName, IsSealed: false);
        }

        return new MatchResult<EventInfo>(null, externalBase, sawName, IsSealed: false);
    }

    private static TypeSymbol? FindExternalBaseType(StructSymbol type)
    {
        for (var current = type; current != null; current = current.BaseClass)
        {
            if (current.ImportedBaseType != null)
            {
                return current.ImportedBaseType;
            }

            if (current.IsAttributeClass)
            {
                // Attribute sugar emits System.Attribute rather than the CLR
                // implicit Object base handled by this fallback.
                return null;
            }
        }

        return type != null ? TypeSymbol.Object : null;
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
        for (var current = imported.OpenDefinition.BaseType; current != null; current = current.BaseType)
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

    private static IEnumerable<MethodInfo> EnumerateMethods(Type? baseType, string name)
    {
        for (var current = baseType; current != null; current = current.BaseType)
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
                    yield return method;
                }
            }
        }
    }

    private static IEnumerable<PropertyInfo> EnumerateProperties(Type? baseType, string name)
    {
        for (var current = baseType; current != null; current = current.BaseType)
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
                    yield return property;
                }
            }
        }
    }

    private static IEnumerable<EventInfo> EnumerateEvents(Type? baseType, string name)
    {
        for (var current = baseType; current != null; current = current.BaseType)
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
                    yield return eventInfo;
                }
            }
        }
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
            for (var current = derivedStruct; current != null; current = current.BaseClass)
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

    private static bool IsAccessibleOverrideTarget(MethodInfo method, Accessibility accessibility)
    {
        if (method.IsPublic)
        {
            return accessibility == Accessibility.Public;
        }

        if (method.IsFamily || method.IsFamilyOrAssembly)
        {
            return accessibility == Accessibility.Protected;
        }

        return false;
    }

    internal readonly record struct MatchResult<T>(
        T? Member,
        TypeSymbol? ContainingType,
        bool SawName,
        bool IsSealed)
        where T : MemberInfo;

    private readonly record struct TypeArgumentSubstitution(
        Type? OpenDefinition,
        ImmutableArray<TypeSymbol> TypeArguments);
}
