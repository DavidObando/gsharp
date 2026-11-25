// <copyright file="Issue6200MemberUnresolvedTypeArgumentTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Linq
import Xunit

/// Issue #6200: a member call with an unresolved type argument does not report a misleading GS0159
/// when the member exists, and keeps the call's receiver and arguments in SemanticModel.
open class Issue6200MemberUnresolvedTypeArgumentTests {
    @Theory
    @InlineData("let a = c.M[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let a = c.G[Nope](x)", "GS0113 Nope")
    @InlineData("let a = c.G[Nope, int32](x)", "GS0113 Nope|GS0148 [Nope, int32]")
    @InlineData("let a = n.Invoke[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let a = c.Mixed[Nope](x)", "GS0113 Nope")
    @InlineData("let a = c.Mixed[Nope, int32](x)", "GS0113 Nope|GS0148 [Nope, int32]")
    @InlineData("let a = c.Fn[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("Console.WriteLine[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let a = \"a\".Trim[Nope]()", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let a = xs.ToList[Nope]()", "GS0113 Nope")
    @InlineData("let a = c.ToList[Nope]()", "GS0113 Nope|GS0159 ToList[Nope]()")
    @InlineData("let a = seq.ToList[Nope]()", "GS0113 Nope")
    @InlineData("let a = List[Nope](x)", "GS0113 Nope")
    @InlineData("let a = StringBuilder[Nope](x)", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let a = System.Text.StringBuilder.ChunkEnumerator[Nope]()", "GS0113 Nope|GS0148 [Nope]")
    @InlineData("let a = c.Missing[Nope](x)", "GS0113 Nope|GS0159 Missing[Nope](x)")
    func MemberCallWithUnresolvedTypeArgument_ReportsExpectedDiagnosticsAndKeepsArguments(
        statement string,
        expected string
    ) {
        let source = Template(statement)
        let (model, tree, compilation) = CreateModel(source)
        Assert.Equal(expected.Split('|'), Errors(source, compilation))
        let fBody = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Last()
        for arg in fBody
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x") {
            Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol).Name)
            Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
        }
        for recv in fBody
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "c") {
            Assert.Equal("c", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(recv).Symbol).Name)
            Assert.Equal("C", model.GetTypeInfo(recv).Type?.Name)
        }
        for del in fBody
            .DescendantNodes()
            .OfType[NameExpressionSyntax]()
            .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "n") {
            Assert.Equal("n", Assert.IsType[ParameterSymbol](model.GetSymbolInfo(del).Symbol).Name)
            Assert.Equal("Named", model.GetTypeInfo(del).Type?.Name)
        }
    }

    @Fact
    func MemberCallWithUnresolvedTypeArgumentAndDeferredLambda_KeepsLambdaBodyInSemanticModel() {
        let source = Template("let a = c.M[Nope]((v) -> x)")
        let (model, tree, compilation) = CreateModel(source)
        let errorIds = compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .Select((d Diagnostic) -> d.Id)
            .ToArray()
        Assert.Contains("GS0113", errorIds)
        Assert.Contains("GS0148", errorIds)
        Assert.DoesNotContain("GS0159", errorIds)
        let fBody = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Last()
        let captured = Assert.Single(
            fBody
                .DescendantNodes()
                .OfType[NameExpressionSyntax]()
                .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x")
        )
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(captured).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(captured).Type)
    }

    @Fact
    func InheritedDefaultInterfaceMethodsWithUnresolvedTypeArgument_DoNotCascadeGS0159() {
        let source = `package P

interface IDefault {
    func DM(x int32) int32 { return x }
    func DM[T](x T) T { return x }
}

class Impl : IDefault {
}

func F(impl Impl) {
    let x = 1
    let a = impl.DM[Nope](x)
}
`
        let (model, tree, compilation) = CreateModel(source)
        let errors = Errors(source, compilation)
        Assert.Equal([]string{"GS0113 Nope"}, errors)
        let fBody = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Last()
        let arg = Assert.Single(
            fBody
                .DescendantNodes()
                .OfType[NameExpressionSyntax]()
                .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x")
        )
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
    }

    @Fact
    func ImportedDelegatePropertyHidingInheritedMethod_UnresolvedTypeArgument_KeepsGS0113AndGS0148() {
        using let fixture = GSharp.Core.Tests.CSharpFixture(`namespace PropHidesMethod6200;
using System;
public class Base {
    public void P() {}
}
public class Derived : Base {
    public new Func<int, int> P => v => v;
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        let source = `package P
import PropHidesMethod6200

func F(d Derived) {
    let x = 1
    let _ = d.P[Nope](x)
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue6200_prop_hides_method.gs"))
        let compilation = Compilation(resolver, tree)
        let model = compilation.GetSemanticModel(tree)
        Assert.Equal([]string{"GS0113 Nope", "GS0148 [Nope]"}, Errors(source, compilation))
        let fBody = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Last()
        let arg = Assert.Single(
            fBody
                .DescendantNodes()
                .OfType[NameExpressionSyntax]()
                .Where((n NameExpressionSyntax) -> n.IdentifierToken.Text == "x")
        )
        Assert.Equal("x", Assert.IsAssignableFrom[VariableSymbol](model.GetSymbolInfo(arg).Symbol).Name)
        Assert.Same(TypeSymbol.Int32, model.GetTypeInfo(arg).Type)
    }

    shared {
        private func Template(statement string) string -> `package P
import System
import System.Collections.Generic
import System.Linq
import System.Text

delegate Named(x int32) int32;

class C {
    var Fn (int32) -> int32 = (v int32) -> v
    func M(x int32) int32 -> x
    func G[T](x T) T -> x
    func Mixed(x int32) int32 -> x
    func Mixed[T](x T) T -> x
}

class MySeq : IEnumerable[int32] {
    public func GetEnumerator() IEnumerator[int32] -> List[int32]{1}.GetEnumerator()
    private func (System.Collections.IEnumerable) GetEnumerator() System.Collections.IEnumerator -> GetEnumerator()
}

func F(c C, n Named, xs List[int32], seq MySeq) {
    let x = 1
    ` + statement + `
}
`

        private func CreateModel(source string)(SemanticModel, SyntaxTree, Compilation) {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue6200.gs"))
            let compilation = Compilation(tree)
            return (compilation.GetSemanticModel(tree), tree, compilation)
        }

        private func Errors(source string, compilation Compilation)[]string -> compilation
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
            .Select((d Diagnostic) -> d.Id + " " + source.Substring(d.Location.Span.Start, d.Location.Span.Length))
            .ToArray()
    }
}
