// <copyright file="Issue3420VarPatternParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Parser coverage for native total `var name` patterns.
class Issue3420VarPatternParserTests {
    @Fact
    func VarPattern_ParsesInIsPropertyListAndSwitchPositions() {
        let tree = SyntaxTree.Parse(`if value is var captured { }
if box is { Value: var member, Values: [var first, ..] } { }
switch value {
    case var arm { }
}`)
        Assert.Empty(tree.Diagnostics)
        let statements = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .ToArray()
        let topLevel = Assert.IsType[VarPatternSyntax](
            Assert.IsType[IsExpressionSyntax](Assert.IsType[IfStatementSyntax](statements[0]).Condition).Pattern
        )
        Assert.Equal(SyntaxKind.VarKeyword, topLevel.VarKeyword.Kind)
        Assert.Equal("captured", topLevel.Designation.Text)
        let property = Assert.IsType[PropertyPatternSyntax](
            Assert.IsType[IsExpressionSyntax](Assert.IsType[IfStatementSyntax](statements[1]).Condition).Pattern
        )
        Assert.Equal("member", Assert.IsType[VarPatternSyntax](property.Fields[0].Pattern).Designation.Text)
        let list = Assert.IsType[ListPatternSyntax](property.Fields[1].Pattern)
        Assert.Equal("first", Assert.IsType[VarPatternSyntax](list.Elements[0]).Designation.Text)
        let switchStatement = Assert.IsType[SwitchStatementSyntax](statements[2])
        Assert.Equal("arm", Assert.IsType[VarPatternSyntax](switchStatement.Cases[0].Value).Designation.Text)
    }

    @Fact
    func VarDiscard_ParsesAsTotalPatternWithoutBinding() {
        let tree = SyntaxTree.Parse("let matched = value is var _")
        Assert.Empty(tree.Diagnostics)
        let declaration = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((member GlobalStatementSyntax) -> member.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let pattern = Assert.IsType[VarPatternSyntax](
            Assert.IsType[IsExpressionSyntax](declaration.Initializer).Pattern
        )
        Assert.Equal("_", pattern.Designation.Text)
    }
}
