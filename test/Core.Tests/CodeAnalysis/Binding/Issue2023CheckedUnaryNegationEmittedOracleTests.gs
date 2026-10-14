// <copyright file="Issue2023CheckedUnaryNegationEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #2023: emitted-oracle coverage for unary negation of each width's
/// `MinValue` inside a
/// `checked`/`unchecked` context: overflow throws
/// (cref:System.OverflowException) in a checked context and wraps
/// silently in an unchecked context (the project default per #1881), while
/// floating-point negation never traps regardless of context.
open class Issue2023CheckedUnaryNegationEmittedOracleTests {
    @Fact
    func CheckedNegation_Int32MinValue_ThrowsOverflowException() {
        let result = Evaluate(
            "var minInt int32 = -2147483647 - 1\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(-minInt)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func CheckedNegation_Int64MinValue_ThrowsOverflowException() {
        let result = Evaluate(
            "var minLong int64 = -9223372036854775807 - 1\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(-minLong)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func CheckedNegation_Int8MinValue_ThrowsOverflowException() {
        let result = Evaluate(
            "var minI8 int8 = -128\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(-minI8)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func CheckedNegation_Int16MinValue_ThrowsOverflowException() {
        let result = Evaluate(
            "var minI16 int16 = -32768\n" +
                "var caught = \"no\"\n" +
                "try {\n" +
                "    var boom = checked(-minI16)\n" +
                "} catch (e OverflowException) {\n" +
                "    caught = \"yes\"\n" +
                "}\n" +
                "caught"
        )
        Assert.Empty(result.Diagnostics)
        Assert.Equal("yes", result.Value)
    }

    @Fact
    func CheckedNegation_OrdinaryValue_ReturnsNegated() {
        let result = Evaluate("var five int32 = 5\nchecked(-five)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-5, result.Value)
    }

    @Fact
    func UncheckedNegation_Int32MinValue_Wraps() {
        let result = Evaluate("var minInt int32 = -2147483647 - 1\nunchecked(-minInt)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-2147483648, result.Value)
    }

    @Fact
    func UncheckedNegation_Int64MinValue_Wraps() {
        let result = Evaluate("var minLong int64 = -9223372036854775807 - 1\nunchecked(-minLong)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int64.MinValue, result.Value)
    }

    @Fact
    func UncheckedNegation_Int8MinValue_Wraps() {
        let result = Evaluate("var minI8 int8 = -128\nunchecked(-minI8)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(int8.MinValue, result.Value)
    }

    @Fact
    func DefaultContext_NegationOfInt32MinValue_Wraps() {
        // Issue #1881 established unchecked as the project default when no
        // explicit checked/unchecked context is in scope; negation must match.
        let result = Evaluate(`var minInt int32 = -2147483647 - 1
var wrapped = -minInt
wrapped`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-2147483648, result.Value)
    }

    @Fact
    func CheckedStatement_NegationOfMinValue_ThrowsOverflowException() {
        let result = Evaluate(
            "var caught = \"no\"\n" +
                "checked {\n" +
                "    var minInt int32 = -2147483647 - 1\n" +
                "    try {\n" +
                "        var boom = -minInt\n" +
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
    func CheckedFloatNegation_NoOverflowEverOccurs() {
        let result = Evaluate("var big float64 = -1.7976931348623157e308\nchecked(-big)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1.7976931348623157e308, result.Value)
    }

    @Fact
    func CheckedDecimalNegation_NoOverflowEverOccurs() {
        let result = Evaluate("var d decimal = 5.5m\nchecked(-d)")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-5.5m, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
