// <copyright file="Issue6151NilableReceiverCallTests.gs" company="GSharp">
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

/// Issue #6151: the receiver of a call that reports GS0159 (the receiver may be nil) keeps its
/// symbol and type in the semantic model, as the receiver of a GS0158 access does (#6127).
open class Issue6151NilableReceiverCallTests {
    @Theory
    @InlineData("return c.M()")
    @InlineData("let k = c.M() + 1\n    return k")
    @InlineData("let k = c.M().ToString()\n    return 0")
    func NullableSourceReceiver_AnswersItsSymbolAndType(body string) {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    func M() int32 -> 1\n}\n\nfunc F(c C?) int32? {\n    " + body + "\n}\n"
        )
        Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0159"))
        let receiver = Name(tree, "c")
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        let type = Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
        Assert.Equal("C", type.UnderlyingType.Name)
        Assert.Same(parameter, model.GetSymbolInfo(receiver.IdentifierToken).Symbol)
    }

    @Fact
    func NullableImportedReceiver_AnswersItsSymbolAndType() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nfunc F(s string?) string? {\n    return s.Trim()\n}\n"
        )
        Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0159"))
        let receiver = Name(tree, "s")
        Assert.Equal("s", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol).Name)
        let type = Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
        Assert.Same(TypeSymbol.String, type.UnderlyingType)
    }

    @Fact
    func NullableIntermediateOfAChain_AnswersItsSymbolAndType() {
        let (model, tree, compilation) = CreateModel(
            "package P\n\nclass C {\n    var Child C?\n    func M() int32 -> 1\n}\n\nfunc F(c C) int32? {\n    return c.Child.M()\n}\n"
        )
        Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0159"))
        let root = Name(tree, "c")
        Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(root).Symbol).Name)
        Assert.Equal("C", model.GetTypeInfo(root).Type?.Name)
        let child = Name(tree, "Child")
        Assert.Equal("Child", Assert.IsType[FieldSymbol](model.GetSymbolInfo(child).Symbol).Name)
        Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(child).Type)
    }

    @Fact
    func Diagnostics_AreUnchangedByTheIndex() {
        let source = "package P\n\nclass C {\n    func M() int32 -> 1\n}\n\nfunc F(c C?) int32? {\n    return c.M()\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6151.gs"))
        let compilation = Compilation(tree)
        let before = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        let model = compilation.GetSemanticModel(tree)
        Assert.NotNull(model.GetSymbolInfo(Name(tree, "c")).Symbol)
        let after = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        Assert.Equal(before, after)
        Assert.Single(before.Where((d string) -> d.Contains("because receiver 'c' may be nil")))
    }

    shared {
        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6151.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Name(tree SyntaxTree, name string) NameExpressionSyntax -> tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Single((n NameExpressionSyntax) -> n.IdentifierToken.Text == name)
    }
}
