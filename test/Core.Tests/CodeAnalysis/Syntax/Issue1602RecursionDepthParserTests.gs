// <copyright file="Issue1602RecursionDepthParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import System.Text
import Xunit

/// Issue #1602: the recursive-descent parser (and the lexer's
/// interpolation-hole scanner) enforce a recursion-depth limit so that deeply
/// nested input — well-formed or truncated — produces a clean GS0417
/// diagnostic instead of an uncatchable (cref:System.StackOverflowException)
/// that kills the whole process. IDEs feed the parser unbalanced text on every
/// keystroke (`a[a[a[…` is exactly what an editor buffer looks like mid-edit),
/// so every repro here is exercised at depths well past the limit. Mirrors
/// Roslyn's CS8078 / ParseWithStackGuard behaviour: past the limit the parse
/// is abandoned wholesale and a minimal compilation unit is returned, so the
/// binder never sees an unboundedly deep tree either.
open class Issue1602RecursionDepthParserTests {
    @Fact
    func DeepUnbalancedIndexNesting_IssueRepro_ReportsGS0417() {
        // The exact issue #1602 repro: `let x = a[a[a[…` with 2,000
        // repetitions (a ~2 KB file) used to kill the process (exit 134).
        let tree = ParseNested("package P\nlet x = ", "a[", 2_000, string.Empty)
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepUnbalancedIndexNesting_WellPastTheLimit_ReportsGS0417() {
        let tree = ParseNested("package P\nlet x = ", "a[", 20_000, string.Empty)
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepWellFormedParenthesizedExpression_ReportsGS0417() {
        let tree = ParseNested("package P\nlet x = ", "(", 20_000, "1" + String(')', 20_000))
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepTruncatedParenthesizedExpression_ReportsGS0417() {
        let tree = ParseNested("package P\nlet x = ", "(", 20_000, string.Empty)
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepUnaryOperatorChain_ReportsGS0417() {
        // Alternating `-+` avoids the lexer fusing `--`/`++` so every token is
        // a plain prefix unary operator recursing through the binary layer.
        let tree = ParseNested("package P\nlet x = ", "-+", 10_000, "1")
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepPrefixDecrementChain_ReportsGS0417() {
        // A raw `-` run lexes as fused `--` prefix decrement tokens; each one
        // still recurses once per operator and must be bounded too.
        let tree = ParseNested("package P\nlet x = ", "-", 20_000, "1")
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepAssignmentChain_ReportsGS0417() {
        // `a = a = a = …` self-recurses through the assignment right-hand
        // side without re-entering ParseExpression.
        let tree = ParseNested(`package P
func f() {
`, "a = ", 20_000, "1\n}")
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepNullCoalescingChain_ReportsGS0417() {
        // `a ?? a ?? …` self-recurses through the right-associative `??` tail.
        let tree = ParseNested("package P\nlet x = ", "a ?? ", 20_000, "a")
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepWellFormedGenericTypeNesting_ReportsGS0417() {
        let tree = ParseNested("package P\nlet x = default(", "List[", 20_000, "int32" + String(']', 20_000) + ")")
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepTruncatedGenericTypeNesting_ReportsGS0417() {
        let tree = ParseNested("package P\nlet x = default(", "List[", 20_000, string.Empty)
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepNestedBlockStatements_ReportsGS0417() {
        let tree = ParseNested(`package P
func f() {
`, "{", 20_000, string.Empty)
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepNestedClassDeclarations_ReportsGS0417() {
        let tree = ParseNested("package P\n", "class A {\n", 5_000, string.Empty)
        AssertSingleNestingTooDeep(tree)
    }

    @Fact
    func DeepWellFormedInterpolationNesting_ReportsGS0417() {
        // `"${"${"${…1…}"}"}"` — the lexer's ScanInterpolationHole ↔
        // SkipInterpolationNestedLiteral mutual recursion is bounded too.
        let tree = ParseNested("package P\nlet s = ", "\"$${", 20_000, "1" + Repeat("}\"", 20_000))
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == NestingTooDeepId)
        Assert.NotNull(tree.Root)
    }

    @Fact
    func DeepTruncatedInterpolationNesting_ReportsGS0417() {
        let tree = ParseNested("package P\nlet s = ", "\"$${", 20_000, string.Empty)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == NestingTooDeepId)
        Assert.NotNull(tree.Root)
    }

    @Fact
    func ReasonableParenthesisNesting_ParsesWithoutDiagnostics() {
        // A reasonable-depth program must stay untouched by the guard.
        let tree = ParseNested("package P\nlet x = ", "(", 100, "1" + String(')', 100))
        Assert.Empty(tree.Diagnostics)
        let statement = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        Assert.NotNull(statement.Initializer)
    }

    @Fact
    func ReasonableIndexNesting_ParsesWithoutDiagnostics() {
        let tree = ParseNested("package P\nlet x = ", "a[", 50, "1" + String(']', 50))
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ReasonableUnaryChain_ParsesWithoutDiagnostics() {
        let tree = ParseNested("package P\nlet x = ", "-+", 50, "1")
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ReasonableTypeNesting_ParsesWithoutDiagnostics() {
        let tree = ParseNested("package P\nlet x = default(", "List[", 50, "int32" + String(']', 50) + ")")
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ReasonableInterpolationNesting_ParsesWithoutDiagnostics() {
        let tree = ParseNested("package P\nlet s = ", "\"$${", 3, "1" + Repeat("}\"", 3))
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ReasonableBlockNesting_ParsesWithoutDiagnostics() {
        let tree = ParseNested(`package P
func f() {
`, "{", 100, String('}', 100) + "\n}")
        Assert.Empty(tree.Diagnostics)
    }

    shared {
        private const NestingTooDeepId string = "GS0417"

        private func Repeat(unit string, count int32) string {
            let sb = StringBuilder(unit.Length * count)
            for var i = 0; i < count; i++ {
                sb.Append(unit)
            }
            return sb.ToString()
        }

        private func ParseNested(prefix string, unit string, count int32, suffix string) SyntaxTree {
            let source = prefix + Repeat(unit, count) + suffix
            return SyntaxTree.Parse(source)
        }

        private func AssertSingleNestingTooDeep(tree SyntaxTree) {
            // The parse must terminate normally (reaching this line at all proves
            // no StackOverflowException fired), carry exactly one GS0417, and
            // yield a well-formed (minimal) root.
            Assert.Equal(1, tree.Diagnostics.Count((d Diagnostic) -> d.Id == NestingTooDeepId))
            Assert.NotNull(tree.Root)
            Assert.NotNull(tree.Root.EndOfFileToken)
        }
    }
}
