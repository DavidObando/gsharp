// <copyright file="WrappingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0179 phase 6. The exit criterion the ADR names for wrapping is a
/// line-width property test, so that is what this file is built around: one
/// over-long source per breakable construct, each asserted to come back inside
/// the canonical width, to survive the round-trip check, and to be a fixed
/// point of the formatter.
class WrappingTests {
    @Theory
    @MemberData("WideShapes")
    func Format_KeepsEveryLineWithinTheCanonicalWidth(name string, input string) {
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.True(
            result.Diagnostics.IsEmpty,
            name + ": " + string.Join(Environment.NewLine, result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        // A line may only exceed the width when a single token already does —
        // the formatter is not allowed to break a literal or an identifier.
        for line in result.Text!!.ToString().Split('\n') {
            Assert.True(
                line.Length <= MaxLineWidth || WidestToken(line) + Indentation(line) > MaxLineWidth,
                name + ": line exceeded the canonical width: " + line
            )
        }
    }

    @Theory
    @MemberData("WideShapes")
    func Format_IsAFixedPointOnItsOwnWrappedOutput(name string, input string) {
        // The wrapped output is the input the formatter sees most often — the
        // language server re-formats on every save, and `gsfmt --check` re-runs
        // itself in CI (ADR-0179 D4). A break the layout invents on pass one and
        // then re-reads as an author newline on pass two is not idempotent, and
        // that is exactly what a continuation indent used to be.
        let once = GSharpFormatter.Format(SourceText.From(input))
        Assert.True(once.Diagnostics.IsEmpty, name)
        let twice = GSharpFormatter.Format(once.Text!!)
        Assert.True(twice.Diagnostics.IsEmpty, name)
        Assert.Equal(once.Text!!.ToString(), twice.Text!!.ToString())
        Assert.False(twice.Changed, name + ": formatting its own output changed it.")
    }

    @Fact
    func Format_ReflowsAContinuationItPreviouslyWrapped() {
        // The regression in miniature: a hard break kept from the input landed
        // at the enclosing indent, dropping the +4 the group had used, so the
        // second pass produced different text from the first.
        const input = "func run(alpha bool, beta bool) bool {\n" + "    return alpha &&\n" + "(beta || alpha)\n" + "}\n"
        let once = GSharpFormatter.Format(SourceText.From(input))
        let twice = GSharpFormatter.Format(once.Text!!)
        Assert.Empty(once.Diagnostics)
        Assert.Equal(once.Text!!.ToString(), twice.Text!!.ToString())
        Assert.Contains("return alpha && (beta || alpha)", once.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_KeepsAnArgumentsOwnChainFlatWhenTheArgumentListBreaks() {
        // Each element of a list is its own group, so breaking the list does not
        // break what is inside the elements. Without that, one over-long call
        // exploded every operator and every `.` in every argument.
        let arguments = string.Join(
            ", ",
            Enumerable.Range(0, 8).Select((index int32) -> "first$index + second$index + third$index")
        )
        let input = (`func run() {
Compute(` + "$arguments" + `)
}
`)
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.Contains(`
    Compute(
        first0 + second0 + third0,
`, formatted, StringComparison.Ordinal)
    }

    @Fact
    func Format_DoesNotStrandTheReceiverOfAShortMemberChain() {
        // `Console.WriteLine(<block argument>)` is one link. Breaking it put
        // `Console` alone on a line and `.WriteLine(` on the next, which is the
        // single ugliest shape the wrapped corpus produced.
        const input = "func run() {\n" +
            "Console.WriteLine(func (value int32) int32 {\n" +
            "return value + value\n" +
            "})\n" +
            "}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("Console.WriteLine(", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_BreaksAMemberChainLongEnoughToReadVertically() {
        const input = "func run(text string) string {\n" +
            "return text.ToUpper().Trim().ToLowerInvariant().Replace(\"alpha\", \"beta\")" +
            ".Substring(0, 3).PadLeft(40).TrimEnd().ToUpperInvariant().Normalize().Trim()\n" +
            "}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains(`
        .ToUpper()
`, result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_BreaksAPatternDisjunction() {
        // G# spells pattern `or`/`and` as contextual identifiers, not operator
        // tokens, so this arm had no break point of any kind and stayed long no
        // matter how the rest of the layout improved.
        let patterns = string.Join(
            " or ",
            Enumerable.Range(0, 12).Select((index int32) -> "SyntaxKind.TokenNumber$index")
        )
        let input = "func run(kind SyntaxKind) bool {\n" + (`return switch kind {
case ` + "$patterns" + `: true
default: false
}
`) + "}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.Contains("SyntaxKind.TokenNumber0 or\n", formatted, StringComparison.Ordinal)
        Assert.All(
            formatted.Split('\n'),
            (line string) -> Assert.True(line.Length <= MaxLineWidth, "line exceeded the canonical width: " + line)
        )
    }

    @Fact
    func Format_BreaksANullCoalescingChain() {
        // ADR-0179's phase-7b measurement counts `??` alongside `&&`/`||`/
        // `or`/`and` as a chain family that goes fully to zero reducible long
        // lines, but only `&&`/`||`/`or`/`and` had a wrap point implemented.
        const input = "func run(alpha string, beta string, gamma string) string {\n" +
            "return alpha ?? beta ?? gamma ?? alpha ?? beta ?? gamma ?? alpha ?? beta ?? gamma " +
            "?? \"a default fallback value long enough to push this line past the width\"\n" +
            "}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.Contains("alpha ??\n", formatted, StringComparison.Ordinal)
        Assert.All(
            formatted.Split('\n'),
            (line string) -> Assert.True(line.Length <= MaxLineWidth, "line exceeded the canonical width: " + line)
        )
    }

    @Fact
    func Format_WrapsAnOverlongForClauseHeaderAtItsSeparators() {
        const input = "func run() {\n" +
            "for initialValueForTheLoopCounterVariable = 0; " +
            "initialValueForTheLoopCounterVariable < someUpperBoundLimitValueForTesting; " +
            "initialValueForTheLoopCounterVariable++ {\n" +
            "Console.WriteLine(initialValueForTheLoopCounterVariable)\n" +
            "}\n" +
            "}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.Contains(
            "for initialValueForTheLoopCounterVariable = 0;\n        " +
                "initialValueForTheLoopCounterVariable < someUpperBoundLimitValueForTesting;\n        " +
                "initialValueForTheLoopCounterVariable++ {\n",
            formatted,
            StringComparison.Ordinal
        )
        Assert.All(
            formatted.Split('\n'),
            (line string) -> Assert.True(line.Length <= MaxLineWidth, "line exceeded the canonical width: " + line)
        )
    }

    shared {
        private const MaxLineWidth int32 = 120

        /// Gets one over-long source per construct the formatter is expected to
        /// break. Each is a single logical line well past the budget with at least
        /// one legal break point inside it.
        func WideShapes() TheoryData[string, string] {
            let data = TheoryData[string, string]()
            for shape in Shapes() {
                data.Add(shape.Key, shape.Value)
            }
            return data
        }

        private func Shapes() sequence[KeyValuePair[string, string]] {
            let wide = string.Join(
                ", ",
                Enumerable.Range(0, 12).Select((index int32) -> "\"argument value number $index\"")
            )
            yield Shape("call argument list", (`func run() {
Compute(` + "$wide" + `)
}
`))
            yield Shape("nested single-argument call", (`func run() {
Outer(Inner(` + "$wide" + `))
}
`))
            yield Shape("collection literal", (`func run() {
let values = []string{` + "$wide" + `}
}
`))
            yield Shape("composite literal", `class Point {
    var X int32
    var Y int32
}
` + "func run(n int32) {\n" + "let point = Point{X: n + n + n + n + n + n + n + n + n + n + n, " + "Y: n * n * n * n * n * n * n * n * n * n * n * n}\n" + "}\n")
            yield Shape(
                "logical operator chain",
                "func run(alpha string, beta string, n int32) bool {\n" +
                    "return alpha == \"alpha\" && beta == \"beta\" && n > 100 && alpha != beta " +
                    "&& n < 1000 && alpha != \"gamma\" && true\n" +
                    "}\n"
            )
            yield Shape(
                "null-coalescing chain",
                "func run(alpha string, beta string, gamma string) string {\n" +
                    "return alpha ?? beta ?? gamma ?? alpha ?? beta ?? gamma ?? alpha ?? beta ?? gamma " +
                    "?? \"a default fallback value long enough to push this line past the width\"\n" +
                    "}\n"
            )
            yield Shape(
                "C-style for-clause header",
                "func run() {\n" +
                    "for initialValueForTheLoopCounterVariable = 0; " +
                    "initialValueForTheLoopCounterVariable < someUpperBoundLimitValueForTesting; " +
                    "initialValueForTheLoopCounterVariable++ {\n" +
                    "Console.WriteLine(initialValueForTheLoopCounterVariable)\n" +
                    "}\n" +
                    "}\n"
            )
            yield Shape(
                "arithmetic operator chain",
                "func run(n int32) int32 {\n" +
                    "return n + n + n + n + n + n + n + n + n + n + n + n + n + n + n + n + n " +
                    "+ n + n + n + n + n + n + n + n + n\n" +
                    "}\n"
            )
            yield Shape(
                "if-expression initialiser",
                "func run(alpha string) string {\n" +
                    "let chosen = if alpha == \"alpha\" { \"the alpha branch result value here\" } " +
                    "else { \"the fallback branch result value here\" }\n" +
                    "return chosen\n" +
                    "}\n"
            )
            yield Shape(
                "member chain",
                "func run(text string) string {\n" +
                    "return text.ToUpper().Trim().ToLowerInvariant().Replace(\"alpha\", \"beta\")" +
                    ".Substring(0, 3).PadLeft(40).TrimEnd().ToUpperInvariant().Normalize().Trim()\n" +
                    "}\n"
            )
            yield Shape(
                "short member chain",
                "func run() {\n" + String('r', 46) + "." + String('m', 44) + "()." + String('n', 44) + `()
}
`
            )
            yield Shape("indented short member chain", `func run() {
if true {
if true {
` + String('r', 30) + "." + String('m', 38) + "()." + String('n', 38) + `()
}
}
}
`)
            yield Shape(
                "wide member chain tail",
                "func run() {\n" +
                    String('r', 30) +
                    "." +
                    String('a', 45) +
                    "()." +
                    String('b', 45) +
                    "()." +
                    String('c', 45) +
                    `()
}
`
            )
            yield Shape(
                "nullable member chain",
                "func run(argument int32) {\n" +
                    String('r', 45) +
                    "." +
                    String('h', 35) +
                    "?(argument)." +
                    String('f', 35) +
                    `()
}
`
            )
            yield Shape(
                "switch-arm pattern disjunction",
                "func run(kind SyntaxKind) bool {\n" + "return switch kind {\ncase " + string.Join(
                    " or ",
                    Enumerable.Range(0, 12).Select((index int32) -> "SyntaxKind.TokenNumber$index")
                ) +
                    `: true
default: false
}
}
`
            )
            yield Shape(
                "signature parameter list",
                "func run(" + string.Join(
                    ", ",
                    Enumerable.Range(0, 12).Select((index int32) -> "parameterNumber$index string")
                ) +
                    `) int32 {
return 0
}
`
            )
        }

        private func Shape(name string, input string) KeyValuePair[string, string] -> KeyValuePair[string, string](
            name,
            input
        )

        private func Indentation(line string) int32 -> line.Length - line.TrimStart().Length

        private func WidestToken(line string) int32 -> SyntaxTree
            .ParseTokens(line)
            .Where(
            (token SyntaxToken) -> (token.Kind is not SyntaxKind.WhitespaceToken and not SyntaxKind.EndOfFileToken)
        )
            .Select((token SyntaxToken) -> token.Text.Length)
            .DefaultIfEmpty()
            .Max()
    }
}
