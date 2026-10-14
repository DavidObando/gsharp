// <copyright file="Issue1881CheckedUncheckedEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #1881: emitted-oracle coverage for `checked`/`unchecked`
/// expressions and blocks. Pins that overflow throws
/// (cref:System.OverflowException) (caught here via a G#-level
/// try/catch, mirroring real usage) in a checked context, and wraps silently
/// in an unchecked context (the C# project default), across signed/unsigned
/// integer widths and narrowing conversions.
open class Issue1881CheckedUncheckedEmittedOracleTests {
    @Fact
    func CheckedAddition_Int32_Overflow_ThrowsOverflowException() {
        let result = Evaluate(
            "var maxInt int32 = 2147483647\n" +
                "var one int32 = 1\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(maxInt + one)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func UncheckedAddition_Int32_Overflow_Wraps() {
        let result = Evaluate(`var maxInt int32 = 2147483647
var one int32 = 1
unchecked(maxInt + one)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-2147483648, result.Value)
    }

    @Fact
    func CheckedStatement_BlockOverflow_ThrowsOverflowException() {
        let result = Evaluate(
            "var caught = \"no\"\n" +
                "checked {\n" +
                "    var maxInt int32 = 2147483647\n" +
                "    var one int32 = 1\n" +
                "    try {\n" +
                "        var boom = maxInt + one\n" +
                "    } catch (e OverflowException) {\n" +
                "        caught = \"yes\"\n" +
                "    }\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func UncheckedStatement_BlockOverflow_Wraps() {
        let result = Evaluate(
            "var wrapped int32 = 0\n" +
                "unchecked {\n" +
                "    var maxInt int32 = 2147483647\n" +
                "    var one int32 = 1\n" +
                "    wrapped = maxInt + one\n" +
                "}\n" +
                "wrapped"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-2147483648, result.Value)
    }

    @Fact
    func CheckedSubtraction_UInt64_Underflow_ThrowsOverflowException() {
        let result = Evaluate(
            "var zero uint64 = 0\n" +
                "var one uint64 = 1\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(zero - one)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func UncheckedSubtraction_UInt64_Underflow_Wraps() {
        let result = Evaluate(`var zero uint64 = 0
var one uint64 = 1
unchecked(zero - one)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(uint64.MaxValue, result.Value)
    }

    @Fact
    func CheckedMultiplication_Int64_Overflow_ThrowsOverflowException() {
        let result = Evaluate(
            "var big int64 = 9223372036854775807\n" +
                "var two int64 = 2\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(big * two)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func CheckedNarrowingConversion_ByteFromInt32_Overflow_ThrowsOverflowException() {
        let result = Evaluate(
            "var big int32 = 300\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var narrow = checked(byte(big))\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func UncheckedNarrowingConversion_ByteFromInt32_Truncates() {
        let result = Evaluate("unchecked(byte(300))")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(uint8(44), result.Value)
    }

    @Fact
    func CheckedMultiplication_Int64_NoOverflow_MatchesEmitPrecision() {
        // Regression for the switch-expression "best common type" boxing bug
        // caught during development: mixed-type switch arms inside `checked(...)`
        // implicitly widened every arm to `double`, silently corrupting
        // magnitudes before the checked narrow-back — this exact shape
        // (`long(x) * long(y)` inside `checked { }`) triggered an
        // InvalidCastException at the enclosing conversion instead of the
        // correct result.
        let result = Evaluate(
            "var lz int64 = 0\n" +
                "checked {\n" +
                "    var x int32 = 1000000\n" +
                "    var y int32 = 2000\n" +
                "    lz = long(x) * long(y)\n" +
                "}\n" +
                "lz"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2000000000L, result.Value)
    }

    @Fact
    func NestedContexts_InnermostUncheckedInsideChecked_Wraps() {
        let result = Evaluate(
            "var wrapped int32 = 0\n" +
                "checked {\n" +
                "    var maxInt int32 = 2147483647\n" +
                "    var one int32 = 1\n" +
                "    unchecked {\n" +
                "        wrapped = maxInt + one\n" +
                "    }\n" +
                "}\n" +
                "wrapped"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-2147483648, result.Value)
    }

    @Fact
    func NestedContexts_InnermostCheckedInsideUnchecked_Throws() {
        let result = Evaluate(
            "var caught = \"no\"\n" +
                "unchecked {\n" +
                "    var maxInt int32 = 2147483647\n" +
                "    var one int32 = 1\n" +
                "    try {\n" +
                "        checked {\n" +
                "            var boom = maxInt + one\n" +
                "        }\n" +
                "    } catch (e OverflowException) {\n" +
                "        caught = \"yes\"\n" +
                "    }\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func CheckedFloatMultiplication_Overflow_ProducesInfinityNotException() {
        let result = Evaluate(`var big float64 = 1.0e308
var ten float64 = 10.0
checked(big * ten)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(float64.PositiveInfinity, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
