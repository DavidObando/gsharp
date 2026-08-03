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
        object result;
        if (TryInvokeSpanConversion(target, args, out result))
        {
            return result;
        }

        ThrowIfByRefLikeSignature(target, node);
        return target is ConstructorInfo constructor
            ? constructor.Invoke(args)
            : target.Invoke(receiver, args);
    }

    private object GetReflective(MemberInfo member, object receiver, object[] index, BoundNode node)
    {
        var span = receiver as InterpretedSpanValue;
        if (span != null && member is PropertyInfo spanProperty)
        {
            if (spanProperty.Name == "Length")
            {
                return span.Length;
            }

            if (spanProperty.Name == "Item" && index.Length == 1)
            {
                return span[(int)index[0]];
            }
        }

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
        var span = receiver as InterpretedSpanValue;
        if (span != null && member is PropertyInfo spanProperty && spanProperty.Name == "Item" && index.Length == 1)
        {
            span[(int)index[0]] = value;
            return;
        }

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

    private static bool TryInvokeSpanConversion(MethodBase target, object[] args, out object result)
    {
        if (target is MethodInfo conversion
            && conversion.Name == "op_Implicit"
            && IsSpanType(conversion.ReturnType)
            && args.Length == 1)
        {
            var readOnly = IsReadOnlySpanType(conversion.ReturnType);
            if (args[0] is Array array)
            {
                result = new InterpretedSpanValue(array, readOnly);
                return true;
            }

            if (args[0] is InterpretedSpanValue source && (readOnly || !source.IsReadOnly))
            {
                result = source.As(readOnly);
                return true;
            }
        }

        result = null;
        return false;
    }

    private static bool IsSpanType(Type type)
    {
        if (!type.IsGenericType)
        {
            return false;
        }

        var definition = type.GetGenericTypeDefinition();
        return definition.IsSameAs(typeof(Span<>))
            || definition.IsSameAs(typeof(ReadOnlySpan<>));
    }

    private static bool IsReadOnlySpanType(Type type)
        => type.IsGenericType && type.GetGenericTypeDefinition().IsSameAs(typeof(ReadOnlySpan<>));

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

    private sealed class InterpretedSpanValue
    {
        private readonly Array array;
        private readonly int start;

        public InterpretedSpanValue(Array array, bool readOnly)
            : this(array, 0, array.Length, readOnly)
        {
        }

        private InterpretedSpanValue(Array array, int start, int length, bool readOnly)
        {
            this.array = array;
            this.start = start;
            Length = length;
            IsReadOnly = readOnly;
        }

        public int Length { get; }

        public bool IsReadOnly { get; }

        public object this[int index]
        {
            get => this.array.GetValue(CheckedIndex(index));
            set
            {
                if (IsReadOnly)
                {
                    throw new InvalidOperationException("Cannot write through a ReadOnlySpan.");
                }

                this.array.SetValue(value, CheckedIndex(index));
            }
        }

        public static InterpretedSpanValue Empty(Type type)
            => new(
                Array.CreateInstance(type.GetGenericArguments()[0], 0),
                IsReadOnlySpanType(type));

        public InterpretedSpanValue As(bool readOnly)
            => new(this.array, this.start, Length, readOnly);

        public InterpretedSpanValue Slice(int start)
            => Slice(start, Length - start);

        public InterpretedSpanValue Slice(int start, int length)
        {
            if ((uint)start > (uint)Length || (uint)length > (uint)(Length - start))
            {
                throw new ArgumentOutOfRangeException();
            }

            return new InterpretedSpanValue(this.array, this.start + start, length, IsReadOnly);
        }

        public override string ToString()
            => this.array is char[] chars
                ? new string(chars, this.start, Length)
                : $"System.{(IsReadOnly ? "ReadOnlySpan" : "Span")}<{this.array.GetType().GetElementType().Name}>[{Length}]";

        private int CheckedIndex(int index)
        {
            if ((uint)index >= (uint)Length)
            {
                throw new IndexOutOfRangeException();
            }

            return this.start + index;
        }
    }
}
