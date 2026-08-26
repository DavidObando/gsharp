// <copyright file="ConstantExpressionEvaluator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics.CodeAnalysis;
using System.Linq.Expressions;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Evaluates bound predefined constant expressions with CLR semantics.</summary>
internal static class ConstantExpressionEvaluator
{
    private static readonly MethodInfo StringConcat = Invariant.Required(
        typeof(string).GetMethod(nameof(string.Concat), new[] { typeof(string), typeof(string) }),
        "string.Concat(string, string) exists");

    private static readonly MethodInfo StringEquals = Invariant.Required(
        typeof(string).GetMethod(nameof(string.Equals), new[] { typeof(string), typeof(string) }),
        "string.Equals(string, string) exists");

    private static readonly MethodInfo ConvertCharToString = Invariant.Required(
        typeof(Convert).GetMethod(nameof(Convert.ToString), new[] { typeof(char) }),
        "Convert.ToString(char) exists");

    /// <summary>Evaluates and target-converts a bound constant expression.</summary>
    /// <param name="expression">The bound expression.</param>
    /// <param name="targetType">The declaration's target type.</param>
    /// <param name="value">The target-typed value on success.</param>
    /// <returns><see langword="true"/> when the complete expression is constant.</returns>
    public static bool TryFold(BoundExpression expression, TypeSymbol targetType, out object? value)
    {
        value = null;
        try
        {
            return TryBuild(expression, out var built)
                && TryConvert(built, targetType, isChecked: false, out var converted)
                && TryNormalizeFinalPayload(converted, targetType, out var payload)
                && TryInvoke(payload, out value);
        }
        catch (Exception ex) when (IsFoldFailure(ex))
        {
            return false;
        }
    }

    /// <summary>Evaluates a bound constant expression without an outer target conversion.</summary>
    /// <param name="expression">The bound expression.</param>
    /// <param name="value">The expression value on success.</param>
    /// <returns><see langword="true"/> when the expression is constant.</returns>
    public static bool TryEvaluate(BoundExpression expression, out object? value)
    {
        value = null;
        try
        {
            return TryBuild(expression, out var built)
                && TryInvoke(built, out value);
        }
        catch (Exception ex) when (IsFoldFailure(ex))
        {
            return false;
        }
    }

    /// <summary>Finds a native-width integer anywhere in the supported constant tree.</summary>
    /// <param name="expression">The bound expression.</param>
    /// <param name="type">The first native-width type found.</param>
    /// <returns><see langword="true"/> when any node has type <c>nint</c> or <c>nuint</c>.</returns>
    public static bool TryFindNativeInteger(BoundExpression expression, out TypeSymbol? type)
    {
        if (expression.Type == TypeSymbol.NInt || expression.Type == TypeSymbol.NUInt)
        {
            type = expression.Type;
            return true;
        }

        switch (expression)
        {
            case BoundConversionExpression conversion:
                return TryFindNativeInteger(conversion.Expression, out type);
            case BoundUnaryExpression unary:
                return TryFindNativeInteger(unary.Operand, out type);
            case BoundBinaryExpression binary:
                return TryFindNativeInteger(binary.Left, out type)
                    || TryFindNativeInteger(binary.Right, out type);
            default:
                type = null;
                return false;
        }
    }

    private static bool TryBuild(
        BoundExpression expression,
        [NotNullWhen(true)] out Expression? built)
    {
        built = null;
        switch (expression)
        {
            case BoundLiteralExpression literal:
                return TryBuildConstant(literal.Value, literal.Type, out built);

            case BoundConversionExpression conversion:
                return TryBuild(conversion.Expression, out var operand)
                    && TryConvert(operand, conversion.Type, conversion.IsChecked, out built);

            case BoundImportedCallExpression call
                when call.Function.Method.DeclaringType?.IsSameAs(typeof(Convert)) == true
                && call.Function.Method.Name == nameof(Convert.ToString)
                && call.Function.Method.GetParameters() is [{ ParameterType: var parameterType }]
                && parameterType.IsSameAs(typeof(char))
                && call.Arguments is [{ } argument]
                && TryBuild(argument, out var charOperand):
                built = Expression.Call(ConvertCharToString, charOperand);
                return true;

            case BoundFieldAccessExpression fieldAccess
                when fieldAccess.Field.IsConst
                && fieldAccess.Field.ConstantValue != null:
                return TryBuildConstant(fieldAccess.Field.ConstantValue, fieldAccess.Field.Type, out built);

            case BoundVariableExpression { Variable: GlobalVariableSymbol { IsConst: true } global }:
                return TryBuildConstant(global.ConstantValue, global.Type, out built);

            case BoundUnaryExpression unary:
                return TryBuildUnary(unary, out built);

            case BoundBinaryExpression binary:
                return TryBuildBinary(binary, out built);

            default:
                return false;
        }
    }

    private static bool TryBuildUnary(
        BoundUnaryExpression unary,
        [NotNullWhen(true)] out Expression? built)
    {
        built = null;
        if (!TryBuild(unary.Operand, out var operand))
        {
            return false;
        }

        if (unary.Op.Kind == BoundUnaryOperatorKind.NullAssertion)
        {
            return TryBuildNullAssertion(operand, unary.Type, out built);
        }

        if (unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation)
        {
            built = Expression.Not(operand);
            return true;
        }

        operand = PromoteSubIntOperand(operand, unary.Op.OperandType);
        var checkedNegation = unary.IsChecked && IsSignedIntegral(unary.Op.OperandType);
        Expression? operation = unary.Op.Kind switch
        {
            BoundUnaryOperatorKind.Identity => operand,
            BoundUnaryOperatorKind.Negation when checkedNegation => Expression.NegateChecked(operand),
            BoundUnaryOperatorKind.Negation => Expression.Negate(operand),
            BoundUnaryOperatorKind.OnesComplement => Expression.Not(operand),
            _ => null,
        };
        return operation != null
            && TryConvert(
                operation,
                unary.Type,
                checkedNegation && unary.Op.Kind == BoundUnaryOperatorKind.Negation,
                out built);
    }

    private static bool TryBuildBinary(
        BoundBinaryExpression binary,
        [NotNullWhen(true)] out Expression? built)
    {
        built = null;
        if (!TryBuild(binary.Left, out var left) || !TryBuild(binary.Right, out var right))
        {
            return false;
        }

        if (binary.Op.Kind == BoundBinaryOperatorKind.NullCoalesce)
        {
            return TryConvert(Expression.Coalesce(left, right), binary.Type, isChecked: false, out built);
        }

        if (IsStringLike(binary.Op.LeftType) && IsStringLike(binary.Op.RightType))
        {
            return TryBuildStringBinary(binary.Op.Kind, left, right, out built);
        }

        if (binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd)
        {
            built = Expression.AndAlso(left, right);
            return true;
        }

        if (binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr)
        {
            built = Expression.OrElse(left, right);
            return true;
        }

        left = PromoteSubIntOperand(left, binary.Op.LeftType);
        right = PromoteSubIntOperand(right, binary.Op.RightType);
        if (IsShift(binary.Op.Kind) && !right.Type.IsSameAs(typeof(int)))
        {
            right = Expression.Convert(right, typeof(int));
        }

        Expression operation;
        var checkedArithmetic = binary.IsChecked && IsIntegral(binary.Op.LeftType);
        switch (binary.Op.Kind)
        {
            case BoundBinaryOperatorKind.Sum:
                operation = checkedArithmetic ? Expression.AddChecked(left, right) : Expression.Add(left, right);
                break;
            case BoundBinaryOperatorKind.Difference:
                operation = checkedArithmetic ? Expression.SubtractChecked(left, right) : Expression.Subtract(left, right);
                break;
            case BoundBinaryOperatorKind.Product:
                operation = checkedArithmetic ? Expression.MultiplyChecked(left, right) : Expression.Multiply(left, right);
                break;
            case BoundBinaryOperatorKind.Quotient:
                operation = Expression.Divide(left, right);
                break;
            case BoundBinaryOperatorKind.Remainder:
                operation = Expression.Modulo(left, right);
                break;
            case BoundBinaryOperatorKind.BitwiseAnd:
                operation = Expression.And(left, right);
                break;
            case BoundBinaryOperatorKind.BitwiseOr:
                operation = Expression.Or(left, right);
                break;
            case BoundBinaryOperatorKind.BitwiseXor:
                operation = Expression.ExclusiveOr(left, right);
                break;
            case BoundBinaryOperatorKind.BitClear:
                operation = Expression.And(left, Expression.Not(right));
                break;
            case BoundBinaryOperatorKind.ShiftLeft:
                operation = Expression.LeftShift(left, right);
                break;
            case BoundBinaryOperatorKind.ShiftRight:
                operation = BuildRightShift(left, right, IsUnsigned(binary.Op.LeftType));
                break;
            case BoundBinaryOperatorKind.UnsignedShiftRight:
                operation = BuildRightShift(left, right, isUnsigned: true);
                break;
            case BoundBinaryOperatorKind.Equals:
                operation = Expression.Equal(left, right);
                break;
            case BoundBinaryOperatorKind.NotEquals:
                operation = Expression.NotEqual(left, right);
                break;
            case BoundBinaryOperatorKind.Less:
                operation = Expression.LessThan(left, right);
                break;
            case BoundBinaryOperatorKind.LessOrEquals:
                operation = Expression.LessThanOrEqual(left, right);
                break;
            case BoundBinaryOperatorKind.Greater:
                operation = Expression.GreaterThan(left, right);
                break;
            case BoundBinaryOperatorKind.GreaterOrEquals:
                operation = Expression.GreaterThanOrEqual(left, right);
                break;
            default:
                return false;
        }

        var checkedResult = checkedArithmetic
            && binary.Op.Kind is BoundBinaryOperatorKind.Sum
                or BoundBinaryOperatorKind.Difference
                or BoundBinaryOperatorKind.Product;
        return TryConvert(operation, binary.Type, checkedResult, out built);
    }

    private static bool TryBuildStringBinary(
        BoundBinaryOperatorKind kind,
        Expression left,
        Expression right,
        [NotNullWhen(true)] out Expression? built)
    {
        built = null;
        if (!TryConvert(left, TypeSymbol.String, isChecked: false, out var convertedLeft)
            || !TryConvert(right, TypeSymbol.String, isChecked: false, out var convertedRight))
        {
            return false;
        }

        left = convertedLeft;
        right = convertedRight;

        switch (kind)
        {
            case BoundBinaryOperatorKind.Sum:
                built = Expression.Call(StringConcat, left, right);
                return true;
            case BoundBinaryOperatorKind.Equals:
                built = Expression.Call(StringEquals, left, right);
                return true;
            case BoundBinaryOperatorKind.NotEquals:
                built = Expression.Not(Expression.Call(StringEquals, left, right));
                return true;
            default:
                return false;
        }
    }

    private static bool TryBuildNullAssertion(
        Expression operand,
        TypeSymbol resultType,
        [NotNullWhen(true)] out Expression? built)
    {
        if (!TryConvert(operand, resultType, isChecked: false, out var converted))
        {
            built = null;
            return false;
        }

        if (converted.Type.IsValueType)
        {
            built = converted;
            return true;
        }

        var isNull = Expression.ReferenceEqual(
            Expression.Convert(converted, typeof(object)),
            Expression.Constant(null));
        built = Expression.Condition(
            isNull,
            Expression.Throw(Expression.New(typeof(NullReferenceException)), converted.Type),
            converted);
        return true;
    }

    private static Expression BuildRightShift(Expression left, Expression right, bool isUnsigned)
    {
        if (!isUnsigned || IsUnsignedRuntimeType(left.Type))
        {
            return Expression.RightShift(left, right);
        }

        var unsignedType = left.Type.IsSameAs(typeof(long))
            ? typeof(ulong)
            : left.Type.IsSameAs(typeof(nint))
                ? typeof(nuint)
                : typeof(uint);
        var shifted = Expression.RightShift(Expression.Convert(left, unsignedType), right);
        return Expression.Convert(shifted, left.Type);
    }

    private static Expression PromoteSubIntOperand(Expression operand, TypeSymbol type)
    {
        var storageType = GetConstantStorageType(type);
        return IsSubInt(storageType) && !operand.Type.IsSameAs(typeof(int))
            ? Expression.Convert(operand, typeof(int))
            : operand;
    }

    private static bool TryBuildConstant(
        object? value,
        TypeSymbol type,
        [NotNullWhen(true)] out Expression? built)
    {
        built = null;
        if (!TryGetRuntimeType(type, out var runtimeType))
        {
            return false;
        }

        if (value == null)
        {
            if (runtimeType.IsValueType && Nullable.GetUnderlyingType(runtimeType) == null)
            {
                return false;
            }

            built = Expression.Constant(null, runtimeType);
            return true;
        }

        if (runtimeType.IsInstanceOfType(value))
        {
            built = Expression.Constant(value, runtimeType);
            return true;
        }

        var source = Expression.Constant(value, value.GetType());
        return TryConvert(source, runtimeType, isChecked: false, out built);
    }

    private static bool TryConvert(
        Expression source,
        TypeSymbol targetType,
        bool isChecked,
        [NotNullWhen(true)] out Expression? converted)
    {
        converted = null;
        if (targetType is NullableTypeSymbol nullable
            && nullable.UnderlyingType.ClrType is { IsValueType: true })
        {
            return false;
        }

        return TryGetRuntimeType(targetType, out var runtimeType)
            && TryConvert(source, runtimeType, isChecked, out converted);
    }

    private static bool TryNormalizeFinalPayload(
        Expression source,
        TypeSymbol targetType,
        [NotNullWhen(true)] out Expression? normalized)
    {
        var storageType = GetConstantStorageType(targetType);
        if (storageType == targetType)
        {
            normalized = source;
            return true;
        }

        return TryConvert(source, storageType, isChecked: false, out normalized);
    }

    private static bool TryConvert(
        Expression source,
        Type targetType,
        bool isChecked,
        [NotNullWhen(true)] out Expression? converted)
    {
        if (source.Type == targetType)
        {
            converted = source;
            return true;
        }

        converted = isChecked
            ? Expression.ConvertChecked(source, targetType)
            : Expression.Convert(source, targetType);
        return true;
    }

    private static bool TryInvoke(Expression expression, out object? value)
    {
        var boxed = expression.Type.IsSameAs(typeof(object))
            ? expression
            : Expression.Convert(expression, typeof(object));
        value = Expression.Lambda<Func<object?>>(boxed).Compile()();
        return true;
    }

    private static bool TryGetRuntimeType(
        TypeSymbol type,
        [NotNullWhen(true)] out Type? runtimeType)
    {
        var storageType = GetConstantStorageType(type);
        if (storageType != type)
        {
            return TryGetRuntimeType(storageType, out runtimeType);
        }

        if (type == TypeSymbol.Null)
        {
            runtimeType = typeof(object);
            return true;
        }

        if (type.ClrType != null)
        {
            runtimeType = type.ClrType;
            return true;
        }

        runtimeType = null;
        return false;
    }

    private static bool IsStringLike(TypeSymbol type)
        => type == TypeSymbol.String
            || (type is NullableTypeSymbol nullable && nullable.UnderlyingType == TypeSymbol.String)
            || type == TypeSymbol.Null;

    private static bool IsShift(BoundBinaryOperatorKind kind)
        => kind is BoundBinaryOperatorKind.ShiftLeft
            or BoundBinaryOperatorKind.ShiftRight
            or BoundBinaryOperatorKind.UnsignedShiftRight;

    private static bool IsSubInt(TypeSymbol type)
    {
        type = GetConstantStorageType(type);
        return type == TypeSymbol.Int8
            || type == TypeSymbol.UInt8
            || type == TypeSymbol.Int16
            || type == TypeSymbol.UInt16
            || type == TypeSymbol.Char;
    }

    private static bool IsIntegral(TypeSymbol type)
    {
        type = GetConstantStorageType(type);
        return type == TypeSymbol.Int8
            || type == TypeSymbol.UInt8
            || type == TypeSymbol.Int16
            || type == TypeSymbol.UInt16
            || type == TypeSymbol.Int32
            || type == TypeSymbol.UInt32
            || type == TypeSymbol.Int64
            || type == TypeSymbol.UInt64
            || type == TypeSymbol.NInt
            || type == TypeSymbol.NUInt
            || type == TypeSymbol.Char;
    }

    private static bool IsSignedIntegral(TypeSymbol type)
    {
        type = GetConstantStorageType(type);
        return type == TypeSymbol.Int8
            || type == TypeSymbol.Int16
            || type == TypeSymbol.Int32
            || type == TypeSymbol.Int64
            || type == TypeSymbol.NInt;
    }

    private static bool IsUnsigned(TypeSymbol type)
    {
        type = GetConstantStorageType(type);
        return type == TypeSymbol.UInt8
            || type == TypeSymbol.UInt16
            || type == TypeSymbol.UInt32
            || type == TypeSymbol.UInt64
            || type == TypeSymbol.NUInt
            || type == TypeSymbol.Char;
    }

    private static TypeSymbol GetConstantStorageType(TypeSymbol type)
        => EnumOperatorTable.GetUnderlyingType(type) ?? type;

    private static bool IsUnsignedRuntimeType(Type type)
        => type.IsSameAs(typeof(byte))
            || type.IsSameAs(typeof(ushort))
            || type.IsSameAs(typeof(uint))
            || type.IsSameAs(typeof(ulong))
            || type.IsSameAs(typeof(nuint))
            || type.IsSameAs(typeof(char));

    private static bool IsFoldFailure(Exception exception)
        => exception is ArithmeticException
            or InvalidOperationException
            or InvalidCastException
            or ArgumentException
            or NotSupportedException
            or NullReferenceException;
}
