// <copyright file="Issue6150FailedCallArgumentTests.gs" company="GSharp">
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

/// Issue #6150: the arguments of a call that fails to bind keep their symbol and type in the
/// semantic model, whatever the error.
open class Issue6150FailedCallArgumentTests {
    @Theory
    @InlineData("let k = Use(x, 2)") // arity
    @InlineData("let k = Use(x, \"s\")") // arity, second argument of another type
    @InlineData("let k = Use(\"s\" + x.ToString(), x)") // no overload
    @InlineData("let k = Pick(x)") // no applicable overload
    @InlineData("let k = Missing(x)") // no such function
    @InlineData("let k = Use(x, 2) + 1") // the failed call is an operand
    @InlineData("let k = Use(Use(x, 2))") // the failed call is an argument of a call that binds
    func LocalArgument_AnswersItsSymbolAndType(statement string) {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc Use(v int32) int32 -> v\n\nfunc Pick(s string) int32 -> 0\nfunc Pick(b bool) int32 -> 1\n\nfunc F() {\n    let x = 1\n    " +
                statement +
                "\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        for argument in Names(tree, "x") {
            let local = Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(argument).Symbol)
            Assert.Equal("x", local.Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(argument).Type)
            Assert.Same(local, model.GetSymbolInfo(argument.IdentifierToken).Symbol)
        }
    }

    @Fact
    func ArgumentWithANullableReceiver_ReceiverAnswersItsSymbolAndType() {
        // The call fails because of its argument (GS0158 on `N`).
        let (model, tree, _) = CreateModel(
            "package P\n\nclass C {\n    var N int32\n}\n\nfunc Use(v int32) int32 -> v\n\nfunc F(c C?) {\n    let k = Use(c.N)\n}\n"
        )
        let receiver = Assert.Single(Names(tree, "c"))
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
    }

    @Fact
    func ConstructorCallThatFails_ArgumentsAnswerTheirSymbolAndType() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    init(v int32) { }\n}\n\nfunc F(s string) {\n    let x = 1\n    let c = C(x, s)\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let s = Assert.Single(Names(tree, "s"))
        Assert.Equal("s", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(s).Symbol).Name)
        Assert.Same(TypeSymbol.String, model.GetTypeInfo(s).Type)
    }

    @Fact
    func MethodCallThatFails_ReceiverAndArgumentsAnswer() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    func M(v int32) int32 -> v\n}\n\nfunc F(c C) {\n    let x = 1\n    let k = c.M(x, x)\n}\n"
        )
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let receiver = Assert.Single(Names(tree, "c"))
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol).Name)
        Assert.Equal("C", model.GetTypeInfo(receiver).Type?.Name)
        for argument in Names(tree, "x") {
            Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(argument).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(argument).Type)
        }
    }

    @Fact
    func TypedFunctionLiteralArgumentOfAFailedCall_BodyAnswers() {
        // A literal with typed parameters is bound without a target type, so it is kept (#6149,
        // #6150). An untyped literal waits for the target type of an overload the call never selects.
        let (model, tree, _) = CreateModel(
            "package P\n\nfunc Apply(g (int32) -> int32) int32 -> g(1)\n\nfunc F() {\n    let x = 1\n    let k = Apply((v int32) -> v + x, 2)\n}\n"
        )
        let x = Assert.Single(Names(tree, "x"))
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(x).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(x).Type)
        let v = Assert.Single(Names(tree, "v"))
        Assert.Equal("v", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(v).Symbol).Name)
    }

    @Fact
    func Diagnostics_AreUnchangedByTheIndex() {
        let source = "package P\n\nfunc Use(v int32) int32 -> v\n\nfunc F() {\n    let x = 1\n    let k = Use(x, 2)\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6150.gs"))
        let compilation = Compilation(tree)
        let before = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        let model = compilation.GetSemanticModel(tree)
        Assert.NotNull(model.GetSymbolInfo(Assert.Single(Names(tree, "x"))).Symbol)
        let after = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        Assert.Equal(before, after)
        Assert.Single(before.Where((d string) -> d.Contains("requires 1 arguments but was given 2")))
    }

    shared {
        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6150.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
            .ToArray()
    }
}
