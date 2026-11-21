// <copyright file="Issue6149FunctionLiteralBodySymbolTests.gs" company="GSharp">
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

/// Issue #6149: expressions inside a function literal body answer their symbol and type, as they
/// do in a function body.
open class Issue6149FunctionLiteralBodySymbolTests {
    @Fact
    func CapturedParameter_AnswersItsSymbolAndType() {
        let (model, tree) = CreateModel(
            "package P\n\nclass C {\n    var N int32 = 1\n}\n\nfunc F(c C) {\n    let f = () -> c.N\n}\n"
        )
        let receiver = Name(tree, "c")
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        Assert.Equal("C", model.GetTypeInfo(receiver).Type?.Name)
        Assert.Same(parameter, model.GetSymbolInfo(receiver.IdentifierToken).Symbol)
        let access = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().Single()
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(access).Symbol)
        Assert.Equal("N", field.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(access).Type)
    }

    @Fact
    func LiteralParameterAndLocal_AnswerTheirSymbols() {
        let (model, tree) = CreateModel(
            "package P\n\nfunc F() {\n    let f = (a int32) -> {\n        let b = a + 1\n        return b\n    }\n}\n"
        )
        let a = Name(tree, "a")
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(a).Symbol)
        Assert.Equal("a", parameter.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(a).Type)
        let b = Name(tree, "b")
        let local = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(b).Symbol)
        Assert.Equal("b", local.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(b).Type)
    }

    @Fact
    func NestedLiteral_AnswersTheCapturesOfBothLevels() {
        let (model, tree) = CreateModel(
            "package P\n\nclass C {\n    var N int32 = 1\n}\n\nfunc F(c C) {\n    let f = (k int32) -> () -> c.N + k\n}\n"
        )
        let receiver = Name(tree, "c")
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        Assert.Equal("C", model.GetTypeInfo(receiver).Type?.Name)
        let k = Name(tree, "k")
        let outer = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(k).Symbol)
        Assert.Equal("k", outer.Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(k).Type)
    }

    @Fact
    func LiteralPassedAsAnArgument_AnswersItsBody() {
        let (model, tree) = CreateModel(
            "package P\n\nclass C {\n    var N int32 = 1\n}\n\nfunc Apply(g (int32) -> int32) int32 -> g(1)\n\nfunc F(c C) int32 {\n    return Apply((v int32) -> v + c.N)\n}\n"
        )
        let receiver = Name(tree, "c")
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        let v = Name(tree, "v")
        Assert.Equal("v", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(v).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(v).Type)
    }

    @Fact
    func NullableReceiverInALiteral_AnswersItsSymbolAndType() {
        // GS0158 inside a literal: the failed access keeps its receiver there too (#6127).
        let (model, tree) = CreateModel(
            "package P\n\nclass C {\n    var N int32 = 1\n}\n\nfunc F(c C?) {\n    let f = () -> c.N\n}\n"
        )
        let receiver = Name(tree, "c")
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
    }

    @Fact
    func VoidExpressionBodiedLiteral_AnswersItsCall() {
        // A void expression body is an expression statement anchored at the expression.
        let (model, tree) = CreateModel(
            "package P\n\nclass C {\n    func Touch(v int32) { }\n}\n\nfunc F(c C, k int32) {\n    let f = () -> c.Touch(k)\n}\n"
        )
        let call = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().Single()
        let touched = Assert.IsAssignableFrom[FunctionSymbol](model.GetSymbolInfo(call).Symbol)
        Assert.Equal("Touch", touched.Name)
        Assert.Same(TypeSymbol.Void, model.GetTypeInfo(call).Type)
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(Name(tree, "c")).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(Name(tree, "k")).Type)
    }

    @Fact
    func AssignmentInALiteral_AnswersTheFieldItWrites() {
        let (model, tree) = CreateModel(
            "package P\n\nclass C {\n    var N int32 = 1\n\n    func Set() {\n        let f = func() { N = 2 }\n        f()\n    }\n}\n"
        )
        let write = tree.Root.DescendantNodes().OfType[AssignmentExpressionSyntax]().Single()
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(write).Symbol)
        Assert.Equal("N", field.Name)
    }

    @Fact
    func LiteralBody_AnswersAsTheSameCodeInAFunctionBody() {
        // Every expression of the literal answers what the same expression answers in a body.
        let members = "package P\n\nclass C {\n    var N int32 = 1\n    func M(v int32) int32 -> v\n}\n\n"
        let statements = "let a = c.M(c.N) + k\n        let b = a.ToString()\n        return b.Length"
        let (inLiteral, literalTree) = CreateModel(
            members + "func F(c C, k int32) {\n    let f = () -> {\n        " + statements + "\n    }\n}\n"
        )
        let (inBody, bodyTree) = CreateModel(
            members + "func F(c C, k int32) int32 {\n    {\n        " + statements + "\n    }\n}\n"
        )
        let literalNodes = Expressions(literalTree)
        let bodyNodes = Expressions(bodyTree)
        Assert.Equal(bodyNodes.Length, literalNodes.Length)
        Assert.NotEmpty(bodyNodes)
        for var i = 0; i < bodyNodes.Length; i++ {
            Assert.Equal(bodyNodes[i].ToString(), literalNodes[i].ToString())
            let expected = inBody.GetSymbolInfo(bodyNodes[i]).Symbol
            let actual = inLiteral.GetSymbolInfo(literalNodes[i]).Symbol
            Assert.Equal(expected?.Name, actual?.Name)
            Assert.Equal(expected?.GetType(), actual?.GetType())
            Assert.Equal(
                inBody.GetTypeInfo(bodyNodes[i]).Type?.ToString(),
                inLiteral.GetTypeInfo(literalNodes[i]).Type?.ToString()
            )
        }
        Assert.Contains(
            literalNodes,
            (n ExpressionSyntax) -> n is NameExpressionSyntax && inLiteral.GetSymbolInfo(n).Symbol is ParameterSymbol
        )
    }

    shared {
        /// The expressions of the innermost statements, the `a`/`b` declarations and the `return`.
        private func Expressions(tree SyntaxTree)[]ExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .Where((d VariableDeclarationSyntax) -> d.Identifier.Text == "a" || d.Identifier.Text == "b")
            .Cast[SyntaxNode]()
            .Concat(tree.Root.DescendantNodes().OfType[ReturnStatementSyntax]())
            .SelectMany((s SyntaxNode) -> s.DescendantNodes().OfType[ExpressionSyntax]())
            .ToArray()

        private func CreateModel(source string)(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6149.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree)
        }

        private func Name(tree SyntaxTree, name string) NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .First((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
    }
}
