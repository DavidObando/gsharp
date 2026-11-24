// <copyright file="Issue6217MemberAccessNameTests.gs" company="GSharp">
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

/// Issue #6217: the name node of a member access answers the member and the type of the access up to
/// that name, at the end and in the middle of a chain (`A.B.C` nests to the right in G#). An inner accessor
/// answers as its terminal, as it does when the terminal is a call.
open class Issue6217MemberAccessNameTests {
    @Theory
    @InlineData("Descriptors.First", "First", 0, "Field", "Descriptor") // a static field at the end
    @InlineData("Descriptors.First.Id", "First", 0, "Field", "Descriptor") // a middle name
    @InlineData("Descriptors.First.Id", "Id", 0, "Field", "string")
    @InlineData("bag.D.Name()", "D", 0, "Field", "Descriptor") // a middle name before a call
    @InlineData("bag.D.Id.Length", "D", 0, "Field", "Descriptor")
    @InlineData("bag.D.Id.Length", "Id", 0, "Field", "string")
    @InlineData("bag.D.Id.Length", "Length", 0, "Property", "int32") // an imported property
    @InlineData("sb.Length", "Length", 0, "Property", "int32")
    @InlineData("sb.Append(1).Length", "Length", 0, "Property", "int32") // after a call
    @InlineData("bag.Inner!!.D", "D", 0, "Field", "Descriptor") // after a null assertion
    @InlineData("bag.Names[0]", "Names", 0, "Field", "[]string") // an indexed member
    @InlineData("bag.Names[0].Length", "Names", 0, "Field", "[]string")
    func NameOfAMember_AnswersTheMemberAndItsType(
        expression string,
        name string,
        occurrence int32,
        symbolKind string,
        type string
    ) {
        let (model, tree, compilation) = CreateModel(expression)
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let node = Names(tree, name)[occurrence]
        let symbol = Assert.IsAssignableFrom[Symbol](model.GetSymbolInfo(node).Symbol)
        Assert.Equal(symbolKind, symbol.Kind.ToString())
        Assert.Equal(name, symbol.Name)
        // The name answers what its identifier answers.
        Assert.Equal(symbol.ToString(), model.GetSymbolInfo(node.IdentifierToken).Symbol?.ToString())
        Assert.Equal(type, model.GetTypeInfo(node).Type?.ToString())
    }

    @Theory
    @InlineData("Descriptors.First.Id", "First.Id", "Id", "string")
    @InlineData("bag.D.Id.Length", "D.Id.Length", "Length", "int32")
    @InlineData("bag.D.Id.Length", "Id.Length", "Length", "int32")
    @InlineData("sb.Append(1).Length", "Append(1).Length", "Length", "int32")
    @InlineData("bag.D.Name()", "D.Name()", "Name", "string") // a call terminal answered before
    func InnerAccessor_AnswersAsTheWholeChain(expression string, inner string, symbolName string, type string) {
        let (model, tree, _) = CreateModel(expression)
        let accessors = tree.Root.DescendantNodes().OfType[AccessorExpressionSyntax]().ToList()
        let node = accessors.Single((a AccessorExpressionSyntax) -> tree.Text.ToString(a.Span) == inner)
        let outer = accessors.Single((a AccessorExpressionSyntax) -> tree.Text.ToString(a.Span) == expression)
        Assert.Equal(symbolName, model.GetSymbolInfo(node).Symbol?.Name)
        // An imported member is a new symbol for each query, so the test compares what it displays.
        Assert.Equal(model.GetSymbolInfo(outer).Symbol?.ToString(), model.GetSymbolInfo(node).Symbol?.ToString())
        Assert.Equal(type, model.GetTypeInfo(node).Type?.ToString())
    }

    @Fact
    func HeadOfAChainAndNamespaces_KeepTheirAnswers() {
        let (model, tree, _) = CreateModel("System.Math.Abs(1)")
        // `System` names a namespace; `Math` is the static qualifier of the call.
        Assert.Null(model.GetSymbolInfo(Names(tree, "System")[0]).Symbol)
        Assert.Equal("System.Math", model.GetSymbolInfo(Names(tree, "Math")[0]).Symbol?.Name)
        let (bagModel, bagTree, _) = CreateModel("bag.D.Id")
        Assert.Equal("bag", bagModel.GetSymbolInfo(Names(bagTree, "bag").Last()).Symbol?.Name)
        Assert.Equal("Bag", bagModel.GetTypeInfo(Names(bagTree, "bag").Last()).Type?.ToString())
    }

    @Fact
    func NameOfANarrowedMember_HasTheNarrowedType() {
        let source = Template.Replace(
            "    let value = @@EXPR\n",
            "    if bag.Count != nil {\n        let value = bag.Count + 1\n    }\n"
        )
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6217.gs"))
        let compilation = Compilation(tree)
        Assert.DoesNotContain(compilation.GetDiagnostics(), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
        let model = compilation.GetSemanticModel(tree)
        let count = Names(tree, "Count").Last()
        let accessor = Assert.IsType[AccessorExpressionSyntax](count.Parent)
        Assert.Equal("int32", model.GetTypeInfo(accessor).Type?.ToString())
        Assert.Equal(model.GetTypeInfo(accessor).Type?.ToString(), model.GetTypeInfo(count).Type?.ToString())
    }

    @Fact
    func NameOfAMemberThatDoesNotExist_AnswersNothing() {
        let (model, tree, compilation) = CreateModel("bag.D.Missing")
        Assert.Contains(compilation.GetDiagnostics(), (d Diagnostic) -> d.Id == "GS0158")
        let missing = Names(tree, "Missing")[0]
        Assert.Null(model.GetSymbolInfo(missing).Symbol)
        Assert.Null(model.GetTypeInfo(missing).Type)
    }

    shared {
        private const Template string = `package P

import System.Text

class Descriptor {
    let Id string = "x"
    func Name() string -> Id
}

shared class Descriptors {
    let First Descriptor = Descriptor()
}

class Bag {
    var Inner Bag? = nil
    let D Descriptor = Descriptor()
    let Names []string = []string{"a"}
    let Count int32? = 1
}

func Use(bag Bag) {
    let sb = StringBuilder()
    let value = @@EXPR
}
`

        private func CreateModel(expression string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(Template.Replace("@@EXPR", expression), "issue6217.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        // The names in the expression of `value`, in source order.
        private func Names(tree SyntaxTree, name string)[]NameExpressionSyntax {
            let start = tree.Text.ToString().IndexOf("let value", StringComparison.Ordinal)
            return tree
                .Root
                .DescendantNodes()
                .OfType[NameExpressionSyntax]()
                .Where((n NameExpressionSyntax) -> n.Span.Start > start && n.IdentifierToken.Text == name)
                .OrderBy((n NameExpressionSyntax) -> n.Span.Start)
                .ToArray()
        }
    }
}
