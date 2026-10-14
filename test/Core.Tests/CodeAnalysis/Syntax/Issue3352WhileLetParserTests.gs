// <copyright file="Issue3352WhileLetParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Parser coverage for issue #3352 / ADR-0163.
class Issue3352WhileLetParserTests {
    @Fact
    func ParsesSingleBinding() {
        let tree = SyntaxTree.Parse(`func Run(value string?) {
    while let text = value {
        let length = text.Length
    }
}`)
        Assert.Empty(tree.Diagnostics)
        let statement = Assert.Single(Descendants(tree.Root).OfType[WhileLetStatementSyntax]())
        let binding = Assert.Single(statement.Bindings)
        Assert.Equal(SyntaxKind.WhileKeyword, statement.WhileKeyword.Kind)
        Assert.Equal("text", binding.Identifier.Text)
        Assert.Null(binding.TypeClause)
        Assert.IsType[BlockStatementSyntax](statement.Body)
    }

    @Fact
    func ParsesMultipleBindingsAndTypeClauses() {
        let tree = SyntaxTree.Parse(`func Run(first string?, second string?) {
    while let a string = first, let b = second { }
}`)
        Assert.Empty(tree.Diagnostics)
        let statement = Assert.Single(Descendants(tree.Root).OfType[WhileLetStatementSyntax]())
        Assert.Equal(2, statement.Bindings.Count)
        Assert.NotNull(statement.Bindings[0].TypeClause)
        Assert.Equal("a", statement.Bindings[0].Identifier.Text)
        Assert.Equal("b", statement.Bindings[1].Identifier.Text)
    }

    @Fact
    func PlainAndLabeledWhileRemainUnambiguous() {
        let tree = SyntaxTree.Parse(`func Run(value string?) {
    while value != nil { break }
    retry: while let text = value { continue retry }
}`)
        Assert.Empty(tree.Diagnostics)
        Assert.Single(Descendants(tree.Root).OfType[WhileStatementSyntax]())
        let labeled = Assert.Single(Descendants(tree.Root).OfType[LabeledStatementSyntax]())
        Assert.IsType[WhileLetStatementSyntax](labeled.Statement)
    }

    @Fact
    func MissingInitializerReportsDiagnosticAndRecoversBody() {
        let tree = SyntaxTree.Parse(`func Run() {
    while let value = { }
    let after = 1
}`)
        Assert.NotEmpty(tree.Diagnostics)
        Assert.Single(Descendants(tree.Root).OfType[WhileLetStatementSyntax]())
        Assert.Contains(
            Descendants(tree.Root).OfType[VariableDeclarationSyntax](),
            (declaration VariableDeclarationSyntax) -> declaration.Identifier.Text == "after"
        )
    }

    shared {
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }
    }
}
