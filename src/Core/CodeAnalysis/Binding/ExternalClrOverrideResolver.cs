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
        var typeArguments = GetSymbolicTypeArguments(externalBase);
        foreach (var method in EnumerateMethods(GetReflectionBaseType(externalBase), name))
        {
            if (!IsAccessibleOverrideTarget(method, accessibility))
            {
                continue;
            }

            sawName = true;
            if (method.GetGenericArguments().Length != typeParameters.Length
                || !ParametersMatch(method.GetParameters(), parameters, typeParameters, typeArguments)
                || !ReturnMatches(method.ReturnType, returnType, returnRefKind, typeParameters, typeArguments))
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
        var typeArguments = GetSymbolicTypeArguments(externalBase);
        foreach (var property in EnumerateProperties(GetReflectionBaseType(externalBase), name))
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
                || !ParametersMatch(property.GetIndexParameters(), indexParameters, ImmutableArray<TypeParameterSymbol>.Empty, typeArguments)
                || !PropertyTypeMatches(property.PropertyType, propertyType, hasSetter, typeArguments))
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
        var typeArguments = GetSymbolicTypeArguments(externalBase);
        foreach (var eventInfo in EnumerateEvents(GetReflectionBaseType(externalBase), name))
        {
            var add = eventInfo.GetAddMethod(nonPublic: true);
            var remove = eventInfo.GetRemoveMethod(nonPublic: true);
            var representative = add ?? remove;
            if (representative == null || !IsAccessibleOverrideTarget(representative, accessibility))
            {
                continue;
            }

            sawName = true;
            if (!TypeMatches(eventInfo.EventHandlerType, handlerType, ImmutableArray<TypeParameterSymbol>.Empty, typeArguments))
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

    private static TypeSymbol FindExternalBaseType(StructSymbol type)
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

        return type?.IsClass == true ? TypeSymbol.Object : null;
    }

    private static Type GetReflectionBaseType(TypeSymbol importedBase)
        => importedBase is ImportedTypeSymbol { OpenDefinition: not null } imported
            && imported.HasSubstitutableTypeArgument
                ? imported.OpenDefinition
                : importedBase?.ClrType;

    private static ImmutableArray<TypeSymbol> GetSymbolicTypeArguments(TypeSymbol importedBase)
        => importedBase is ImportedTypeSymbol { OpenDefinition: not null, HasSubstitutableTypeArgument: true } imported
            ? imported.TypeArguments
            : ImmutableArray<TypeSymbol>.Empty;

    private static IEnumerable<MethodInfo> EnumerateMethods(Type baseType, string name)
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

    private static IEnumerable<PropertyInfo> EnumerateProperties(Type baseType, string name)
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

    private static IEnumerable<EventInfo> EnumerateEvents(Type baseType, string name)
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
        ImmutableArray<TypeParameterSymbol> typeParameters,
        ImmutableArray<TypeSymbol> containingTypeArguments)
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
                || !TypeMatches(clrType, parameters[i].Type, typeParameters, containingTypeArguments))
            {
                return false;
            }
        }

        return true;
    }

    private static bool ReturnMatches(
        Type clrReturnType,
        TypeSymbol returnType,
        RefKind returnRefKind,
        ImmutableArray<TypeParameterSymbol> typeParameters,
        ImmutableArray<TypeSymbol> containingTypeArguments)
    {
        var clrReturnsByRef = clrReturnType.IsByRef;
        if ((returnRefKind == RefKind.Ref) != clrReturnsByRef)
        {
            return false;
        }

        if (clrReturnsByRef)
        {
            clrReturnType = clrReturnType.GetElementType();
        }

        if (TypeMatches(clrReturnType, returnType, typeParameters, containingTypeArguments))
        {
            return true;
        }

        return returnRefKind == RefKind.None && IsCovariantReturn(clrReturnType, returnType);
    }

    private static bool PropertyTypeMatches(
        Type clrPropertyType,
        TypeSymbol propertyType,
        bool hasSetter,
        ImmutableArray<TypeSymbol> containingTypeArguments)
        => TypeMatches(
            clrPropertyType,
            propertyType,
            ImmutableArray<TypeParameterSymbol>.Empty,
            containingTypeArguments)
            || (!hasSetter && IsCovariantReturn(clrPropertyType, propertyType));

    private static bool TypeMatches(
        Type clrType,
        TypeSymbol type,
        ImmutableArray<TypeParameterSymbol> methodTypeParameters,
        ImmutableArray<TypeSymbol> containingTypeArguments)
    {
        type = type switch
        {
            NullabilityAnnotatedTypeSymbol annotated => annotated.BaseType,
            _ => type,
        };

        if (type is TypeParameterSymbol typeParameter)
        {
            if (clrType == null || !clrType.IsGenericParameter)
            {
                return false;
            }

            if (clrType.DeclaringMethod != null)
            {
                return typeParameter.Ordinal < methodTypeParameters.Length
                    && ReferenceEquals(typeParameter, methodTypeParameters[typeParameter.Ordinal])
                    && clrType.GenericParameterPosition == typeParameter.Ordinal;
            }

            return clrType.GenericParameterPosition < containingTypeArguments.Length
                && TypeSymbolsMatch(containingTypeArguments[clrType.GenericParameterPosition], typeParameter);
        }

        var effectiveClrType = NullableLifting.GetEffectiveClrType(type);
        if (effectiveClrType != null && clrType != null)
        {
            return ClrTypeUtilities.AreSame(clrType, effectiveClrType);
        }

        return false;
    }

    private static bool TypeSymbolsMatch(TypeSymbol left, TypeSymbol right)
    {
        if (ReferenceEquals(left, right))
        {
            return true;
        }

        var leftClr = NullableLifting.GetEffectiveClrType(left);
        var rightClr = NullableLifting.GetEffectiveClrType(right);
        return leftClr != null && rightClr != null && ClrTypeUtilities.AreSame(leftClr, rightClr);
    }

    private static bool IsCovariantReturn(Type baseReturnType, TypeSymbol derivedReturnType)
    {
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
        T Member,
        TypeSymbol ContainingType,
        bool SawName,
        bool IsSealed)
        where T : MemberInfo;
}
