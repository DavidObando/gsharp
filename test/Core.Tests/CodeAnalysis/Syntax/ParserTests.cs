// <copyright file="ParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class ParserTests
{
    [Fact]
    public void Parses_HelloWorld_Sample_Without_Diagnostics()
    {
        const string source = @"
package HelloWorld

import System

Console.WriteLine(""Hello, world!"")
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.NotNull(tree.Root);
        var pkg = tree.Root.Members.OfType<PackageSyntax>().Single();
        Assert.Equal("HelloWorld", pkg.Identifiers.Single().Text);
    }

    [Fact]
    public void Parses_Function_Declaration()
    {
        const string source = @"
package P

func Main() {
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.Equal("Main", fn.Identifier.Text);
    }

    [Fact]
    public void Reports_Diagnostic_On_Missing_Brace()
    {
        const string source = @"
package P

func Main() {
";
        var tree = SyntaxTree.Parse(source);
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void Tolerates_Missing_Package()
    {
        const string source = "func Main() {}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.NotNull(tree.Root);
    }

    [Fact]
    public void Parses_Switch_Expression()
    {
        const string source = @"
let v = 1
let x = switch v { case 1 -> ""a"" default -> ""b"" }
";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(m => m.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single(v => v.Identifier.Text == "x");
        var expression = Assert.IsType<SwitchExpressionSyntax>(declaration.Initializer);
        Assert.Equal(2, expression.Arms.Length);
        Assert.Equal(SyntaxKind.RightArrowToken, expression.Arms[0].ArrowToken.Kind);
        Assert.True(expression.Arms[1].IsDefault);
    }

    [Fact]
    public void Parses_MemberAccess_On_Parenthesized_Expression()
    {
        var expression = ParseExpressionStatement("(a + b).GetType()\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
        Assert.False(accessor.IsNullConditional);
    }

    [Fact]
    public void Parses_MemberAccess_On_String_Literal()
    {
        var expression = ParseExpressionStatement("\"s\".Length\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<LiteralExpressionSyntax>(accessor.LeftPart);
        var member = Assert.IsType<NameExpressionSyntax>(accessor.RightPart);
        Assert.Equal("Length", member.IdentifierToken.Text);
    }

    [Fact]
    public void Parses_Index_On_Parenthesized_Expression()
    {
        var expression = ParseExpressionStatement("(a + b)[0]\n");

        var index = Assert.IsType<IndexExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(index.Target);
    }

    [Fact]
    public void Parses_NullConditional_On_Parenthesized_Expression()
    {
        var expression = ParseExpressionStatement("(a + b)?.x\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(accessor.LeftPart);
        Assert.True(accessor.IsNullConditional);
    }

    [Fact]
    public void Parses_MemberAccess_On_Switch_Expression()
    {
        const string source = "let r = switch v { case 1 -> \"a\" default -> \"b\" }.ToString()\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(m => m.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single(v => v.Identifier.Text == "r");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(declaration.Initializer);
        Assert.IsType<SwitchExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
    }

    [Fact]
    public void NumericLiteral_MemberAccess_Is_Not_Supported()
    {
        // Numeric literals are carved out of postfix chaining because `42.x`
        // collides with float-literal lexing; users must write `(42).x`.
        var tree = SyntaxTree.Parse("let x = 42.GetType()\n");
        Assert.NotEmpty(tree.Diagnostics);
    }

    [Fact]
    public void Parenthesized_NumericLiteral_MemberAccess_Is_Supported()
    {
        var expression = ParseExpressionStatement("(42).GetType()\n");

        var accessor = Assert.IsType<AccessorExpressionSyntax>(expression);
        Assert.IsType<ParenthesizedExpressionSyntax>(accessor.LeftPart);
        Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
    }

    private static ExpressionSyntax ParseExpressionStatement(string source)
    {
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var statement = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(m => m.Statement)
            .OfType<ExpressionStatementSyntax>()
            .First();
        return statement.Expression;
    }
}
