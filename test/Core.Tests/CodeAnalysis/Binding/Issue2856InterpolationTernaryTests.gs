// <copyright file="Issue2856InterpolationTernaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import Xunit

/// Issue #2856: top-level ternaries inside interpolation holes.
open class Issue2856InterpolationTernaryTests {
    @Fact
    func TopLevelTernary_Evaluates() {
        let result = Evaluate("let ok = true\nlet text = \"$${ok ? 1 : 2}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1", Value(result, "text"))
    }

    @Fact
    func TopLevelTernary_WithFormatSpecifier_Evaluates() {
        let result = Evaluate("let ok = true\nlet text = \"$${ok ? 1 : 2:D4}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("0001", Value(result, "text"))
    }

    @Fact
    func TopLevelTernary_WithAlignmentAndFormat_Evaluates() {
        let result = Evaluate(`let ok = true
let aligned = "[${ok ? 1 : 2,6}]"
let formatted = "[${ok ? 1 : 2,6:D4}]"`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("[     1]", Value(result, "aligned"))
        Assert.Equal("[  0001]", Value(result, "formatted"))
    }

    @Fact
    func NestedTopLevelTernaries_Evaluate() {
        let result = Evaluate(`let first = true
let second = false
let text = "${first ? second ? 1 : 2 : 3}"`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("2", Value(result, "text"))
    }

    @Fact
    func TopLevelTernary_WithNestedInterpolation_Evaluates() {
        let result = Evaluate("let ok = true\nlet text = \"$${ok ? \"nested=$${1}\" : \"no\"}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nested=1", Value(result, "text"))
    }

    @Fact
    func DeepNestedInterpolation_WithOuterFormat_Evaluates() {
        // A timing assertion would be flaky in CI. Depth 18 keeps correctness
        // coverage while making an accidental return to two parses per level
        // obvious in local interpolation-suite timings.
        var expression = "1"
        for var i = 0; i < 18; i++ {
            expression = "\"$${" + expression + "}\""
        }
        let result = Evaluate("let text = \"[$${" + expression + ",6:D4}]\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("[     1]", Value(result, "text"))
    }

    @Fact
    func TopLevelTernary_IgnoresConditionalPunctuationInComments() {
        let result = Evaluate("let ok = true\nlet text = \"$${ok /* ? : */ ? 1 : 2}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1", Value(result, "text"))
    }

    @Theory
    @InlineData("let text = \"$${maybe ?? false ? 1 : 2}\"")
    @InlineData("let text = \"$${node?.Ready ? 1 : 2}\"")
    @InlineData("let text = \"$${items?[0] != nil ? 1 : 2}\"")
    func QuestionPrefixedOperators_DoNotOpenTernaries(source string) {
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func MapLiteralInsideTopLevelTernary_Parses() {
        let tree = SyntaxTree.Parse(SourceText.From("let text = \"$${ok ? map[string,int32]{\"a\": 1}[\"a\"] : 2}\""))
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func PlainFormatSpecifier_RemainsSupported_Guard() {
        let result = Evaluate("let value = 42\nlet text = \"$${value:D4}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("0042", Value(result, "text"))
    }

    @Fact
    func ParenthesizedTernary_RemainsSupported_Guard() {
        let result = Evaluate("let ok = true\nlet text = \"$${(ok ? 1 : 2)}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("1", Value(result, "text"))
    }

    @Fact
    func NamedArgumentColonInsideHole_RemainsExpression_Guard() {
        let result = Evaluate("func identity(value int32) int32 -> value\nlet text = \"$${identity(value: 7)}\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("7", Value(result, "text"))
    }

    @Theory
    @InlineData("let text = \"$${[]int32?{1, 2, 3}.Length:D4}\"", "0003")
    @InlineData("let text = \"$${[3]int32?{1, 2, 3}.Length:D4}\"", "0003")
    @InlineData("let text = \"$${[]string?{\"a\", \"b\"}.Length:D4}\"", "0002")
    func NullableElementArrayLiteral_WithFormat_RemainsSupported_Guard(declaration string, expected string) {
        let result = Evaluate(declaration)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, Value(result, "text"))
    }

    @Fact
    func NullableElementArrayLiteral_WithAlignment_RemainsSupported_Guard() {
        let result = Evaluate("let text = \"[$${[]int32?{1, 2, 3}.Length,6}]\"")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("[     3]", Value(result, "text"))
    }

    @Fact
    func NullableGlobalForwarder_PreservesNullAndItsContract() {
        let method MethodInfo? = typeof(Issue2856InterpolationTernaryTests).GetMethod(
            "Value",
            BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.Equal(NullabilityState.Nullable, NullabilityInfoContext().Create(method!!.ReturnParameter).ReadState)
        let result = Evaluate("let value string? = nil")
        Assert.Empty(result.Diagnostics)
        Assert.Null(Value(result, "value"))
    }

    shared {
        private func Evaluate(source string)(
            Diagnostics ImmutableArray[Diagnostic],
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result.Diagnostics, result.ReadGlobals())
        }

        private func Value(
            result(Diagnostics ImmutableArray[Diagnostic], Variables IReadOnlyDictionary[string, object?]),
            name string
        ) object? -> result.Variables[name]
    }
}
