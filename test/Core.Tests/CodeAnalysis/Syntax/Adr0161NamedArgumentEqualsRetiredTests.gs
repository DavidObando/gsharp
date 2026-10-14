// <copyright file="Adr0161NamedArgumentEqualsRetiredTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0161 — the legacy `name = value` named-argument spelling, deprecated
/// by ADR-0080 with the one-release `GS0315` warning, is retired. `=`
/// after an identifier in argument position is no longer a separator: it parses
/// as an ordinary assignment expression, exactly as `=` does in every other
/// expression position.
///
/// Supersedes `Issue720NamedArgumentEqualsDeprecatedTests`, which asserted
/// the grace-period behaviour.
///
/// The transitional risk is that `f(name = value)` was a named argument and
/// is now an assignment. Where the target is not in scope that is a loud binder
/// error; where it IS in scope and also names a parameter, the two readings
/// differ silently — so a bare assignment argument carries `GS0524`.
/// Parenthesising states the intent and silences it.
open class Adr0161NamedArgumentEqualsRetiredTests {
    @Fact
    func CanonicalColonForm_StillParses_AndDoesNotWarn() {
        const source = `package P
func Bar(timeout int32) {
}
func Foo() {
  Bar(timeout: 30)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let named = FindFirst[NamedArgumentExpressionSyntax](tree)
        Assert.Equal(SyntaxKind.ColonToken, named.EqualsToken.Kind)
        Assert.Equal("timeout", named.NameToken.Text)
    }

    @Fact
    func EqualsForm_IsNoLongerANamedArgument() {
        const source = `package P
func Bar(timeout int32) {
}
func Foo() {
  var timeout = 0
  Bar(timeout = 30)
}`
        let tree = SyntaxTree.Parse(source)
        // The retired separator must not produce a named argument any more.
        Assert.Empty(Walk(tree.Root).OfType[NamedArgumentExpressionSyntax]())
        Assert.NotEmpty(Walk(tree.Root).OfType[AssignmentExpressionSyntax]())
    }

    @Fact
    func BareAssignmentArgument_Warns_GS0524() {
        const source = `package P
func Bar(timeout int32) {
}
func Foo() {
  var timeout = 0
  Bar(timeout = 30)
}`
        let tree = SyntaxTree.Parse(source)
        let warning = Assert.Single(tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0524"))
        Assert.Contains("timeout", warning.Message)
        Assert.Contains("timeout: value", warning.Message)
        Assert.Contains("(timeout = value)", warning.Message)
    }

    /// Parenthesising states assignment intent unambiguously and is the spelling
    /// cs2gs emits, so it must stay warning-free.
    @Fact
    func ParenthesisedAssignmentArgument_DoesNotWarn() {
        const source = `package P
func Bar(x int32) int32 {
  return x
}
func Foo() {
  var x = 0
  Bar((x = 5))
}`
        let tree = SyntaxTree.Parse(source)
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0524")
    }

    @Fact
    func GS0315_IsRetired_AndNeverEmitted() {
        const source = `package P
func Bar(timeout int32) {
}
func Foo() {
  var timeout = 0
  Bar(timeout = 30)
  Bar(timeout: 30)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0315")
    }

    /// ADR-0161's motivating case: a value-position assignment as an argument is
    /// now expressible, which is what lets cs2gs stop spilling it into a
    /// synthetic temp (#3347 spill sites C1/C2/C3).
    @Fact
    func AssignmentArgument_ParsesAsAnExpression() {
        const source = `package P
func Bar(x int32) int32 {
  return x
}
func Foo() {
  var x = 0
  Bar((x = 5))
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.NotEmpty(Walk(tree.Root).OfType[AssignmentExpressionSyntax]())
    }

    /// Out-of-scope carve-outs from ADR-0080 that must remain unaffected: a
    /// `with`-expression field initializer and a parameter default both use
    /// `=` through separate parser paths.
    @Fact
    func WithExpressionAndParameterDefault_AreUnaffected() {
        const source = `package P
data struct Point {
  var X int32
  var Y int32
}
func Shift(p Point) Point {
  return p with { X = 10 }
}
func Defaulted(x int32 = 0) int32 {
  return x
}`
        let tree = SyntaxTree.Parse(source)
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0524")
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0315")
    }

    shared {
        private func FindFirst[T SyntaxNode](tree SyntaxTree) T {
            return Walk(tree.Root).OfType[T]().First()
        }

        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for c in node.GetChildren() {
                if c is SyntaxNode sn {
                    for d in Walk(sn) {
                        yield d
                    }
                }
            }
        }
    }
}
