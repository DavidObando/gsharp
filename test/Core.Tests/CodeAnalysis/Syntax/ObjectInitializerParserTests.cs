// <copyright file="ObjectInitializerParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #522: parser tests for the C#-style object-initializer suffix
/// (<c>T(args) { Prop = value, … }</c>). Confirms that the new grammar is
/// recognised in expression positions without regressing the existing
/// body-header parsers (if/for/while/switch braces remain statement bodies).
/// </summary>
public class ObjectInitializerParserTests
{
    [Fact]
    public void Parses_EmptyInitializerList()
    {
        const string source = "package P\nfunc Main() {\n  var w = WithInit() { }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Parses_SinglePropertyInitializer()
    {
        const string source = "package P\nfunc Main() {\n  var w = WithInit() { Asin = \"X\" }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Parses_MultiplePropertyInitializers()
    {
        const string source = "package P\nfunc Main() {\n  var w = WithInit() { Asin = \"X\", Title = \"T\" }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Parses_TrailingComma()
    {
        // Trailing comma is allowed for consistency with argument lists,
        // tuple literals, struct literals, and array initializers.
        const string source = "package P\nfunc Main() {\n  var w = WithInit() { Asin = \"X\", Title = \"T\", }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Parses_NestedObjectInitializer()
    {
        const string source = "package P\nfunc Main() {\n  var w = Outer() { Inner = Inner() { X = 1 } }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Parses_WithIntegerProperty()
    {
        const string source = "package P\nfunc Main() {\n  var w = Box() { Value = 1 }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void DoesNotEat_IfStatementBody()
    {
        // The body-header suppression flag keeps `if Cond() { … }` parsing as
        // a regular `if` with a body block, even though the body's first
        // statement is `Identifier = expr` (the shape that would otherwise
        // be mis-eaten as an object initializer).
        const string source = "package P\nfunc Main() {\n  var x = 0\n  if Cond() {\n    x = 1\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void DoesNotEat_ForRangeStatementBody()
    {
        const string source = "package P\nfunc Main() {\n  var total = 0\n  for v := range Items() {\n    total = total + v\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void DoesNotEat_ForConditionStatementBody()
    {
        const string source = "package P\nfunc Main() {\n  var x = 0\n  for Cond() {\n    x = x + 1\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void DoesNotEat_SwitchStatementBody()
    {
        const string source = "package P\nfunc Main() {\n  var x = 0\n  switch Cond() {\n  default {\n    x = 1\n  }\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void AllowsObjectInitializer_InsideArgumentInBodyHeader()
    {
        // Even though `if Cond() { … }` suppresses the trailing initializer
        // at the body-header level, the inner call argument is a fresh
        // expression context that re-allows initializers.
        const string source = "package P\nfunc Main() {\n  if Process(Build() { X = 1 }) {\n    Noop()\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void AllowsObjectInitializer_InsideParensInBodyHeader()
    {
        const string source = "package P\nfunc Main() {\n  if (Build() { X = 1 }) != nil {\n    Noop()\n  }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ProducesObjectCreationExpression_NodeKind()
    {
        const string source = "package P\nfunc Main() {\n  var w = WithInit() { Asin = \"X\" }\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var objectCreation = FindFirst<ObjectCreationExpressionSyntax>(tree.Root);
        Assert.NotNull(objectCreation);
        Assert.Equal(SyntaxKind.ObjectCreationExpression, objectCreation.Kind);
        var init = objectCreation.Initializers.Single();
        Assert.Equal("Asin", init.PropertyIdentifier.Text);
        Assert.Equal(SyntaxKind.EqualsToken, init.EqualsToken.Kind);
    }

    private static T FindFirst<T>(SyntaxNode root)
        where T : SyntaxNode
    {
        if (root is T match)
        {
            return match;
        }

        foreach (var child in root.GetChildren())
        {
            var found = FindFirst<T>(child);
            if (found != null)
            {
                return found;
            }
        }

        return null;
    }
}
