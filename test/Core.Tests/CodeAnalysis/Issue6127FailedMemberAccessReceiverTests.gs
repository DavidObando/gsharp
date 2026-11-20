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
    @InlineData(0, false) // return c.N
    @InlineData(1, false) // let a = c.N + 1
    @InlineData(3, false) // let d = c.N.ToString()
    @InlineData(4, false) // c.N += 1
    @InlineData(0, true)
    @InlineData(1, true)
    // An argument of a call that fails too: the call keeps its failed member accesses only when
    // the compilation records member groups (the language server's compilations do).
    @InlineData(2, true) // let b = Use(c.N)
    @InlineData(3, true)
    @InlineData(4, true)
    func NullableReceiver_AnswersItsSymbolAndType(occurrence int32, recordMemberGroups bool) {
        let (model, tree) = CreateModel(recordMemberGroups)
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
        let (model, tree) = CreateModel(false)
        let receiver = Receiver(tree, "g", 0)
        let parameter = Assert.IsType[ParameterSymbol](model.GetSymbolInfo(receiver).Symbol)
        Assert.Equal("g", parameter.Name)
        Assert.Equal("C", model.GetTypeInfo(receiver).Type?.Name)
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
        Assert.Equal(5, before.Count((d string) -> d.Contains("because receiver 'c' may be nil")))
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
    let m = g.Missing
    return c.N
}
`

        private func CreateModel(recordMemberGroups bool)(SemanticModel, SyntaxTree) {
            let tree = SyntaxTree.Parse(SourceText.From(Source, "issue6127.gs"))
            let compilation = Compilation(tree)
            compilation.RecordMemberGroups = recordMemberGroups
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
