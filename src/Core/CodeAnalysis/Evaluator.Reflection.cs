// <copyright file="Evaluator.Reflection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Issue #2987 reflection boundary shared by evaluator call and member-access paths.
/// </summary>
#pragma warning disable CA1001 // Types that own disposable fields should be disposable
public sealed partial class Evaluator
#pragma warning restore CA1001
{
    private object InvokeReflective(MethodBase target, object receiver, object[] args, BoundNode node)
    {
        ThrowIfByRefLikeSignature(target, node);
        return target is ConstructorInfo constructor
            ? constructor.Invoke(args)
            : target.Invoke(receiver, args);
    }

    private object GetReflective(MemberInfo member, object receiver, object[] index, BoundNode node)
    {
        ThrowIfByRefLikeSignature(member, node);
        return member switch
        {
            PropertyInfo property => property.GetValue(receiver, index),
            FieldInfo field => field.GetValue(receiver),
            _ => throw new EvaluatorException($"Unsupported CLR member kind '{member.MemberType}'.", node),
        };
    }

    private void SetReflective(MemberInfo member, object receiver, object value, object[] index, BoundNode node)
    {
        ThrowIfByRefLikeSignature(member, node);
        switch (member)
        {
            case PropertyInfo property:
                property.SetValue(receiver, value, index);
                break;
            case FieldInfo field:
                field.SetValue(receiver, value);
                break;
            default:
                throw new EvaluatorException($"Unsupported CLR member kind '{member.MemberType}'.", node);
        }
    }

    private static void ThrowIfByRefLikeSignature(MemberInfo member, BoundNode node)
    {
        var type = FindByRefLikeSignatureType(member);
        if (type != null)
        {
            throw EvaluatorException.CreateDiagnostic(
                DiagnosticDescriptors.InterpreterByRefLikeValuesNotSupported,
                node,
                TypeSymbol.FromClrType(type));
        }
    }

    private static Type FindByRefLikeSignatureType(MemberInfo member)
    {
        var type = FindByRefLikeType(member.DeclaringType);
        if (type != null)
        {
            return type;
        }

        switch (member)
        {
            case MethodInfo method:
                type = FindByRefLikeType(method.ReturnType);
                break;
            case PropertyInfo property:
                type = FindByRefLikeType(property.PropertyType);
                break;
            case FieldInfo field:
                return FindByRefLikeType(field.FieldType);
        }

        if (type != null)
        {
            return type;
        }

        var parameters = member switch
        {
            MethodBase method => method.GetParameters(),
            PropertyInfo property => property.GetIndexParameters(),
            _ => Array.Empty<ParameterInfo>(),
        };
        foreach (var parameter in parameters)
        {
            type = FindByRefLikeType(parameter.ParameterType);
            if (type != null)
            {
                return type;
            }
        }

        return null;
    }

    private static Type FindByRefLikeType(Type type)
    {
        if (type == null)
        {
            return null;
        }

        if (ClrTypeUtilities.IsByRefLike(type))
        {
            return type;
        }

        if (type.HasElementType)
        {
            return FindByRefLikeType(type.GetElementType());
        }

        if (type.IsGenericType)
        {
            foreach (var argument in type.GetGenericArguments())
            {
                var byRefLike = FindByRefLikeType(argument);
                if (byRefLike != null)
                {
                    return byRefLike;
                }
            }
        }

        return null;
    }
}
