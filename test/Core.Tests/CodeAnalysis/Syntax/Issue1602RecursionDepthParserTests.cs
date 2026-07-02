// <copyright file="Issue1602RecursionDepthParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1602: the recursive-descent parser (and the lexer's
/// interpolation-hole scanner) enforce a recursion-depth limit so that deeply
/// nested input — well-formed or truncated — produces a clean GS0417
/// diagnostic instead of an uncatchable <see cref="System.StackOverflowException"/>
/// that kills the whole process. IDEs feed the parser unbalanced text on every
/// keystroke (`a[a[a[…` is exactly what an editor buffer looks like mid-edit),
/// so every repro here is exercised at depths well past the limit. Mirrors
/// Roslyn's CS8078 / ParseWithStackGuard behaviour: past the limit the parse
/// is abandoned wholesale and a minimal compilation unit is returned, so the
/// binder never sees an unboundedly deep tree either.
/// </summary>
public class Issue1602RecursionDepthParserTests
{
    private const string NestingTooDeepId = "GS0417";

    [Fact]
    public void DeepUnbalancedIndexNesting_IssueRepro_ReportsGS0417()
    {
        // The exact issue #1602 repro: `let x = a[a[a[…` with 2,000
        // repetitions (a ~2 KB file) used to kill the process (exit 134).
        var tree = ParseNested("package P\nlet x = ", "a[", 2_000, string.Empty);
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepUnbalancedIndexNesting_WellPastTheLimit_ReportsGS0417()
    {
        var tree = ParseNested("package P\nlet x = ", "a[", 20_000, string.Empty);
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepWellFormedParenthesizedExpression_ReportsGS0417()
    {
        var tree = ParseNested("package P\nlet x = ", "(", 20_000, "1" + new string(')', 20_000));
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepTruncatedParenthesizedExpression_ReportsGS0417()
    {
        var tree = ParseNested("package P\nlet x = ", "(", 20_000, string.Empty);
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepUnaryOperatorChain_ReportsGS0417()
    {
        // Alternating `-+` avoids the lexer fusing `--`/`++` so every token is
        // a plain prefix unary operator recursing through the binary layer.
        var tree = ParseNested("package P\nlet x = ", "-+", 10_000, "1");
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepPrefixDecrementChain_ReportsGS0417()
    {
        // A raw `-` run lexes as fused `--` prefix decrement tokens; each one
        // still recurses once per operator and must be bounded too.
        var tree = ParseNested("package P\nlet x = ", "-", 20_000, "1");
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepAssignmentChain_ReportsGS0417()
    {
        // `a = a = a = …` self-recurses through the assignment right-hand
        // side without re-entering ParseExpression.
        var tree = ParseNested("package P\nfunc f() {\n", "a = ", 20_000, "1\n}");
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepNullCoalescingChain_ReportsGS0417()
    {
        // `a ?? a ?? …` self-recurses through the right-associative `??` tail.
        var tree = ParseNested("package P\nlet x = ", "a ?? ", 20_000, "a");
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepWellFormedGenericTypeNesting_ReportsGS0417()
    {
        var tree = ParseNested("package P\nlet x = default(", "List[", 20_000, "int32" + new string(']', 20_000) + ")");
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepTruncatedGenericTypeNesting_ReportsGS0417()
    {
        var tree = ParseNested("package P\nlet x = default(", "List[", 20_000, string.Empty);
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepNestedBlockStatements_ReportsGS0417()
    {
        var tree = ParseNested("package P\nfunc f() {\n", "{", 20_000, string.Empty);
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepNestedClassDeclarations_ReportsGS0417()
    {
        var tree = ParseNested("package P\n", "class A {\n", 5_000, string.Empty);
        AssertSingleNestingTooDeep(tree);
    }

    [Fact]
    public void DeepWellFormedInterpolationNesting_ReportsGS0417()
    {
        // `"${"${"${…1…}"}"}"` — the lexer's ScanInterpolationHole ↔
        // SkipInterpolationNestedLiteral mutual recursion is bounded too.
        var tree = ParseNested("package P\nlet s = ", "\"${", 20_000, "1" + Repeat("}\"", 20_000));
        Assert.Contains(tree.Diagnostics, d => d.Id == NestingTooDeepId);
        Assert.NotNull(tree.Root);
    }

    [Fact]
    public void DeepTruncatedInterpolationNesting_ReportsGS0417()
    {
        var tree = ParseNested("package P\nlet s = ", "\"${", 20_000, string.Empty);
        Assert.Contains(tree.Diagnostics, d => d.Id == NestingTooDeepId);
        Assert.NotNull(tree.Root);
    }

    [Fact]
    public void ReasonableParenthesisNesting_ParsesWithoutDiagnostics()
    {
        // A reasonable-depth program must stay untouched by the guard.
        var tree = ParseNested("package P\nlet x = ", "(", 100, "1" + new string(')', 100));
        Assert.Empty(tree.Diagnostics);
        var statement = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        Assert.NotNull(statement.Initializer);
    }

    [Fact]
    public void ReasonableIndexNesting_ParsesWithoutDiagnostics()
    {
        var tree = ParseNested("package P\nlet x = ", "a[", 50, "1" + new string(']', 50));
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ReasonableUnaryChain_ParsesWithoutDiagnostics()
    {
        var tree = ParseNested("package P\nlet x = ", "-+", 50, "1");
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ReasonableTypeNesting_ParsesWithoutDiagnostics()
    {
        var tree = ParseNested("package P\nlet x = default(", "List[", 50, "int32" + new string(']', 50) + ")");
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ReasonableInterpolationNesting_ParsesWithoutDiagnostics()
    {
        var tree = ParseNested("package P\nlet s = ", "\"${", 3, "1" + Repeat("}\"", 3));
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ReasonableBlockNesting_ParsesWithoutDiagnostics()
    {
        var tree = ParseNested("package P\nfunc f() {\n", "{", 100, new string('}', 100) + "\n}");
        Assert.Empty(tree.Diagnostics);
    }

    private static string Repeat(string unit, int count)
    {
        var sb = new StringBuilder(unit.Length * count);
        for (var i = 0; i < count; i++)
        {
            sb.Append(unit);
        }

        return sb.ToString();
    }

    private static SyntaxTree ParseNested(string prefix, string unit, int count, string suffix)
    {
        var source = prefix + Repeat(unit, count) + suffix;
        return SyntaxTree.Parse(source);
    }

    private static void AssertSingleNestingTooDeep(SyntaxTree tree)
    {
        // The parse must terminate normally (reaching this line at all proves
        // no StackOverflowException fired), carry exactly one GS0417, and
        // yield a well-formed (minimal) root.
        Assert.Equal(1, tree.Diagnostics.Count(d => d.Id == NestingTooDeepId));
        Assert.NotNull(tree.Root);
        Assert.NotNull(tree.Root.EndOfFileToken);
    }
}
