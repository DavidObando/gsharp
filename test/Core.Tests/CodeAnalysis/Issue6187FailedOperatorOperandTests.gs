// <copyright file="Issue6187FailedOperatorOperandTests.gs" company="GSharp">
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

/// Issue #6187: the operands of an operator expression that fails to bind keep their symbol and
/// type in the semantic model when they bound, whatever the error. The diagnostics do not change.
open class Issue6187FailedOperatorOperandTests {
    @Theory
    @InlineData("let k = Use(x) + Use(x, x)") // the right operand fails
    @InlineData("let k = Use(x, x) + Use(x)") // the left operand fails
    @InlineData("let k = (Use(x) + Use(x, x)) * x") // the failed binary is an operand
    @InlineData("let k = x * (Use(x) + Use(x, x))")
    @InlineData("let k = !(Use(x) + Use(x, x))") // the failed binary is a unary operand
    @InlineData("let k = Use(x) + Use(x, x) == x") // a comparison over the failed binary
    @InlineData("let k = Use(x) == 1 && Use(x, x) == 1") // a short-circuit operator
    @InlineData("let k = Use(x) == 1 || Use(x, x) == 1")
    @InlineData("let k = Use(Use(x) + Use(x, x))") // the failed binary is a call argument
    @InlineData("t += Use(x) + Use(x, x)") // compound assignment with a failed binary value
    @InlineData("let k = Use(x) == 1 ? Use(x) : Use(x, x)") // a conditional with a failed branch
    @InlineData("let k = Opt(x) ?? Use(x, x)") // a coalesce with a failed right operand
    func OperandsOfAFailedBinary_AnswerTheirSymbolAndType(statement string) {
        let (model, tree, compilation) = CreateModel(statement)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        AssertLocalsAnswer(model, tree, "x")
    }

    @Theory
    @InlineData("let k = c + x") // no operator for the operand types
    @InlineData("let k = x - c")
    @InlineData("let k = c + Use(x)")
    @InlineData("let k = -c") // no unary operator for the operand type
    @InlineData("let k = -(c + x)")
    @InlineData("let k = (c + x) + x")
    @InlineData("t += c + x") // compound assignment with a failed binary value
    func OperandsOfAnUndefinedOperator_AnswerTheirSymbolAndType(statement string) {
        let (model, tree, compilation) = CreateModel(statement)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id is "GS0128" or "GS0129")
        let c = Assert.Single(Names(tree, "c"))
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(c).Symbol).Name)
        Assert.Equal("C", model.GetTypeInfo(c).Type?.Name)
        if statement.Contains('x') {
            AssertLocalsAnswer(model, tree, "x")
        }
    }

    @Theory
    @InlineData("c.N += c") // a member target
    @InlineData("arr[x] += c") // an element target
    @InlineData("t += c") // a local target
    @InlineData("c++") // an increment
    @InlineData("let k = c++") // a postfix increment whose value is read
    @InlineData("let k = c.Other++") // a postfix increment of a member
    @InlineData("r[x, x] += c") // a rectangular array element
    @InlineData("g[x, x] += c") // a two-index user indexer
    func ReferencesInACompoundAssignmentWithoutAnOperator_Answer(statement string) {
        let (model, tree, compilation) = CreateModel(statement)
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0129")
        let references = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text is "c" or "arr" or "x" or "r" or "g")
            .ToArray()
        Assert.NotEmpty(references)
        for reference in references {
            Assert.True(model.GetSymbolInfo(reference).Symbol != nil, "no symbol for " + reference.IdentifierToken.Text)
            let type = model.GetTypeInfo(reference).Type
            Assert.NotNull(type)
            Assert.NotSame(TypeSymbol.Error, type)
        }
    }

    @Fact
    func LeftOperandCall_AnswersItsTypeAndFunction() {
        let (model, tree, _) = CreateModel("let k = Use(x) + Use(x, x)")
        let left = tree
            .Root
            .DescendantNodes()
            .OfType[CallExpressionSyntax]()
            .First((call CallExpressionSyntax) -> call.Identifier.Text == "Use")
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(left).Type)
    }

    @Theory
    @InlineData("let k = Use(x) + Use(x, x)", "GS0144 , x: Function 'Use' requires 1 arguments but was given 2.")
    @InlineData("let k = c + x", "GS0129 +: Binary operator '+' is not defined for types 'C' and 'int32'.")
    @InlineData("let k = -c", "GS0128 -: Unary operator '-' is not defined for type 'C'.")
    @InlineData(
        "t += Use(x) + Use(x, x)",
        "GS0144 , x: Function 'Use' requires 1 arguments but was given 2.|GS0129 +=: Binary operator '+=' is not defined for types 'int32' and '?'."
    )
    func Diagnostics_AreTheSameAsBeforeTheOperandsWereKept(statement string, expected string) {
        let source = Source(statement)
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6187.gs"))
        let compilation = Compilation(tree)
        let before = Render(source, compilation)
        let model = compilation.GetSemanticModel(tree)
        let references = Names(tree, "x").Concat(Names(tree, "c")).ToArray()
        Assert.NotEmpty(references)
        for reference in references {
            Assert.NotNull(model.GetSymbolInfo(reference).Symbol)
        }
        Assert.Equal(expected.Split('|'), before)
        Assert.Equal(before, Render(source, compilation))
    }

    shared {
        private func Source(
            statement string
        ) string -> "package P\n\nclass C {\n    var N int32\n    var Other D = D()\n}\n\nclass D { }\n\nclass Grid {\n    prop this[a int32, b int32] int32 {\n        get { return 0 }\n        set { }\n    }\n}\n\nfunc Use(v int32) int32 -> v\n\nfunc Opt(v int32) int32? -> v\n\nfunc F(c C, arr []int32, r [,]int32, g Grid) {\n    let x = 1\n    var t = 0\n    " +
            statement +
            "\n}\n"

        private func CreateModel(statement string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(Source(statement), "issue6187.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func AssertLocalsAnswer(model SemanticModel, tree SyntaxTree, name string) {
            let names = Names(tree, name)
            Assert.NotEmpty(names)
            for reference in names {
                let local = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(reference).Symbol)
                Assert.Equal(name, local.Name)
                Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(reference).Type)
            }
        }

        private func Render(source string, compilation Compilation)[]string -> compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .Select(
            (d Diagnostic) -> d.Id + " " + source.Substring(d.Location.Span.Start, d.Location.Span.Length) +
                ": " +
                d.Message
        )
            .ToArray()

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()
    }
}
