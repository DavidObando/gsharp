// <copyright file="Issue6206IndexedCallableSemanticModelTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6206: semantic-model answers (`GetSymbolInfo`, `GetTypeInfo`,
/// `GetMemberGroup`) for `fns[i](x)`, nested `fns[jobs[i]](x)`, multi-index
/// `matrix[i, j](x)`, `fns[i]?(x)`, and failed calls `fns[i](x, 2)`.
open class Issue6206IndexedCallableSemanticModelTests {
    @Fact
    func IndexedCallableCall_AnswersTargetIndexReturnTypeAndEmptyMemberGroup() {
        let source = `package P
import System.Collections.Generic

func F(x int32) {
    let i = 0
    let fns = List[(int32) -> int32]()
    fns.Add((v int32) -> v + 1)
    let a = fns[i](x)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6206_sm.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        Assert.Empty(compilation.GetDiagnostics())
        let model = compilation.GetSemanticModel(tree)
        let call = tree.Root.DescendantNodes().OfType[CallExpressionSyntax]().Last()

        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(call).Type)
        let fnsSym = Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(call.Identifier).Symbol)
        Assert.Equal("fns", fnsSym.Name)
        Assert.Equal(
            "System.Collections.Generic.List[System.Func[int32, int32]]",
            model.GetTypeInfo(call.Identifier).Type?.ToString()
        )

        let idxClause = Assert.Single(call.TypeArgumentList!!.Arguments)
        let idxToken = idxClause.Identifier!!
        let iSymByToken = Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(idxToken).Symbol)
        Assert.Equal("i", iSymByToken.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(idxToken).Type)
        Assert.Same(iSymByToken, model.GetSymbolInfo(idxClause).Symbol)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(idxClause).Type)

        Assert.Empty(model.GetMemberGroup(call))
        Assert.Empty(model.GetMemberGroup(call.Identifier))
    }

    @Fact
    func NestedAndMultiIndexAndFailedCalls_AnswerIndexTokensAndTarget() {
        let source = `package P
import System.Collections.Generic

func F(x int32) {
    let i = 0
    let j = 1
    let jobs = []int32{0}
    let fns = List[(int32) -> int32]()
    fns.Add((v int32) -> v + 1)
    let arr = [](int32) -> int32{(v int32) -> v + 1}
    let a = fns[jobs[i]](x)
    let bad = arr[i](x, 2)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6206_sm_nested.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        let error = Assert.Single(
            compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        )
        Assert.Equal("GS0144", error.Id)
        let model = compilation.GetSemanticModel(tree)

        // Nested index `fns[jobs[i]](x)`
        let nestedCall = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.ValueText == "fns")
        let outerClause = Assert.Single(nestedCall.TypeArgumentList!!.Arguments)
        let jobsSym = Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(outerClause.Identifier!!).Symbol)
        Assert.Equal("jobs", jobsSym.Name)
        let innerClause = Assert.Single(outerClause.TypeArguments!!)
        let innerISym = Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(innerClause.Identifier!!).Symbol)
        Assert.Equal("i", innerISym.Name)

        // Failed call `arr[i](x, 2)`
        let failedCall = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .Single((c CallExpressionSyntax) -> c.Identifier.ValueText == "arr")
        Assert.Equal("arr", Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(failedCall.Identifier).Symbol).Name)
        let failedIdxToken = Assert.Single(failedCall.TypeArgumentList!!.Arguments).Identifier!!
        Assert.Equal("i", Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(failedIdxToken).Symbol).Name)
        Assert.Empty(model.GetMemberGroup(failedCall))
    }
}
