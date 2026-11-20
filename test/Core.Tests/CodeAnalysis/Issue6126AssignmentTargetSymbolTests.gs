// <copyright file="Issue6126AssignmentTargetSymbolTests.gs" company="GSharp">
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

/// Issue #6126: (cref:SemanticModel.GetSymbolInfo) on an assignment answers the variable, field or
/// property it writes, never the receiver of the write (the implicit `this` of `N = 2`, or `c`
/// of `c.N = 2`).
open class Issue6126AssignmentTargetSymbolTests {
    @Fact
    func BareFieldAssignment_AnswersTheField() {
        let (model, tree) = CreateModel(Source)
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(Statement(tree, "N = 2")).Symbol)
        Assert.Equal("N", field.Name)
    }

    @Fact
    func CompoundBareFieldAssignment_AnswersTheField() {
        let (model, tree) = CreateModel(Source)
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(Statement(tree, "N += 1")).Symbol)
        Assert.Equal("N", field.Name)
    }

    @Fact
    func ThisQualifiedFieldAssignment_AnswersTheField() {
        let (model, tree) = CreateModel(Source)
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(Statement(tree, "this.N = 3")).Symbol)
        Assert.Equal("N", field.Name)
    }

    @Fact
    func FieldAssignmentThroughAVariable_AnswersTheField() {
        let (model, tree) = CreateModel(Source)
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(Statement(tree, "c.N = 5")).Symbol)
        Assert.Equal("N", field.Name)
    }

    @Fact
    func SharedFieldAssignment_AnswersTheField() {
        let (model, tree) = CreateModel(Source)
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(Statement(tree, "S = 6")).Symbol)
        Assert.Equal("S", field.Name)
        Assert.True(field.IsStatic)
    }

    @Fact
    func BarePropertyAssignment_AnswersTheProperty() {
        let (model, tree) = CreateModel(Source)
        let property = Assert.IsType[PropertySymbol](model.GetSymbolInfo(Statement(tree, "P = 4")).Symbol)
        Assert.Equal("P", property.Name)
    }

    @Theory
    @InlineData("this.P = 7")
    @InlineData("c.P = 8")
    func QualifiedPropertyAssignment_AnswersTheProperty(statement string) {
        let (model, tree) = CreateModel(Source)
        let property = Assert.IsType[PropertySymbol](model.GetSymbolInfo(Statement(tree, statement)).Symbol)
        Assert.Equal("P", property.Name)
    }

    @Theory
    @InlineData("N = 2", "N", "FieldSymbol")
    @InlineData("x = 2", "x", "LocalVariableSymbol")
    @InlineData("this.N = 3", "N", "FieldSymbol")
    @InlineData("this.N = 3", "this", "ParameterSymbol")
    @InlineData("c.N = 5", "N", "FieldSymbol")
    @InlineData("c.N = 5", "c", "ParameterSymbol")
    @InlineData("c.P = 8", "P", "PropertySymbol")
    @InlineData("c.P = 8", "c", "ParameterSymbol")
    func AssignmentTokens_AnswerTheTargetAndTheReceiver(statement string, token string, kind string) {
        let (model, tree) = CreateModel(Source)
        let target = Statement(tree, statement)
        let identifier = tree.Root.FindToken(target.Span.Start + statement.IndexOf(token, StringComparison.Ordinal))
        Assert.NotNull(identifier)
        Assert.Equal(token, identifier!!.Text)
        let symbol = model.GetSymbolInfo(identifier!!).Symbol
        Assert.NotNull(symbol)
        Assert.Equal(kind, symbol!!.GetType().Name)
        Assert.Equal(token, symbol!!.Name)
    }

    @Fact
    func SharedAutoPropertyAssignment_AnswersTheProperty() {
        let (model, tree) = CreateModel(Source)
        let property = Assert.IsType[PropertySymbol](model.GetSymbolInfo(Statement(tree, "Q = 9")).Symbol)
        Assert.Equal("Q", property.Name)
        Assert.True(property.IsStatic)
    }

    @Fact
    func ImportedPropertyWriteThroughAVariable_TokenAnswersTheProperty() {
        let tree = SyntaxTree.Parse(
            SourceText.From(
                "package P\n\nimport System.Text\n\nfunc F(b StringBuilder) {\n    b.Length = 1\n}\n",
                "imported.gs"
            )
        )
        let compilation = Compilation(tree)
        Assert.Empty(compilation.GetDiagnostics())
        let model = compilation.GetSemanticModel(tree)
        let write = tree.Root.DescendantNodes().OfType[FieldAssignmentExpressionSyntax]().Single()
        let property = Assert.IsAssignableFrom[PropertySymbol](model.GetSymbolInfo(write.FieldIdentifier).Symbol)
        Assert.Equal("Length", property.Name)
    }

    @Fact
    func LocalAssignment_StillAnswersTheLocal() {
        let (model, tree) = CreateModel(Source)
        let local = Assert.IsType[LocalVariableSymbol](model.GetSymbolInfo(Statement(tree, "x = 2")).Symbol)
        Assert.Equal("x", local.Name)
    }

    @Fact
    func BareFieldAssignment_OfAFieldInAnotherFile_AnswersTheField() {
        let a = SyntaxTree.Parse(SourceText.From("package P\n\npartial class C {\n    let N int32 = 1\n}\n", "a.gs"))
        let b = SyntaxTree.Parse(
            SourceText.From("package P\n\npartial class C {\n    func Set() {\n        N = 2\n    }\n}\n", "b.gs")
        )
        let compilation = Compilation(a, b)
        let model = compilation.GetSemanticModel(b)
        let assignment = b.Root.DescendantNodes().OfType[AssignmentExpressionSyntax]().Single()
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(assignment).Symbol)
        Assert.Equal("N", field.Name)
        Assert.Same(a, Assert.Single(field.DeclaringSyntaxNodes).SyntaxTree)
    }

    shared {
        private const Source string = `package P

class C {
    var N int32 = 1
    prop P int32 { get; set; }
    shared {
        var S int32 = 0
        prop Q int32 { get; set; }
    }

    func Set() {
        N = 2
        N += 1
        this.N = 3
        P = 4
        S = 6
        Q = 9
        this.P = 7
        var x = 1
        x = 2
    }
}

func G(c C) int32 {
    c.N = 5
    c.P = 8
    return c.N
}
`

        private func CreateModel(source string)(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6126.gs"))
            let compilation = Compilation(tree)
            Assert.Empty(compilation.GetDiagnostics())
            return (compilation.GetSemanticModel(tree), tree)
        }

        /// The expression of the statement whose text is [`text`](paramref).
        private func Statement(tree SyntaxTree, text string) ExpressionSyntax {
            return tree
                .Root
                .DescendantNodes()
                .OfType[ExpressionStatementSyntax]()
                .Single((s ExpressionStatementSyntax) -> tree.Text.ToString(s.Span).Trim() == text)
                .Expression
        }
    }
}
