// <copyright file="Adr0161NamedArgumentEqualsRetiredTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0161 — the legacy <c>name = value</c> named-argument spelling, deprecated
/// by ADR-0080 with the one-release <c>GS0315</c> warning, is retired. <c>=</c>
/// after an identifier in argument position is no longer a separator: it parses
/// as an ordinary assignment expression, exactly as <c>=</c> does in every other
/// expression position.
/// <para>
/// Supersedes <c>Issue720NamedArgumentEqualsDeprecatedTests</c>, which asserted
/// the grace-period behaviour.
/// </para>
/// <para>
/// The transitional risk is that <c>f(name = value)</c> was a named argument and
/// is now an assignment. Where the target is not in scope that is a loud binder
/// error; where it IS in scope and also names a parameter, the two readings
/// differ silently — so a bare assignment argument carries <c>GS0524</c>.
/// Parenthesising states the intent and silences it.
/// </para>
/// </summary>
public class Adr0161NamedArgumentEqualsRetiredTests
{
    [Fact]
    public void CanonicalColonForm_StillParses_AndDoesNotWarn()
    {
        const string source = """
            package P
            func Bar(timeout int32) {
            }
            func Foo() {
              Bar(timeout: 30)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);

        var named = FindFirst<NamedArgumentExpressionSyntax>(tree);
        Assert.Equal(SyntaxKind.ColonToken, named.EqualsToken.Kind);
        Assert.Equal("timeout", named.NameToken.Text);
    }

    [Fact]
    public void EqualsForm_IsNoLongerANamedArgument()
    {
        const string source = """
            package P
            func Bar(timeout int32) {
            }
            func Foo() {
              var timeout = 0
              Bar(timeout = 30)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        // The retired separator must not produce a named argument any more.
        Assert.Empty(Walk(tree.Root).OfType<NamedArgumentExpressionSyntax>());
        Assert.NotEmpty(Walk(tree.Root).OfType<AssignmentExpressionSyntax>());
    }

    [Fact]
    public void BareAssignmentArgument_Warns_GS0524()
    {
        const string source = """
            package P
            func Bar(timeout int32) {
            }
            func Foo() {
              var timeout = 0
              Bar(timeout = 30)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var warning = Assert.Single(tree.Diagnostics.Where(d => d.Id == "GS0524"));
        Assert.Contains("timeout", warning.Message);
        Assert.Contains("timeout: value", warning.Message);
        Assert.Contains("(timeout = value)", warning.Message);
    }

    /// <summary>
    /// Parenthesising states assignment intent unambiguously and is the spelling
    /// cs2gs emits, so it must stay warning-free.
    /// </summary>
    [Fact]
    public void ParenthesisedAssignmentArgument_DoesNotWarn()
    {
        const string source = """
            package P
            func Bar(x int32) int32 {
              return x
            }
            func Foo() {
              var x = 0
              Bar((x = 5))
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0524");
    }

    [Fact]
    public void GS0315_IsRetired_AndNeverEmitted()
    {
        const string source = """
            package P
            func Bar(timeout int32) {
            }
            func Foo() {
              var timeout = 0
              Bar(timeout = 30)
              Bar(timeout: 30)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
    }

    /// <summary>
    /// ADR-0161's motivating case: a value-position assignment as an argument is
    /// now expressible, which is what lets cs2gs stop spilling it into a
    /// synthetic temp (#3347 spill sites C1/C2/C3).
    /// </summary>
    [Fact]
    public void AssignmentArgument_ParsesAsAnExpression()
    {
        const string source = """
            package P
            func Bar(x int32) int32 {
              return x
            }
            func Foo() {
              var x = 0
              Bar((x = 5))
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        Assert.NotEmpty(Walk(tree.Root).OfType<AssignmentExpressionSyntax>());
    }

    /// <summary>
    /// Out-of-scope carve-outs from ADR-0080 that must remain unaffected: a
    /// <c>with</c>-expression field initializer and a parameter default both use
    /// <c>=</c> through separate parser paths.
    /// </summary>
    [Fact]
    public void WithExpressionAndParameterDefault_AreUnaffected()
    {
        const string source = """
            package P
            data struct Point {
              var X int32
              var Y int32
            }
            func Shift(p Point) Point {
              return p with { X = 10 }
            }
            func Defaulted(x int32 = 0) int32 {
              return x
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0524");
        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
    }

    private static T FindFirst<T>(SyntaxTree tree)
        where T : SyntaxNode
    {
        return Walk(tree.Root).OfType<T>().First();
    }

    private static IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (var c in node.GetChildren())
        {
            if (c is SyntaxNode sn)
            {
                foreach (var d in Walk(sn))
                {
                    yield return d;
                }
            }
        }
    }
}
