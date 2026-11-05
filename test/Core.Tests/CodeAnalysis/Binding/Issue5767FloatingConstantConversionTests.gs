// <copyright file="Issue5767FloatingConstantConversionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Tests
import System
import System.Globalization
import Xunit

/// Issue #5767, ADR-0219: a constant floating-point to integer conversion that is NaN or out of range
/// is error GS0635 unless an explicit `unchecked` context contains it. gsc folds these conversions with
/// one saturating rule. The JIT of the runtime that hosts gsc does not calculate the value.
open class Issue5767FloatingConstantConversionTests {
    @Theory
    @InlineData("const a int8 = int8(300.5)\na")
    @InlineData("let a = int8(300.5)\na")
    @InlineData("const a uint16 = uint16(70000.0)\na")
    @InlineData("const a int32 = int32(1e10)\na")
    @InlineData("const a uint8 = uint8(-1.5)\na")
    @InlineData("const a uint32 = uint32(-1.0)\na")
    @InlineData("const a int64 = int64(1e30)\na")
    @InlineData("const a uint64 = uint64(2e19)\na")
    @InlineData("const a int32 = int32(float64.NaN)\na")
    @InlineData("const a int32 = int32(float64.PositiveInfinity)\na")
    @InlineData("const a char = char(70000.0)\na")
    @InlineData("const a int16 = int16(float32(40000.0))\na")
    @InlineData("const big = 300.5\nconst a int8 = int8(big + 1.0)\na")
    @InlineData("const a int8 = cast[int8](300.5)\na")
    @InlineData("let a = checked(int8(300.5))\na")
    @InlineData("let a = unchecked(checked(int8(300.5)))\na")
    @InlineData("let a = Math.Abs(int32(1e10))\na")
    @InlineData("func F(x int8 = int8(300.5)) int8 {\n    return x\n}\nF()")
    @InlineData("let f = () -> int8(1e10)\nf()")
    @InlineData("class C {\n    shared {\n        let B int8 = int8(1e10)\n    }\n}\nC.B")
    @InlineData("struct S {\n    var X int32\n    shared {\n        let D uint16 = uint16(70000.0)\n    }\n}\nS.D")
    @InlineData("interface I {\n    shared {\n        let E int8 = int8(-1e9)\n    }\n}\nI.E")
    func OutOfRangeConstantConversion_OutsideUnchecked_ReportsGS0635Once(source string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0635")
    }

    @Fact
    func OutOfRangeConstantConversion_MessageNamesValueAndType() {
        let result = EmittedOracle.Evaluate("const a int8 = int8(300.5)\na")
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0635", diagnostic.Id)
        Assert.Equal(
            "Constant value '300.5' cannot be converted to 'int8' because it is NaN or out of range. " +
                "Use 'unchecked(...)' to convert it with saturation.",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("const a int8 = int8(-127.9)\na", "-127")
    @InlineData("const a uint8 = uint8(-0.9)\na", "0")
    @InlineData("const a int32 = int32(2.9)\na", "2")
    @InlineData("const a int32 = int32(-2.9)\na", "-2")
    @InlineData("const a uint64 = uint64(1e19)\na", "10000000000000000000")
    @InlineData("const a int64 = int64(-9223372036854775808.0)\na", "-9223372036854775808")
    func InRangeConstantConversion_TruncatesWithoutDiagnostic(source string, expected string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    /// A conversion of a variable is a run-time conversion, so GS0635 does not apply.
    @Fact
    func NonConstantOperand_ReportsNoDiagnostic() {
        let result = EmittedOracle.Evaluate("var d = 300.5\nlet a = int8(d)\n\"done\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("done", result.ValueText)
    }

    /// The old fold used the host JIT. On .NET 10 it gave 44, 4464, 255, and 4464 for the first, second,
    /// fourth, and seventh rows; on .NET 11 it gave the saturated values. The fold now gives the
    /// saturated values on each host.
    @Theory
    @InlineData("const a int8 = unchecked(int8(300.5))\na", "127")
    @InlineData("const a uint16 = unchecked(uint16(70000.0))\na", "65535")
    @InlineData("const a int8 = unchecked(int8(-1e9))\na", "-128")
    @InlineData("const a uint8 = unchecked(uint8(-1.5))\na", "0")
    @InlineData("const a int32 = unchecked(int32(1e10))\na", "2147483647")
    @InlineData("const a int64 = unchecked(int64(-1e30))\na", "-9223372036854775808")
    @InlineData("const a char = unchecked(char(70000.0))\nint32(a)", "65535")
    @InlineData("const a uint64 = unchecked(uint64(2e19))\na", "18446744073709551615")
    @InlineData("const a int32 = unchecked(int32(float64.NaN))\na", "0")
    @InlineData("const a int16 = unchecked(int16(float32(40000.0)))\na", "32767")
    @InlineData("const a int8 = checked(unchecked(int8(300.5)))\na", "127")
    func OutOfRangeConstantConversion_InUnchecked_FoldsWithSaturation(source string, expected string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.ValueText)
    }

    @Fact
    func UncheckedBlock_SuppressesGS0635() {
        let result = EmittedOracle.Evaluate(
            "var value int32 = 0\n" +
                "unchecked {\n" +
                "    const a int8 = int8(300.5)\n" +
                "    value = int32(a)\n" +
                "}\n" +
                "value"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("127", result.ValueText)
    }

    @Theory
    @InlineData(300.5, typeof(int8), "127", false)
    @InlineData(-300.5, typeof(int8), "-128", false)
    @InlineData(127.99, typeof(int8), "127", true)
    @InlineData(-128.99, typeof(int8), "-128", true)
    @InlineData(-0.99, typeof(uint8), "0", true)
    @InlineData(256.0, typeof(uint8), "255", false)
    @InlineData(65535.5, typeof(char), "65535", true)
    @InlineData(4294967296.0, typeof(uint32), "4294967295", false)
    @InlineData(9223372036854775807.0, typeof(int64), "9223372036854775807", false)
    @InlineData(18446744073709551615.0, typeof(uint64), "18446744073709551615", false)
    @InlineData(18446744073709549568.0, typeof(uint64), "18446744073709549568", true)
    func TryConvertFloatingConstant_TruncatesInRangeAndSaturatesOutOfRange(
        value float64,
        targetType Type,
        expected string,
        expectedInRange bool
    ) {
        Assert.True(
            ConstantExpressionEvaluator.TryConvertFloatingConstant(
                value,
                targetType,
                out var converted,
                out var inRange
            )
        )
        Assert.IsType(targetType, converted)
        let text = if converted is char character {
            int32(character).ToString(CultureInfo.InvariantCulture)
        } else {
            Convert.ToString(converted, CultureInfo.InvariantCulture)
        }
        Assert.Equal(expected, text)
        Assert.Equal(expectedInRange, inRange)
    }

    @Fact
    func TryConvertFloatingConstant_NaN_IsZeroAndOutOfRange() {
        Assert.True(
            ConstantExpressionEvaluator.TryConvertFloatingConstant(
                float64.NaN,
                typeof(uint16),
                out var converted,
                out var inRange
            )
        )
        Assert.Equal(cast[uint16](0), converted)
        Assert.False(inRange)
    }

    @Theory
    @InlineData(typeof(float32))
    @InlineData(typeof(decimal))
    @InlineData(typeof(nint))
    @InlineData(typeof(DayOfWeek))
    func TryConvertFloatingConstant_NonIntegerTarget_ReturnsFalse(targetType Type) {
        Assert.False(
            ConstantExpressionEvaluator.TryConvertFloatingConstant(1.0, targetType, out var converted, out var inRange)
        )
        Assert.Null(converted)
        Assert.False(inRange)
    }
}
