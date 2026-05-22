// <copyright file="CompoundAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 2.1: compound assignment operators (<c>+=</c>, <c>-=</c>, <c>*=</c>,
/// <c>/=</c>, <c>%=</c>, <c>^=</c>, <c>&amp;=</c>, <c>|=</c>, <c>&amp;^=</c>,
/// <c>&lt;&lt;=</c>, <c>&gt;&gt;=</c>) desugar in the parser to <c>x = x op rhs</c>,
/// so the binder, lowerer, interpreter, and emitter need no per-operator changes.
/// </summary>
public class CompoundAssignmentTests
{
    [Theory]
    [InlineData("+=")]
    [InlineData("-=")]
    [InlineData("*=")]
    [InlineData("/=")]
    [InlineData("%=")]
    [InlineData("^=")]
    [InlineData("&=")]
    [InlineData("|=")]
    [InlineData("&^=")]
    [InlineData("<<=")]
    [InlineData(">>=")]
    public void CompoundAssignment_OnIntVariable_Binds(string op)
    {
        var src = $"func F() {{\n var x = 4\n x {op} 1\n }}\n";
        var diagnostics = Bind(src);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void CompoundAssignment_On_ReadOnly_Reports_Error()
    {
        var diagnostics = Bind("func F() {\n let x = 1\n x += 1\n }\n");
        Assert.Contains(
            diagnostics,
            d => d.Message.Contains("read-only", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void CompoundAssignment_Desugars_To_AssignmentOfBinary()
    {
        var tree = SyntaxTree.Parse(SourceText.From("func F() {\n var x = 1\n x += 2\n }\n"));
        Assert.Empty(tree.Diagnostics);

        // Find the assignment expression inside the function body.
        var assignment = Find<AssignmentExpressionSyntax>(tree.Root);
        Assert.NotNull(assignment);
        Assert.Equal(SyntaxKind.EqualsToken, assignment.EqualsToken.Kind);
        var binary = Assert.IsType<BinaryExpressionSyntax>(assignment.Expression);
        Assert.Equal(SyntaxKind.PlusToken, binary.OperatorToken.Kind);
        var leftName = Assert.IsType<NameExpressionSyntax>(binary.Left);
        Assert.Equal(assignment.IdentifierToken.Text, leftName.IdentifierToken.Text);
    }

    private static T Find<T>(SyntaxNode node)
        where T : SyntaxNode
    {
        if (node is T match)
        {
            return match;
        }

        foreach (var child in node.GetChildren())
        {
            var hit = Find<T>(child);
            if (hit != null)
            {
                return hit;
            }
        }

        return null;
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
