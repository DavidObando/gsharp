// <copyright file="Issue4962IfExpressionInitializerLanguageServerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #4962: the local an if-expression's `if init; cond` initializer
/// declares gets the same hover, definition and semantic tokens as the one
/// the if-statement's initializer declares.
open class Issue4962IfExpressionInitializerLanguageServerTests {
    private const StatementSource string = `func g() int32 { return 5 }
func F() int32 {
    var r = 0
    if var v = g(); v > 3 { r = v } else { r = 0 }
    return r
}
`

    private const ExpressionSource string = `func g() int32 { return 5 }
func F() int32 {
    let r = if var v = g(); v > 3 { v } else { 0 }
    return r
}
`

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Hover_OnInitializerLocalInThenBranch_ShowsTheLocal(expressionForm bool) {
        let source = if expressionForm {
            ExpressionSource
        } else {
            StatementSource
        }
        let content = LanguageServerTestHelpers.Content(source)
        // `v } else {` starts at the use of `v` in the then-branch.
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "v } else {")
        )
        Assert.NotNull(hover)
        Assert.Contains("(local variable) v int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func Definition_OfConditionUse_PointsAtTheInitializer(expressionForm bool) {
        let source = if expressionForm {
            ExpressionSource
        } else {
            StatementSource
        }
        let content = LanguageServerTestHelpers.Content(source)
        let uri = DocumentUri.From("file:///issue4962.gs")!!
        let use = LanguageServerTestHelpers.PositionOf(source, "v > 3", 0)
        let declaration = LanguageServerTestHelpers.PositionOf(source, "v = g()", 0)
        let def Location? = DefinitionComputer.ComputeDefinition(uri, content, use)
        Assert.NotNull(def)
        Assert.Equal(declaration.Line, def!!.Range.Start.Line)
        Assert.Equal(declaration.Character, def!!.Range.Start.Character)
    }

    @Fact
    func SemanticTokens_ClassifyTheInitializerLocalTheSameInBothForms() {
        let statement = ClassifyAt(StatementSource, "v = g()", "v > 3")
        let expression = ClassifyAt(ExpressionSource, "v = g()", "v > 3")
        Assert.Equal(statement, expression)
        Assert.NotNull(expression.Declaration)
        Assert.NotNull(expression.Use)
    }

    shared {
        private func ClassifyAt(source string, declarationText string, useText string)(
            Declaration(int32, int32)?,
            Use(int32, int32)?
        ) {
            let content = LanguageServerTestHelpers.Content(source)
            let document = SemanticTokensDocument(SemanticTokensHandler.Legend)
            let builder = document.Create()
            SemanticTokensComputer.Tokenize(builder, content)
            builder.Commit()
            let data = document.GetSemanticTokens().Data
            let declaration = LanguageServerTestHelpers.PositionOf(source, declarationText, 0)
            let use = LanguageServerTestHelpers.PositionOf(source, useText, 0)
            var declarationToken(int32, int32)? = nil
            var useToken(int32, int32)? = nil
            var line = 0
            var character = 0
            for var i = 0; i + 4 < data.Length; i += 5 {
                if data[i] > 0 {
                    line += data[i]
                    character = data[i + 1]
                } else {
                    character += data[i + 1]
                }
                if data[i + 2] != 1 {
                    continue
                }
                if line == declaration.Line && character == declaration.Character {
                    declarationToken = (data[i + 3], data[i + 4])
                }
                if line == use.Line && character == use.Character {
                    useToken = (data[i + 3], data[i + 4])
                }
            }
            return (declarationToken, useToken)
        }
    }
}
