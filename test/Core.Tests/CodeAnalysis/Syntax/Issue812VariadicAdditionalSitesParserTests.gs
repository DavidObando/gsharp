// <copyright file="Issue812VariadicAdditionalSitesParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0102 / issue #812 — parser tests for the additional declaration
/// sites the v1 ADR-0101 grammar deferred:
/// - class instance method
/// - class static (shared) method
/// - interface method (including DIM default body)
/// - constructor (init)
/// - function-literal and arrow lambda
/// - named delegate (`delegate X(...) R`)
/// The parser already accepted the spelling at every site before #812 —
/// the binder is what rejected it with GS0146. These tests pin the
/// grammar so we notice any regression in the parser-side surface.
open class Issue812VariadicAdditionalSitesParserTests {
    @Fact
    func Parses_Variadic_OnClassInstanceMethod() {
        const source = `package P
class Joiner {
  func Sum(nums ...int32) int32 { return 0 }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
        Assert.Equal("nums", p.Identifier!!.Text)
    }

    @Fact
    func Parses_Variadic_OnSharedStaticMethod() {
        const source = `package P
class Sequences {
  shared {
    func Of[T](values ...T) []T { return values }
  }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
        Assert.Equal("values", p.Identifier!!.Text)
    }

    @Fact
    func Parses_Variadic_OnInterfaceDefaultBody() {
        const source = `package P
interface IAdder {
  func Add(nums ...int32) int32 { return 0 }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
    }

    @Fact
    func Parses_Variadic_OnInterfaceAbstractMethod() {
        const source = `package P
interface IAdder {
  func Add(nums ...int32) int32;
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
    }

    @Fact
    func Parses_Variadic_OnConstructor() {
        const source = `package P
class Tags {
  var Values []string
  init(vs ...string) { Values = vs }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        // The first parameter belongs to the init constructor.
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
        Assert.Equal("vs", p.Identifier!!.Text)
    }

    @Fact
    func Parses_Variadic_OnFunctionLiteralLambda() {
        const source = "package P\nlet f = func(xs ...int32) int32 { return 0 }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
    }

    @Fact
    func Parses_Variadic_OnArrowLambda() {
        // ADR-0074 / issue #714 lambdas allow a trailing variadic.
        const source = "package P\nlet g = (xs ...int32) -> 0"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let p = FindFirst[ParameterSyntax](tree)
        Assert.True(p.IsVariadic)
    }

    @Fact
    func Parses_Variadic_OnNamedDelegateDeclaration() {
        const source = "package P\ndelegate StringJoiner(sep string, parts ...string) string;"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let parameters = Walk(tree.Root).OfType[ParameterSyntax]().ToList()
        Assert.Equal(2, parameters.Count)
        Assert.False(parameters[0].IsVariadic)
        Assert.True(parameters[1].IsVariadic)
        Assert.Equal("parts", parameters[1].Identifier!!.Text)
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T -> Walk(tree.Root).OfType[T]().First()

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                if child is SyntaxNode n {
                    for inner in Walk(n) {
                        yield inner
                    }
                }
            }
        }
    }
}
