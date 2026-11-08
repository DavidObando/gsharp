// <copyright file="ConstantExpressionEvaluator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Diagnostics.CodeAnalysis
import System.Globalization
import System.Linq.Expressions
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis

/// Evaluates bound predefined constant expressions with CLR semantics.
internal shared class ConstantExpressionEvaluator {
    private let StringConcat MethodInfo = Invariant.Required(
        typeof(string).GetMethod("Concat", []Type{typeof(string), typeof(string)}),
        "string.Concat(string, string) exists",
        expression: "typeof(string).GetMethod(nameof(string.Concat), new[] { typeof(string), typeof(string) })"
    )
    private let StringEquals MethodInfo = Invariant.Required(
        typeof(string).GetMethod("Equals", []Type{typeof(string), typeof(string)}),
        "string.Equals(string, string) exists",
        expression: "typeof(string).GetMethod(nameof(string.Equals), new[] { typeof(string), typeof(string) })"
    )
    private let ConvertCharToString MethodInfo = Invariant.Required(
        typeof(Convert).GetMethod("ToString", []Type{typeof(char)}),
        "Convert.ToString(char) exists",
        expression: "typeof(Convert).GetMethod(nameof(Convert.ToString), new[] { typeof(char) })"
    )

    /// Evaluates and target-converts a bound constant expression.
    /// @param expression The bound expression.
    /// @param targetType The declaration's target type.
    /// @param value The target-typed value on success.
    /// @returns `true` when the complete expression is constant.
    func TryFold(expression BoundExpression, targetType TypeSymbol, out value object?) bool {
        value = nil
        try {
            return TryBuild(expression, out var built) &&
                TryConvert(built!!, targetType, isChecked: false, out var converted) &&
                TryNormalizeFinalPayload(converted!!, targetType, out var payload) &&
                TryInvoke(payload!!, out value) &&
                (
                value == nil || targetType.StripToBareShape() == TypeSymbol.String || !Conversion.IsReferenceLikeTarget(
                    targetType.StripToBareShape()
                )
            )
        } catch (ex Exception) when IsFoldFailure(ex) {
            return false
        }
    }

    /// Evaluates a bound constant expression without an outer target conversion.
    /// @param expression The bound expression.
    /// @param value The expression value on success.
    /// @returns `true` when the expression is constant.
    func TryEvaluate(expression BoundExpression, out value object?) bool {
        value = nil
        try {
            return TryBuild(expression, out var built) && TryInvoke(built!!, out value)
        } catch (ex Exception) when IsFoldFailure(ex) {
            return false
        }
    }

    /// A null reference constant cannot establish a non-null declaration type.
    internal func GetDeclarationType(expression BoundExpression, type TypeSymbol) TypeSymbol {
        let contextual = if expression is BoundDefaultExpression{Type: var defaultType} &&
            defaultType == TypeSymbol.Error {
            cast[BoundExpression](BoundDefaultExpression(expression.Syntax, type))
        } else {
            expression
        }
        return if type.ReferenceNullability == ReferenceNullabilityKind.NotNull &&
            contextual is not BoundLiteralExpression{Value: not nil} &&
            TryFold(contextual, type, out var value) &&
            value == nil {
            type.ForNullConstant()
        } else {
            type
        }
    }

    /// Returns whether the symbol has a known null constant payload.
    internal func IsNullConstantSymbol(symbol Symbol?) bool -> switch symbol {
        case FieldSymbol{IsConst: true, HasConstantValue: true, ConstantValue: nil}: true
        case LocalVariableSymbol{IsConst: true, ConstantValue: nil}: true
        case GlobalVariableSymbol{IsConst: true, ConstantValue: nil}: true
        case ImplicitStaticFieldVariableSymbol field: IsNullConstantSymbol(field.Field)
        default: false
    }

    /// Reads CLR constant metadata without running a field initializer.
    /// @param field The imported field.
    /// @param value The constant value on success.
    /// @returns `true` for literal fields and decimal constant attributes.
    internal func TryGetClrFieldConstantValue(field FieldInfo, out value object?) bool {
        value = nil
        if field.IsLiteral {
            value = field.GetRawConstantValue()
            return true
        }
        if !field.IsStatic || !field.IsInitOnly || !field.FieldType.IsSameAs(typeof(decimal)) {
            return false
        }
        for attribute in field.GetCustomAttributesData() {
            if attribute
                .AttributeType
                .FullName != "System.Runtime.CompilerServices.DecimalConstantAttribute" ||
                attribute
                .ConstructorArguments
                .Count != 5 {
                continue
            }
            let args = attribute.ConstructorArguments
            let scale = Convert.ToByte(args[0].Value, CultureInfo.InvariantCulture)
            if scale > 28 {
                return false
            }
            value = Decimal(
                unchecked(int32(Convert.ToInt64(args[4].Value, CultureInfo.InvariantCulture))),
                unchecked(int32(Convert.ToInt64(args[3].Value, CultureInfo.InvariantCulture))),
                unchecked(int32(Convert.ToInt64(args[2].Value, CultureInfo.InvariantCulture))),
                Convert.ToByte(args[1].Value, CultureInfo.InvariantCulture) != 0,
                scale
            )
            return true
        }
        return false
    }

    /// Finds a native-width integer anywhere in the supported constant tree.
    /// @param expression The bound expression.
    /// @param type The first native-width type found.
    /// @returns `true` when any node has type `nint` or `nuint`.
    func TryFindNativeInteger(expression BoundExpression, out type TypeSymbol?) bool {
        if expression.Type == TypeSymbol.NInt || expression.Type == TypeSymbol.NUInt {
            type = expression.Type
            return true
        }
        switch expression {
            case conversion is BoundConversionExpression {
                return TryFindNativeInteger(conversion.Expression, out type)
            }
            case unary is BoundUnaryExpression {
                return TryFindNativeInteger(unary.Operand, out type)
            }
            case binary is BoundBinaryExpression {
                return TryFindNativeInteger(binary.Left, out type) || TryFindNativeInteger(binary.Right, out type)
            }
            default {
                type = nil
                return false
            }
        }
    }

    private func TryBuild(expression BoundExpression, @NotNullWhen(true) out built Expression?) bool {
        built = nil
        switch expression {
            case literal is BoundLiteralExpression {
                return TryBuildConstant(literal.Value, literal.Type, out built)
            }
            case defaultValue is BoundDefaultExpression when Conversion.IsReferenceLikeTarget(
                defaultValue.Type.StripToBareShape()
            ) ||
                UsesObjectNullCarrier(defaultValue.Type) {
                return TryBuildConstant(nil, defaultValue.Type, out built)
            }
            case BoundClrPropertyAccessExpression{Receiver: nil, Member: FieldInfo field} fieldAccess when
            TryGetClrFieldConstantValue(field, out var constantValue) {
                return TryBuildConstant(constantValue, fieldAccess.Type, out built)
            }
            case conversion is BoundConversionExpression {
                return TryBuild(conversion.Expression, out var operand) &&
                    TryConvert(operand!!, conversion.Type, conversion.IsChecked, out built)
            }
            case call is BoundImportedCallExpression when call
                .Function
                .Method
                .DeclaringType
                ?.IsSameAs(typeof(Convert)) == true &&
                call
                .Function
                .Method
                .Name == "ToString" &&
                call
                .Function
                .Method
                .GetParameters() is [{ParameterType: var parameterType}] &&
                parameterType.IsSameAs(typeof(char)) &&
                call.Arguments is [{} argument] &&
                TryBuild(argument, out var charOperand) {
                built = Expression.Call(ConvertCharToString, charOperand!!)
                return true
            }
            case fieldAccess is BoundFieldAccessExpression when fieldAccess
                .Field
                .IsConst &&
                fieldAccess
                .Field
                .HasConstantValue {
                return TryBuildConstant(fieldAccess.Field.ConstantValue, fieldAccess.Field.Type, out built)
            }
            case BoundVariableExpression{Variable: GlobalVariableSymbol{IsConst: true} global} {
                return TryBuildConstant(global.ConstantValue, global.Type, out built)
            }
            case BoundVariableExpression{Variable: LocalVariableSymbol{IsConst: true} localConst} {
                return TryBuildConstant(localConst.ConstantValue, localConst.Type, out built)
            }
            case unary is BoundUnaryExpression {
                return TryBuildUnary(unary, out built)
            }
            case binary is BoundBinaryExpression {
                return TryBuildBinary(binary, out built)
            }
            default {
                return false
            }
        }
    }

    private func TryBuildUnary(unary BoundUnaryExpression, @NotNullWhen(true) out built Expression?) bool {
        built = nil
        if !TryBuild(unary.Operand, out var operand) {
            return false
        }
        if unary.Op.Kind == BoundUnaryOperatorKind.NullAssertion {
            return TryBuildNullAssertion(operand, unary.Type, out built)
        }
        if unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
            built = Expression.Not(operand)
            return true
        }
        operand = PromoteSubIntOperand(operand, unary.Op.OperandType)
        let checkedNegation = unary.IsChecked && IsSignedIntegral(unary.Op.OperandType)
        let operation Expression? = switch unary.Op.Kind {
            case BoundUnaryOperatorKind.Identity: operand
            case BoundUnaryOperatorKind.Negation when checkedNegation: cast[Expression](
                Expression.NegateChecked(operand)
            )
            case BoundUnaryOperatorKind.Negation: cast[Expression](Expression.Negate(operand))
            case BoundUnaryOperatorKind.OnesComplement: cast[Expression](Expression.Not(operand))
            default: default(Expression?)
        }
        return operation != nil &&
            TryConvert(
            operation,
            unary.Type,
            checkedNegation && unary.Op.Kind == BoundUnaryOperatorKind.Negation,
            out built
        )
    }

    private func TryBuildBinary(binary BoundBinaryExpression, @NotNullWhen(true) out built Expression?) bool {
        built = nil
        if !TryBuild(binary.Left, out var left) || !TryBuild(binary.Right, out var right) {
            return false
        }
        if binary.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
            return TryConvert(Expression.Coalesce(left!!, right!!), binary.Type, isChecked: false, out built)
        }
        if IsStringLike(binary.Op.LeftType) && IsStringLike(binary.Op.RightType) {
            return TryBuildStringBinary(binary.Op.Kind, left!!, right!!, out built)
        }
        if binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
            built = Expression.AndAlso(left!!, right!!)
            return true
        }
        if binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
            built = Expression.OrElse(left!!, right!!)
            return true
        }
        left = PromoteSubIntOperand(left!!, binary.Op.LeftType)
        right = PromoteSubIntOperand(right!!, binary.Op.RightType)
        if IsShift(binary.Op.Kind) && !right.Type.IsSameAs(typeof(int32)) {
            right = Expression.Convert(right, typeof(int32))
        }
        var operation Expression
        let checkedArithmetic = binary.IsChecked && IsIntegral(binary.Op.LeftType)
        switch binary.Op.Kind {
            case BoundBinaryOperatorKind.Sum {
                operation = if checkedArithmetic {
                    Expression.AddChecked(left, right!!)
                } else {
                    Expression.Add(left, right!!)
                }
            }
            case BoundBinaryOperatorKind.Difference {
                operation = if checkedArithmetic {
                    Expression.SubtractChecked(left, right!!)
                } else {
                    Expression.Subtract(left, right!!)
                }
            }
            case BoundBinaryOperatorKind.Product {
                operation = if checkedArithmetic {
                    Expression.MultiplyChecked(left, right!!)
                } else {
                    Expression.Multiply(left, right!!)
                }
            }
            case BoundBinaryOperatorKind.Quotient {
                operation = Expression.Divide(left, right!!)
            }
            case BoundBinaryOperatorKind.Remainder {
                operation = Expression.Modulo(left, right!!)
            }
            case BoundBinaryOperatorKind.BitwiseAnd {
                operation = Expression.And(left, right!!)
            }
            case BoundBinaryOperatorKind.BitwiseOr {
                operation = Expression.Or(left, right!!)
            }
            case BoundBinaryOperatorKind.BitwiseXor {
                operation = Expression.ExclusiveOr(left, right!!)
            }
            case BoundBinaryOperatorKind.BitClear {
                operation = Expression.And(left, Expression.Not(right!!))
            }
            case BoundBinaryOperatorKind.ShiftLeft {
                operation = Expression.LeftShift(left, right!!)
            }
            case BoundBinaryOperatorKind.ShiftRight {
                operation = BuildRightShift(left, right!!, IsUnsigned(binary.Op.LeftType))
            }
            case BoundBinaryOperatorKind.UnsignedShiftRight {
                operation = BuildRightShift(left, right!!, isUnsigned: true)
            }
            case BoundBinaryOperatorKind.Equals {
                operation = Expression.Equal(left, right!!)
            }
            case BoundBinaryOperatorKind.NotEquals {
                operation = Expression.NotEqual(left, right!!)
            }
            case BoundBinaryOperatorKind.Less {
                operation = Expression.LessThan(left, right!!)
            }
            case BoundBinaryOperatorKind.LessOrEquals {
                operation = Expression.LessThanOrEqual(left, right!!)
            }
            case BoundBinaryOperatorKind.Greater {
                operation = Expression.GreaterThan(left, right!!)
            }
            case BoundBinaryOperatorKind.GreaterOrEquals {
                operation = Expression.GreaterThanOrEqual(left, right!!)
            }
            default {
                return false
            }
        }
        let checkedResult = checkedArithmetic &&
            (
            binary
                .Op
                .Kind is BoundBinaryOperatorKind.Sum or
                BoundBinaryOperatorKind.Difference or
                BoundBinaryOperatorKind.Product
        )
        return TryConvert(operation, binary.Type, checkedResult, out built)
    }

    private func TryBuildStringBinary(
        kind BoundBinaryOperatorKind,
        left Expression,
        right Expression,
        @NotNullWhen(true) out built Expression?
    ) bool {
        var left = left
        var right = right
        built = nil
        if !TryConvert(left, TypeSymbol.String, isChecked: false, out var convertedLeft) ||
            !TryConvert(right, TypeSymbol.String, isChecked: false, out var convertedRight) {
            return false
        }
        left = convertedLeft!!
        right = convertedRight!!
        switch kind {
            case BoundBinaryOperatorKind.Sum {
                built = Expression.Call(StringConcat, left, right)
                return true
            }
            case BoundBinaryOperatorKind.Equals {
                built = Expression.Call(StringEquals, left, right)
                return true
            }
            case BoundBinaryOperatorKind.NotEquals {
                built = Expression.Not(Expression.Call(StringEquals, left, right))
                return true
            }
            default {
                return false
            }
        }
    }

    private func TryBuildNullAssertion(
        operand Expression,
        resultType TypeSymbol,
        @NotNullWhen(true) out built Expression?
    ) bool {
        if !TryConvert(operand, resultType, isChecked: false, out var converted) {
            built = nil
            return false
        }
        if converted.Type.IsValueType {
            built = converted
            return true
        }
        let isNull = Expression.ReferenceEqual(Expression.Convert(converted, typeof(object)), Expression.Constant(nil))
        built = Expression.Condition(
            isNull,
            Expression.Throw(Expression.New(typeof(NullReferenceException)), converted.Type),
            converted
        )
        return true
    }

    private func BuildRightShift(left Expression, right Expression, isUnsigned bool) Expression {
        if !isUnsigned || IsUnsignedRuntimeType(left.Type) {
            return Expression.RightShift(left, right)
        }
        let unsignedType = if left.Type.IsSameAs(typeof(int64)) {
            typeof(uint64)
        } else {
            (
                if left.Type.IsSameAs(typeof(nint)) {
                    typeof(nuint)
                } else {
                    typeof(uint32)
                }
            )
        }
        let shifted = Expression.RightShift(Expression.Convert(left, unsignedType), right)
        return Expression.Convert(shifted, left.Type)
    }

    private func PromoteSubIntOperand(operand Expression, type TypeSymbol) Expression {
        let storageType = GetConstantStorageType(type)
        return if IsSubInt(storageType) && !operand.Type.IsSameAs(typeof(int32)) {
            cast[Expression](Expression.Convert(operand, typeof(int32)))
        } else {
            operand
        }
    }

    private func TryBuildConstant(value object?, type TypeSymbol, @NotNullWhen(true) out built Expression?) bool {
        built = nil
        if value == nil && UsesObjectNullCarrier(type) {
            built = Expression.Constant(nil, typeof(object))
            return true
        }
        if !TryGetRuntimeType(type, out var runtimeType) {
            return false
        }
        if value == nil {
            if runtimeType.IsValueType && !NullableLifting.IsValueTypeNullableClr(runtimeType) {
                return false
            }
            built = Expression.Constant(nil, runtimeType)
            return true
        }
        if runtimeType.IsInstanceOfType(value) {
            built = Expression.Constant(value, runtimeType)
            return true
        }
        let source = Expression.Constant(value, value.GetType())
        return TryConvert(source, runtimeType, isChecked: false, out built)
    }

    private func TryConvert(
        source Expression,
        targetType TypeSymbol,
        isChecked bool,
        @NotNullWhen(true) out converted Expression?
    ) bool {
        converted = nil
        let bareTarget = targetType.StripToBareShape()
        if bareTarget is not TypeParameterSymbol && bareTarget != TypeSymbol.String && Conversion.IsReferenceLikeTarget(
            bareTarget
        ) &&
            TryInvoke(source, out var referenceValue) &&
            referenceValue == nil {
            converted = Expression.Constant(nil, typeof(object))
            return true
        }
        if targetType is NullableTypeSymbol nullable && nullable.UnderlyingType.ClrType is {IsValueType: true} {
            return false
        }
        return TryGetRuntimeType(targetType, out var runtimeType) &&
            TryConvert(source, runtimeType!!, isChecked, out converted)
    }

    private func TryNormalizeFinalPayload(
        source Expression,
        targetType TypeSymbol,
        @NotNullWhen(true) out normalized Expression?
    ) bool {
        let storageType = GetConstantStorageType(targetType)
        if storageType == targetType {
            normalized = source
            return true
        }
        return TryConvert(source, storageType, isChecked: false, out normalized)
    }

    private func UsesObjectNullCarrier(type TypeSymbol) bool {
        let bare = type.StripToBareShape()
        return bare is not TypeParameterSymbol &&
            bare != TypeSymbol.String &&
            (
            Conversion.IsReferenceLikeTarget(bare) || NullableLifting.IsAnyValueTypeNullable(
                type as NullableTypeSymbol
            ) ||
                NullableLifting.IsValueTypeNullableClr(type.ClrType)
        )
    }

    private func TryConvert(
        source Expression,
        targetType Type,
        isChecked bool,
        @NotNullWhen(true) out converted Expression?
    ) bool {
        if source.Type == targetType {
            converted = source
            return true
        }
        if IsFloatingRuntimeType(source.Type) && IsIntegralConstantTarget(targetType) {
            // #5767: do not let the JIT of the host runtime convert the value. The result of
            // Expression.Convert for an out-of-range value changed in .NET 11.
            converted = nil
            if !TryInvoke(source, out var operand) || operand == nil {
                return false
            }
            if !TryConvertFloatingConstant(
                Convert.ToDouble(operand, CultureInfo.InvariantCulture),
                targetType,
                out var value,
                out var inRange
            ) ||
                (isChecked && !inRange) {
                return false
            }
            converted = Expression.Constant(value, targetType)
            return true
        }
        converted = if isChecked {
            Expression.ConvertChecked(source, targetType)
        } else {
            Expression.Convert(source, targetType)
        }
        return true
    }

    /// Converts a floating-point constant to an integer type with the G# constant rule (#5767, ADR-0219).
    /// The result does not depend on the runtime that hosts gsc. A value in range truncates toward zero.
    /// A value out of range saturates at the bounds of the type, and NaN converts to 0. The .NET 11 runtime
    /// uses the same rule for unchecked conversions.
    /// @param value The constant value.
    /// @param targetType The integer or `char` runtime type.
    /// @param converted The converted value, boxed as [`targetType`](paramref).
    /// @param inRange `false` when [`value`](paramref) is NaN or out of the range of the type.
    /// @returns `false` when [`targetType`](paramref) is not a fixed-width integer type or `char`.
    func TryConvertFloatingConstant(
        value float64,
        targetType Type,
        @NotNullWhen(true) out converted object?,
        out inRange bool
    ) bool {
        converted = nil
        inRange = false
        if !TryGetIntegralBounds(targetType, out var typeCode, out var lower, out var upperExclusive) {
            return false
        }
        let truncated = Math.Truncate(value)
        inRange = !float64.IsNaN(value) && truncated >= lower && truncated < upperExclusive
        converted = if inRange && lower < 0.0 {
            Convert.ChangeType(int64(truncated), typeCode, CultureInfo.InvariantCulture)
        } else if inRange {
            Convert.ChangeType(uint64(truncated), typeCode, CultureInfo.InvariantCulture)
        } else if float64.IsNaN(value) {
            Convert.ChangeType(0, typeCode, CultureInfo.InvariantCulture)
        } else if value < 0.0 {
            GetIntegralMinimum(typeCode)
        } else {
            GetIntegralMaximum(typeCode)
        }
        return true
    }

    /// Tests the types of a floating-point constant conversion (#5767, ADR-0219): a `float32` or `float64`
    /// operand and a fixed-width integer, `char`, or enum target, or a `Nullable<T>` of one of these. It does
    /// not evaluate the operand, so a conversion to another type does not compile an expression tree.
    /// @param conversion The bound conversion.
    /// @returns `true` when the rule of (cref:TryConvertFloatingConstant) applies if the operand is constant.
    func IsFloatingConstantConversionCandidate(conversion BoundConversionExpression) bool {
        let operandType = conversion.Expression.Type
        if operandType != TypeSymbol.Float64 && operandType != TypeSymbol.Float32 {
            return false
        }
        let targetType = GetFloatingConstantConversionStorageType(conversion.Type).ClrType
        return targetType != nil && IsIntegralConstantTarget(targetType)
    }

    /// Folds a bound conversion of a constant `float32` or `float64` operand to a fixed-width integer type,
    /// `char`, or an enum of one of these, with (cref:TryConvertFloatingConstant) (#5767, ADR-0219). The binder
    /// uses it to report GS0635, and the emitter and the expression-tree lowerer use it to emit the folded value.
    /// The `const` fold of (cref:TryFold) uses the same rule for the same storage type. Thus each conversion of
    /// a constant operand has the same value in each position and on each host runtime.
    /// @param conversion The bound conversion.
    /// @param operandValue The constant operand value, boxed as `float32` or `float64`.
    /// @param converted The converted value, boxed as the runtime type of the integer storage type.
    /// @param inRange `false` when the operand value is NaN or out of the range of the target type.
    /// @returns `true` when the conversion is a candidate (cref:IsFloatingConstantConversionCandidate) and the
    /// operand is constant.
    func TryFoldFloatingConstantConversion(
        conversion BoundConversionExpression,
        @NotNullWhen(true) out operandValue object?,
        @NotNullWhen(true) out converted object?,
        out inRange bool
    ) bool {
        operandValue = nil
        converted = nil
        inRange = false
        if !IsFloatingConstantConversionCandidate(conversion) {
            return false
        }
        if !TryEvaluate(conversion.Expression, out var value) || value == nil {
            return false
        }
        operandValue = value
        return TryConvertFloatingConstant(
            Convert.ToDouble(value, CultureInfo.InvariantCulture),
            GetFloatingConstantConversionStorageType(conversion.Type).ClrType!!,
            out converted,
            out inRange
        )
    }

    /// Replaces a bound conversion of a constant `float32` or `float64` operand with its folded value (#5767,
    /// ADR-0219). (cref:Lowering.ConstantConversionFolder) uses it before the other emit-pipeline passes, and the
    /// emitter and the expression-tree lowerer use it too, so the conversion opcodes and `Expression.Convert` of the
    /// host or target runtime do not calculate the value. The result is a literal of
    /// the integer storage type. For an enum target, a conversion of that literal to the enum follows. For a
    /// `Nullable<T>` target, the normal nullable lift of the `T` value follows. These conversions do not change
    /// the value.
    /// @param conversion The bound conversion.
    /// @param folded The folded literal, with the conversions to the enum and nullable target.
    /// @returns `false` when the conversion is not a floating-point constant conversion to an integer, `char`,
    /// or enum type, or when it is a checked conversion of a value out of range. That conversion throws at run
    /// time.
    func TryFoldFloatingConstantConversionToLiteral(
        conversion BoundConversionExpression,
        @NotNullWhen(true) out folded BoundExpression?
    ) bool {
        folded = nil
        if !TryFoldFloatingConstantConversion(conversion, out _, out var converted, out var inRange) ||
            (!inRange && conversion.IsChecked) {
            return false
        }
        let valueType = GetNonNullableTarget(conversion.Type)
        let storageType = GetConstantStorageType(valueType)
        var result = cast[BoundExpression](BoundLiteralExpression(conversion.Syntax, converted, storageType))
        if !object.ReferenceEquals(storageType, valueType) {
            result = BoundConversionExpression(conversion.Syntax, valueType, result)
        }
        if !object.ReferenceEquals(valueType, conversion.Type) {
            result = BoundConversionExpression(conversion.Syntax, conversion.Type, result)
        }
        folded = result
        return true
    }

    /// Whether [`expression`](paramref) contains a checked conversion of a constant `float32` or `float64` value
    /// that is NaN or out of range for its integer, `char`, or enum target (#5767, ADR-0219). That conversion does
    /// not fold, and the binder reports GS0635 for it, when the conversion is bound or when the const fixpoint
    /// gives its operand a value. A const declaration whose initializer contains it does not also get GS0376.
    /// @param expression The bound const initializer.
    /// @returns `true` when the expression contains the conversion.
    func ContainsCheckedOutOfRangeFloatingConstantConversion(expression BoundExpression) bool {
        let finder = CheckedOutOfRangeFloatingConstantConversionFinder()
        finder.VisitExpression(expression)
        return finder.Found
    }

    private class CheckedOutOfRangeFloatingConstantConversionFinder : BoundTreeWalker {
        var Found bool

        protected override func VisitConversionExpression(node BoundConversionExpression) {
            if Found {
                return
            }
            if node.IsChecked && TryFoldFloatingConstantConversion(node, out _, out _, out var inRange) && !inRange {
                Found = true
                return
            }
            base.VisitConversionExpression(node)
        }
    }

    /// Gets the integer storage type of a floating-point constant conversion target: the underlying type of a
    /// `Nullable<T>` target, and then the underlying type of an enum. The CLR type of a `Nullable<T>` symbol is not
    /// the integer type in each representation.
    private func GetFloatingConstantConversionStorageType(type TypeSymbol) TypeSymbol -> GetConstantStorageType(
        GetNonNullableTarget(type)
    )

    private func GetNonNullableTarget(type TypeSymbol) TypeSymbol -> if type is NullableTypeSymbol nullable {
        nullable.UnderlyingType
    } else {
        type
    }

    private func TryGetIntegralBounds(
        type Type,
        out typeCode TypeCode,
        out lower float64,
        out upperExclusive float64
    ) bool {
        lower = 0.0
        upperExclusive = 0.0
        typeCode = if type.IsSameAs(typeof(int8)) {
            TypeCode.SByte
        } else if type.IsSameAs(typeof(uint8)) {
            TypeCode.Byte
        } else if type.IsSameAs(typeof(int16)) {
            TypeCode.Int16
        } else if type.IsSameAs(typeof(uint16)) {
            TypeCode.UInt16
        } else if type.IsSameAs(typeof(char)) {
            TypeCode.Char
        } else if type.IsSameAs(typeof(int32)) {
            TypeCode.Int32
        } else if type.IsSameAs(typeof(uint32)) {
            TypeCode.UInt32
        } else if type.IsSameAs(typeof(int64)) {
            TypeCode.Int64
        } else if type.IsSameAs(typeof(uint64)) {
            TypeCode.UInt64
        } else {
            TypeCode.Empty
        }
        // Each bound is a power of two, so it is exact as a float64.
        switch typeCode {
            case TypeCode.SByte {
                lower = -128.0
                upperExclusive = 128.0
            }
            case TypeCode.Byte {
                upperExclusive = 256.0
            }
            case TypeCode.Int16 {
                lower = -32768.0
                upperExclusive = 32768.0
            }
            case TypeCode.UInt16, TypeCode.Char {
                upperExclusive = 65536.0
            }
            case TypeCode.Int32 {
                lower = -2147483648.0
                upperExclusive = 2147483648.0
            }
            case TypeCode.UInt32 {
                upperExclusive = 4294967296.0
            }
            case TypeCode.Int64 {
                lower = -9223372036854775808.0
                upperExclusive = 9223372036854775808.0
            }
            case TypeCode.UInt64 {
                upperExclusive = 18446744073709551616.0
            }
            default {
                return false
            }
        }
        return true
    }

    private func GetIntegralMinimum(typeCode TypeCode) object -> switch typeCode {
        case TypeCode.SByte: int8.MinValue
        case TypeCode.Int16: int16.MinValue
        case TypeCode.Int32: int32.MinValue
        case TypeCode.Int64: int64.MinValue
        default: Convert.ChangeType(0, typeCode, CultureInfo.InvariantCulture)
    }

    private func GetIntegralMaximum(typeCode TypeCode) object -> switch typeCode {
        case TypeCode.SByte: int8.MaxValue
        case TypeCode.Byte: uint8.MaxValue
        case TypeCode.Int16: int16.MaxValue
        case TypeCode.UInt16: uint16.MaxValue
        case TypeCode.Char: char.MaxValue
        case TypeCode.Int32: int32.MaxValue
        case TypeCode.UInt32: uint32.MaxValue
        case TypeCode.Int64: int64.MaxValue
        default: uint64.MaxValue
    }

    private func IsIntegralConstantTarget(type Type) bool -> TryGetIntegralBounds(type, out _, out _, out _)

    private func IsFloatingRuntimeType(type Type) bool -> type.IsSameAs(typeof(float64)) || type.IsSameAs(
        typeof(float32)
    )

    private func TryInvoke(expression Expression, out value object?) bool {
        let boxed = if expression.Type.IsSameAs(typeof(object)) {
            expression
        } else {
            cast[Expression](Expression.Convert(expression, typeof(object)))
        }
        value = Expression.Lambda[() -> object?](boxed).Compile()()
        return true
    }

    private func TryGetRuntimeType(type TypeSymbol, @NotNullWhen(true) out runtimeType Type?) bool {
        let storageType = GetConstantStorageType(type)
        if storageType != type {
            return TryGetRuntimeType(storageType, out runtimeType)
        }
        if type == TypeSymbol.Null {
            runtimeType = typeof(object)
            return true
        }
        if type.ClrType != nil {
            runtimeType = type.ClrType
            return true
        }
        runtimeType = nil
        return false
    }

    private func IsStringLike(type TypeSymbol) bool -> type == TypeSymbol.String ||
        (type is NullableTypeSymbol nullable && nullable.UnderlyingType == TypeSymbol.String) ||
        type == TypeSymbol.Null

    private func IsShift(kind BoundBinaryOperatorKind) bool -> kind == BoundBinaryOperatorKind.ShiftLeft ||
        kind == BoundBinaryOperatorKind.ShiftRight ||
        kind == BoundBinaryOperatorKind.UnsignedShiftRight

    private func IsSubInt(type TypeSymbol) bool {
        var type = type
        type = GetConstantStorageType(type)
        return type == TypeSymbol.Int8 ||
            type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.Char
    }

    private func IsIntegral(type TypeSymbol) bool {
        var type = type
        type = GetConstantStorageType(type)
        return type == TypeSymbol.Int8 ||
            type == TypeSymbol.UInt8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.Int32 ||
            type == TypeSymbol.UInt32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NInt ||
            type == TypeSymbol.NUInt ||
            type == TypeSymbol.Char
    }

    private func IsSignedIntegral(type TypeSymbol) bool {
        var type = type
        type = GetConstantStorageType(type)
        return type == TypeSymbol.Int8 ||
            type == TypeSymbol.Int16 ||
            type == TypeSymbol.Int32 ||
            type == TypeSymbol.Int64 ||
            type == TypeSymbol.NInt
    }

    private func IsUnsigned(type TypeSymbol) bool {
        var type = type
        type = GetConstantStorageType(type)
        return type == TypeSymbol.UInt8 ||
            type == TypeSymbol.UInt16 ||
            type == TypeSymbol.UInt32 ||
            type == TypeSymbol.UInt64 ||
            type == TypeSymbol.NUInt ||
            type == TypeSymbol.Char
    }

    private func GetConstantStorageType(type TypeSymbol) TypeSymbol -> EnumOperatorTable.GetUnderlyingType(type) ?? type

    private func IsUnsignedRuntimeType(type Type) bool -> type.IsSameAs(typeof(uint8)) || type.IsSameAs(
        typeof(uint16)
    ) ||
        type.IsSameAs(typeof(uint32)) || type.IsSameAs(typeof(uint64)) || type.IsSameAs(typeof(nuint)) || type.IsSameAs(
        typeof(char)
    )

    private func IsFoldFailure(exception Exception) bool -> exception is ArithmeticException ||
        exception is InvalidOperationException ||
        exception is InvalidCastException ||
        exception is ArgumentException ||
        exception is NotSupportedException ||
        exception is NullReferenceException
}
