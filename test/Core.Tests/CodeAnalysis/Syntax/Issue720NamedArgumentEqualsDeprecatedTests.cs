// <copyright file="Issue720NamedArgumentEqualsDeprecatedTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #720 / ADR-0080 — parser-level tests for the new deprecation warning
/// emitted when a named argument uses the legacy <c>name = value</c> spelling
/// instead of the canonical <c>name: value</c>. Both spellings still parse;
/// the warning fires once per offending <c>=</c> separator.
/// </summary>
public class Issue720NamedArgumentEqualsDeprecatedTests
{
    [Fact]
    public void NamedArgument_Colon_DoesNotWarn()
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

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
        Assert.Empty(tree.Diagnostics);

        var named = FindFirst<NamedArgumentExpressionSyntax>(tree);
        Assert.Equal(SyntaxKind.ColonToken, named.EqualsToken.Kind);
        Assert.Equal("timeout", named.NameToken.Text);
    }

    [Fact]
    public void NamedArgument_Equals_StillParsesAndWarns()
    {
        const string source = """
            package P
            func Bar(timeout int32) {
            }
            func Foo() {
              Bar(timeout = 30)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var warning = Assert.Single(tree.Diagnostics.Where(d => d.Id == "GS0315"));
        Assert.False(warning.IsError);
        Assert.Contains("timeout", warning.Message);
        Assert.Contains("'='", warning.Message);
        Assert.Contains("ADR-0080", warning.Message);

        // The diagnostic must anchor at the offending `=` token itself.
        var slice = warning.Location.Text.ToString(warning.Location.Span);
        Assert.Equal("=", slice);

        var named = FindFirst<NamedArgumentExpressionSyntax>(tree);
        Assert.Equal(SyntaxKind.EqualsToken, named.EqualsToken.Kind);
        Assert.Equal("timeout", named.NameToken.Text);
    }

    [Fact]
    public void NamedArgument_Mixed_OnlyEqualsWarn()
    {
        const string source = """
            package P
            func Bar(timeout int32, retries int32) {
            }
            func Foo() {
              Bar(timeout = 30, retries: 3)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0315").ToList();
        var warning = Assert.Single(warnings);
        Assert.Contains("timeout", warning.Message);
        Assert.False(warning.IsError);

        var namedArgs = Walk(tree.Root).OfType<NamedArgumentExpressionSyntax>().ToList();
        Assert.Equal(2, namedArgs.Count);
        Assert.Equal(SyntaxKind.EqualsToken, namedArgs[0].EqualsToken.Kind);
        Assert.Equal(SyntaxKind.ColonToken, namedArgs[1].EqualsToken.Kind);
    }

    [Fact]
    public void NamedArgument_AllEquals_WarnsOncePerArgument()
    {
        const string source = """
            package P
            func Bar(timeout int32, retries int32) {
            }
            func Foo() {
              Bar(timeout = 30, retries = 3)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var warnings = tree.Diagnostics.Where(d => d.Id == "GS0315").ToList();
        Assert.Equal(2, warnings.Count);
        Assert.All(warnings, w => Assert.False(w.IsError));
        Assert.Contains(warnings, w => w.Message.Contains("timeout"));
        Assert.Contains(warnings, w => w.Message.Contains("retries"));
    }

    [Fact]
    public void AttributeArgument_Equals_Warns()
    {
        // ADR-0047 attribute argument lists go through the same
        // ParseArguments helper, so GS0315 fires uniformly.
        const string source = """
            package P
            import System

            @AttributeUsage(AttributeTargets.Method, AllowMultiple = true)
            func Foo() {
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var warning = Assert.Single(tree.Diagnostics.Where(d => d.Id == "GS0315"));
        Assert.Contains("AllowMultiple", warning.Message);
        Assert.False(warning.IsError);
    }

    [Fact]
    public void AttributeArgument_Colon_DoesNotWarn()
    {
        const string source = """
            package P
            import System

            @AttributeUsage(AttributeTargets.Method, AllowMultiple: true)
            func Foo() {
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
    }

    [Fact]
    public void CopySugar_Equals_Warns()
    {
        // ADR-0032 `.copy(field = value)` flows through ParseArguments — the
        // deprecation applies uniformly. The canonical form is `.copy(field: value)`.
        const string source = """
            package P
            data struct Point {
              var x int32
              var y int32
            }
            func Foo() {
              let p = Point{x: 1, y: 2}
              let q = p.copy(x = 10)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        var warning = Assert.Single(tree.Diagnostics.Where(d => d.Id == "GS0315"));
        Assert.Contains("x", warning.Message);
        Assert.False(warning.IsError);
    }

    [Fact]
    public void CopySugar_Colon_DoesNotWarn()
    {
        const string source = """
            package P
            data struct Point {
              var x int32
              var y int32
            }
            func Foo() {
              let p = Point{x: 1, y: 2}
              let q = p.copy(x: 10)
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
    }

    [Fact]
    public void WithExpression_FieldAssignment_DoesNotWarn()
    {
        // `with { x = 10 }` is parsed by ParseFieldEqualsInitializers, not
        // ParseArguments, so it is unaffected by ADR-0080.
        const string source = """
            package P
            data struct Point {
              var x int32
              var y int32
            }
            func Foo() {
              let p = Point{x: 1, y: 2}
              let r = p with { x = 10 }
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
    }

    [Fact]
    public void ParameterDefault_DoesNotWarn()
    {
        // Optional parameter defaults (ADR-0063) use `name type = expr` in
        // the parameter list — a separate parser path. They must not trip
        // GS0315.
        const string source = """
            package P
            func Bar(timeout int32 = 30) int32 {
              return timeout
            }
            func Foo() {
              Bar()
            }
            """;
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0315");
    }

    [Fact]
    public void Assignment_InsideArgument_DoesNotWarn()
    {
        // A plain assignment inside an argument expression (e.g. an arbitrary
        // value position) is not a named-argument separator and must not warn.
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
