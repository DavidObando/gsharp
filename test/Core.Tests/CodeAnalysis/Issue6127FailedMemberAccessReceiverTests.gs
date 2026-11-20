// <copyright file="Issue6127FailedMemberAccessReceiverTests.gs" company="GSharp">
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

/// Issue #6127: the receiver of a member access that reports GS0158 keeps its symbol and type in
/// the semantic model, wherever the failed access appears.
open class Issue6127FailedMemberAccessReceiverTests {
    @Theory
    @InlineData(0) // return c.N
    @InlineData(1) // let a = c.N + 1
    @InlineData(3) // let d = c.N.ToString()
    @InlineData(4) // c.N += 1
    func NullableReceiver_AnswersItsSymbolAndType(occurrence int32) {
        let (model, tree) = CreateModel()
        let receiver = Receiver(tree, "c", occurrence)
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("c", parameter.Name)
        let type = Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
        Assert.Equal("C", type.UnderlyingType.Name)
        Assert.Same(parameter, model.GetSymbolInfo(receiver.IdentifierToken).Symbol)
        Assert.IsType[NullableTypeSymbol](model.GetReceiverTypeInfo(receiver).Type)
    }

    @Fact
    func MissingMember_ReceiverAnswersItsSymbolAndType() {
        let (model, tree) = CreateModel()
        let receiver = Receiver(tree, "g", 0)
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("g", parameter.Name)
        Assert.Equal("C", model.GetTypeInfo(receiver).Type?.Name)
    }

    @Fact
    func NullableStringReceiver_AnswersItsSymbolAndType() {
        let (model, tree) = CreateModel()
        let receiver = Receiver(tree, "s", 0)
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("s", parameter.Name)
        let type = Assert.IsType[NullableTypeSymbol](model.GetTypeInfo(receiver).Type)
        Assert.Same(TypeSymbol.String, type.UnderlyingType)
    }

    @Fact
    func NullableReceiverOfAFailedWrite_TokenAnswersTheParameter() {
        let (model, tree) = CreateModel()
        let write = tree.Root.DescendantNodes().OfType[FieldAssignmentExpressionSyntax]().Single()
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(write.Receiver).Symbol)
        Assert.Equal("c", parameter.Name)
    }

    @Theory
    @InlineData("return c.Child.N")
    @InlineData("c.Child.N += 1\n    return 0")
    func NullableIntermediateOfAChain_AnswersItsSymbolAndType(body string) {
        let tree = SyntaxTree.Parse(
            SourceText.From(
                "package P\n\nclass C {\n    var N int32\n    var Child C?\n}\n\nfunc F(c C) int32? {\n    " +
                    body +
                    "\n}\n",
                "chain.gs"
            )
        )
        let compilation = Compilation(tree)
        Assert.Single(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Id == "GS0158"))
        let model = compilation.GetSemanticModel(tree)
        let child = tree
            .Root
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Single((n NameExpressionSyntax) -> n.IdentifierToken.Text == "Child")
        let field = Assert.IsType[FieldSymbol](model.GetSymbolInfo(child).Symbol)
        Assert.Equal("Child", field.Name)
        Assert.IsType[NullableTypeSymbol](model.GetReceiverTypeInfo(child).Type)
    }

    @Fact
    func Diagnostics_AreOnePerFailedAccess() {
        let tree = SyntaxTree.Parse(SourceText.From(Source, "issue6127.gs"))
        let compilation = Compilation(tree)
        // The model's index is built before the diagnostics are read a second time.
        let before = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        let model = compilation.GetSemanticModel(tree)
        Assert.NotNull(model.GetSymbolInfo(Receiver(tree, "c", 0)).Symbol)
        let after = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        Assert.Equal(before, after)
        Assert.Equal(6, before.Count((d string) -> d.Contains("because receiver 'c' may be nil")))
        Assert.Single(before.Where((d string) -> d.Contains("Cannot find member Missing")))
    }

    shared {
        private const Source string = `package P

class C {
    var N int32
}

func Use(v int32) int32 -> v

func F(c C?, g C) int32? {
    let a = c.N + 1
    let b = Use(c.N)
    let d = c.N.ToString()
    c.N += 1
    c.N = 7
    let m = g.Missing
    return c.N
}

func H(s string?) int32 {
    return s.Length
}
`

        private func CreateModel()(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(Source, "issue6127.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree)
        }

        /// The receiver name [`name`](paramref) of a member access, numbered from the `return`
        /// statement and then in source order.
        private func Receiver(tree SyntaxTree, name string, occurrence int32) NameExpressionSyntax {
            let receivers = tree
                .Root
                .DescendantNodes()
                .OfType[AccessorExpressionSyntax]()
                .Select((a AccessorExpressionSyntax) -> a.LeftPart as NameExpressionSyntax)
                .Where((n NameExpressionSyntax?) -> n != nil && n.IdentifierToken.Text == name)
                .Select((n NameExpressionSyntax?) -> n!!)
                .Distinct()
                .OrderBy((n NameExpressionSyntax) -> n.Span.Start)
                .ToList()
            // The `return` receiver is the last one in the source.
            let last = receivers[receivers.Count - 1]
            receivers.RemoveAt(receivers.Count - 1)
            receivers.Insert(0, last)
            return receivers[occurrence]
        }
    }
}
