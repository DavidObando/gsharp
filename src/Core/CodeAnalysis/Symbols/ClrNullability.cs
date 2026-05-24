// <copyright file="ClrNullability.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Phase 3.C.5 / ADR-0001: helpers for reading C# nullable-reference-types
/// metadata (<c>[NullableAttribute]</c> / <c>[NullableContextAttribute]</c>)
/// from members loaded through a <see cref="MetadataLoadContext"/>.
///
/// We only inspect the top-level nullability byte (index 0 of the
/// <c>NullableAttribute</c> byte-array, or the scalar argument when present).
/// Generic-type-argument nullability is not yet surfaced.
/// </summary>
public static class ClrNullability
{
    private const string NullableAttributeFullName = "System.Runtime.CompilerServices.NullableAttribute";
    private const string NullableContextAttributeFullName = "System.Runtime.CompilerServices.NullableContextAttribute";
    private const string NotNullWhenAttributeFullName = "System.Diagnostics.CodeAnalysis.NotNullWhenAttribute";
    private const string MaybeNullWhenAttributeFullName = "System.Diagnostics.CodeAnalysis.MaybeNullWhenAttribute";

    /// <summary>
    /// Returns the GSharp <see cref="TypeSymbol"/> for a method's return
    /// type, wrapping it in <see cref="NullableTypeSymbol"/> when the
    /// underlying CLR type is a reference type annotated as nullable.
    /// Value-type nullability (<c>Nullable&lt;T&gt;</c>) is handled inside
    /// <see cref="TypeSymbol.FromClrType(Type)"/>.
    /// </summary>
    /// <param name="method">The method to inspect.</param>
    /// <returns>The mapped type symbol.</returns>
    public static TypeSymbol GetReturnTypeSymbol(MethodInfo method)
    {
        var baseSymbol = TypeSymbol.FromClrType(method.ReturnType);
        return ApplyReferenceNullability(baseSymbol, method.ReturnType, method.ReturnParameter, method);
    }

    /// <summary>
    /// Returns the GSharp <see cref="TypeSymbol"/> for a parameter, with
    /// reference-type nullability applied.
    /// </summary>
    /// <param name="parameter">The parameter to inspect.</param>
    /// <returns>The mapped type symbol.</returns>
    public static TypeSymbol GetParameterTypeSymbol(ParameterInfo parameter)
    {
        var baseSymbol = TypeSymbol.FromClrType(parameter.ParameterType);
        return ApplyReferenceNullability(baseSymbol, parameter.ParameterType, parameter, parameter.Member);
    }

    internal static bool TryGetNotNullWhen(ParameterInfo parameter, out bool returnValue)
    {
        return TryGetBoolAttributeValue(parameter, NotNullWhenAttributeFullName, out returnValue);
    }

    internal static bool TryGetMaybeNullWhen(ParameterInfo parameter, out bool returnValue)
    {
        return TryGetBoolAttributeValue(parameter, MaybeNullWhenAttributeFullName, out returnValue);
    }

    private static TypeSymbol ApplyReferenceNullability(TypeSymbol baseSymbol, Type clrType, ICustomAttributeProvider declaration, MemberInfo enclosingMember)
    {
        if (baseSymbol is NullableTypeSymbol)
        {
            return baseSymbol;
        }

        if (clrType == null || clrType.IsValueType)
        {
            return baseSymbol;
        }

        if (!TryGetTopLevelNullableFlag(declaration, enclosingMember, out var flag))
        {
            return baseSymbol;
        }

        // 2 == annotated (i.e. T?). 1 == not-annotated. 0 == oblivious.
        return flag == 2 ? (TypeSymbol)NullableTypeSymbol.Get(baseSymbol) : baseSymbol;
    }

    private static bool TryGetTopLevelNullableFlag(ICustomAttributeProvider declaration, MemberInfo enclosingMember, out byte flag)
    {
        var attrs = SafeGetCustomAttributesData(declaration);
        if (attrs != null)
        {
            foreach (var ad in attrs)
            {
                if (ad.AttributeType?.FullName != NullableAttributeFullName)
                {
                    continue;
                }

                if (ad.ConstructorArguments.Count != 1)
                {
                    continue;
                }

                var arg = ad.ConstructorArguments[0];
                if (arg.Value is byte b)
                {
                    flag = b;
                    return true;
                }

                if (arg.Value is System.Collections.ObjectModel.ReadOnlyCollection<CustomAttributeTypedArgument> arr && arr.Count > 0 && arr[0].Value is byte first)
                {
                    flag = first;
                    return true;
                }
            }
        }

        // Fall back to the surrounding NullableContextAttribute on the
        // method, the declaring type, and then any enclosing types.
        for (var member = enclosingMember; member != null; member = member.DeclaringType)
        {
            var contextAttrs = SafeGetCustomAttributesData(member);
            if (contextAttrs == null)
            {
                continue;
            }

            foreach (var ad in contextAttrs)
            {
                if (ad.AttributeType?.FullName == NullableContextAttributeFullName
                    && ad.ConstructorArguments.Count == 1
                    && ad.ConstructorArguments[0].Value is byte ctxByte)
                {
                    flag = ctxByte;
                    return true;
                }
            }
        }

        flag = 0;
        return false;
    }

    private static bool TryGetBoolAttributeValue(ParameterInfo parameter, string attributeFullName, out bool value)
    {
        var attrs = SafeGetCustomAttributesData(parameter);
        if (attrs != null)
        {
            foreach (var ad in attrs)
            {
                if (ad.AttributeType?.FullName == attributeFullName
                    && ad.ConstructorArguments.Count == 1
                    && ad.ConstructorArguments[0].Value is bool boolValue)
                {
                    value = boolValue;
                    return true;
                }
            }
        }

        value = false;
        return false;
    }

    private static System.Collections.Generic.IList<CustomAttributeData> SafeGetCustomAttributesData(ICustomAttributeProvider provider)
    {
        try
        {
            return provider switch
            {
                MemberInfo mi => mi.GetCustomAttributesData()?.ToList(),
                ParameterInfo pi => pi.GetCustomAttributesData()?.ToList(),
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }
}
