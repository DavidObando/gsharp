// <copyright file="Issue3420VarPatternParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>Parser coverage for native total <c>var name</c> patterns.</summary>
public sealed class Issue3420VarPatternParserTests
{
    [Fact]
    public void VarPattern_ParsesInIsPropertyListAndSwitchPositions()
    {
        var tree = SyntaxTree.Parse(
            """
            if value is var captured { }
            if box is { Value: var member, Values: [var first, ..] } { }
            switch value {
                case var arm { }
            }
            """);

        Assert.Empty(tree.Diagnostics);
        var statements = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .ToArray();

        var topLevel = Assert.IsType<VarPatternSyntax>(
            Assert.IsType<IsExpressionSyntax>(
                Assert.IsType<IfStatementSyntax>(statements[0]).Condition).Pattern);
        Assert.Equal(SyntaxKind.VarKeyword, topLevel.VarKeyword.Kind);
        Assert.Equal("captured", topLevel.Designation.Text);

        var property = Assert.IsType<PropertyPatternSyntax>(
            Assert.IsType<IsExpressionSyntax>(
                Assert.IsType<IfStatementSyntax>(statements[1]).Condition).Pattern);
        Assert.Equal(
            "member",
            Assert.IsType<VarPatternSyntax>(property.Fields[0].Pattern).Designation.Text);
        var list = Assert.IsType<ListPatternSyntax>(property.Fields[1].Pattern);
        Assert.Equal(
            "first",
            Assert.IsType<VarPatternSyntax>(list.Elements[0]).Designation.Text);

        var switchStatement = Assert.IsType<SwitchStatementSyntax>(statements[2]);
        Assert.Equal(
            "arm",
            Assert.IsType<VarPatternSyntax>(switchStatement.Cases[0].Value).Designation.Text);
    }

    [Fact]
    public void VarDiscard_ParsesAsTotalPatternWithoutBinding()
    {
        var tree = SyntaxTree.Parse("let matched = value is var _");

        Assert.Empty(tree.Diagnostics);
        var declaration = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(member => member.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();
        var pattern = Assert.IsType<VarPatternSyntax>(
            Assert.IsType<IsExpressionSyntax>(declaration.Initializer).Pattern);
        Assert.Equal("_", pattern.Designation.Text);
    }
}
