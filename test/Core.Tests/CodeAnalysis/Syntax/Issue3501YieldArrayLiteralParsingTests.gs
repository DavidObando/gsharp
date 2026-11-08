// <copyright file="Issue3501YieldArrayLiteralParsingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501 / #4872: `yield` is a reserved keyword (`SyntaxKind.YieldKeyword`),
/// so array literals, sized arrays, parenthesized expressions, and postfix
/// continuations after `yield` parse unambiguously as `YieldStatementSyntax`.
open class Issue3501YieldArrayLiteralParsingTests {
    @Fact
    func YieldArrayLiteral_ParsesAsYieldStatement() {
        let source = `
func G() sequence[[]int32] {
    yield []int32{1, 2}
    yield []int32{3}
}

var total = 0
for xs in G() {
    for x in xs {
        total = total + x
    }
}
total
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(6, result.Value)
    }

    @Fact
    func YieldAsIdentifier_ReportsDiagnostic_WhileEscapedYieldWorks() {
        let unescaped = SyntaxTree.Parse(`
let yield = []int32{7, 8}
yield[1]
`)
        Assert.NotEmpty(unescaped.Diagnostics)

        let escaped = `
let $yield = []int32{7, 8}
$yield[1]
`
        let result = EmittedOracle.Evaluate(escaped)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(8, result.Value)
    }

    @Theory
    @InlineData("yield (x) + y")
    @InlineData("yield (x).Foo()")
    @InlineData("yield (x)[i]")
    @InlineData("yield [3]int32{1, 2, 3}")
    func PreviouslyAmbiguousStatementStartForms_ParseAsYieldStatement(statementText string) {
        let tree = SyntaxTree.Parse("func G() sequence[int32] {\n    " + statementText + "\n}\n")
        Assert.Empty(tree.Diagnostics)
        let fn = Assert.Single(tree.Root.Members.OfType[FunctionDeclarationSyntax]())
        let body = Assert.IsType[BlockStatementSyntax](fn.Body)
        let yieldStmt = Assert.IsType[YieldStatementSyntax](Assert.Single(body.Statements))
        Assert.Equal(SyntaxKind.YieldKeyword, yieldStmt.YieldKeyword.Kind)
        Assert.NotNull(yieldStmt.Expression)
    }
}
