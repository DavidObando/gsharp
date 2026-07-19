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
        foreach (var method in EnumerateMethods(FindImportedBaseType(derivedType), name))
        {
            if (!IsAccessibleOverrideTarget(method, accessibility))
            {
                continue;
            }

            sawName = true;
            if (method.GetGenericArguments().Length != typeParameters.Length
                || !ParametersMatch(method.GetParameters(), parameters, typeParameters)
                || !ReturnMatches(method.ReturnType, returnType, returnRefKind, typeParameters))
            {
                continue;
            }

            if (!method.IsVirtual || method.IsFinal)
            {
                return new MatchResult<MethodInfo>(null, sawName, IsSealed: true);
            }

            return new MatchResult<MethodInfo>(method, sawName, IsSealed: false);
        }

        return new MatchResult<MethodInfo>(null, sawName, IsSealed: false);
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
        foreach (var property in EnumerateProperties(FindImportedBaseType(derivedType), name))
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
                || !ParametersMatch(property.GetIndexParameters(), indexParameters, ImmutableArray<TypeParameterSymbol>.Empty)
                || !PropertyTypeMatches(property.PropertyType, propertyType, hasSetter))
            {
                continue;
            }

            if ((getter != null && (!getter.IsVirtual || getter.IsFinal))
                || (setter != null && (!setter.IsVirtual || setter.IsFinal)))
            {
                return new MatchResult<PropertyInfo>(null, sawName, IsSealed: true);
            }

            return new MatchResult<PropertyInfo>(property, sawName, IsSealed: false);
        }

        return new MatchResult<PropertyInfo>(null, sawName, IsSealed: false);
    }

    internal static MatchResult<EventInfo> FindEvent(
        StructSymbol derivedType,
        string name,
        TypeSymbol handlerType,
        Accessibility accessibility)
    {
        bool sawName = false;
        foreach (var eventInfo in EnumerateEvents(FindImportedBaseType(derivedType), name))
        {
            var add = eventInfo.GetAddMethod(nonPublic: true);
            var remove = eventInfo.GetRemoveMethod(nonPublic: true);
            var representative = add ?? remove;
            if (representative == null || !IsAccessibleOverrideTarget(representative, accessibility))
            {
                continue;
            }

            sawName = true;
            if (!TypeMatches(eventInfo.EventHandlerType, handlerType, ImmutableArray<TypeParameterSymbol>.Empty))
            {
                continue;
            }

            if ((add != null && (!add.IsVirtual || add.IsFinal))
                || (remove != null && (!remove.IsVirtual || remove.IsFinal)))
            {
                return new MatchResult<EventInfo>(null, sawName, IsSealed: true);
            }

            return new MatchResult<EventInfo>(eventInfo, sawName, IsSealed: false);
        }

        return new MatchResult<EventInfo>(null, sawName, IsSealed: false);
    }

    private static Type FindImportedBaseType(StructSymbol type)
    {
        for (var current = type; current != null; current = current.BaseClass)
        {
            if (current.ImportedBaseType?.ClrType != null)
            {
                return current.ImportedBaseType.ClrType;
            }
        }

        return null;
    }

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
        ImmutableArray<TypeParameterSymbol> typeParameters)
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
                || !TypeMatches(clrType, parameters[i].Type, typeParameters))
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
        ImmutableArray<TypeParameterSymbol> typeParameters)
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

        if (TypeMatches(clrReturnType, returnType, typeParameters))
        {
            return true;
        }

        return returnRefKind == RefKind.None && IsCovariantReturn(clrReturnType, returnType);
    }

    private static bool PropertyTypeMatches(Type clrPropertyType, TypeSymbol propertyType, bool hasSetter)
        => TypeMatches(clrPropertyType, propertyType, ImmutableArray<TypeParameterSymbol>.Empty)
            || (!hasSetter && IsCovariantReturn(clrPropertyType, propertyType));

    private static bool TypeMatches(
        Type clrType,
        TypeSymbol type,
        ImmutableArray<TypeParameterSymbol> methodTypeParameters)
    {
        type = type switch
        {
            NullabilityAnnotatedTypeSymbol annotated => annotated.BaseType,
            _ => type,
        };

        if (type is TypeParameterSymbol typeParameter)
        {
            return clrType != null
                && clrType.IsGenericParameter
                && clrType.DeclaringMethod != null
                && typeParameter.Ordinal < methodTypeParameters.Length
                && ReferenceEquals(typeParameter, methodTypeParameters[typeParameter.Ordinal])
                && clrType.GenericParameterPosition == typeParameter.Ordinal;
        }

        var effectiveClrType = NullableLifting.GetEffectiveClrType(type);
        if (effectiveClrType != null && clrType != null)
        {
            return ClrTypeUtilities.AreSame(clrType, effectiveClrType);
        }

        return false;
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
        bool SawName,
        bool IsSealed)
        where T : MemberInfo;
}
