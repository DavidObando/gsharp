// <copyright file="Issue3639TupleArrowElementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #3639 — a tuple TYPE may contain parenthesized arrow-function
/// elements: `((int32) -> int32, (int32) -> int32)`. Before the fix
/// the parser saw `((` + an inner arrow shape and committed to the
/// ADR-0137 parenthesized-arrow form `((T) -> R)?`, then failed with
/// GS0005 at the tuple's first top-level comma. The parenthesized-arrow
/// look-ahead now also requires that the OUTER paren group has no top-level
/// comma, so tuple types fall through to the tuple parse, whose per-element
/// parses re-dispatch on the arrow look-ahead. cs2gs emits this spelling for
/// C# `(Func<int,int>, Func<int,int>)` tuples (#3501).
open class Issue3639TupleArrowElementParserTests {
    @Fact
    func TupleType_WithTwoArrowElements_AsFunctionReturnType() {
        const source = `package P
func mk() ((int32) -> int32, (int32) -> int32) {
    return ((x int32) -> x + 1, (x int32) -> x * 2)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.NotNull(tuple.TupleElements)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.All(tuple.TupleElements!!, (e TypeClauseSyntax) -> Assert.True(e.IsArrowFunction))
        Assert.All(
            tuple.TupleElements!!,
            (e TypeClauseSyntax) -> Assert.Equal("int32", e.ReturnTypeClause!!.Identifier!!.Text)
        )
    }

    @Fact
    func TupleType_WithZeroArgArrowElements() {
        const source = `package P
func mk() (() -> int32, () -> int32) {
    return (() -> 1, () -> 2)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.All(tuple.TupleElements!!, (e TypeClauseSyntax) -> Assert.True(e.IsArrowFunction))
        Assert.All(tuple.TupleElements!!, (e TypeClauseSyntax) -> Assert.Empty(e.FunctionParameterTypes!!))
    }

    @Fact
    func TupleType_ArrowElementMixedWithNamedType() {
        const source = "package P\nvar t ((int32) -> int32, string)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.True(tuple.TupleElements!![0].IsArrowFunction)
        Assert.Equal("string", tuple.TupleElements!![1].Identifier!!.Text)
    }

    @Fact
    func TupleType_WithArrowElements_InTypeArgumentPosition() {
        const source = `package P
func take() {
    Check.IsType[((int32) -> int32, (int32) -> int32)](nil)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.All(tuple.TupleElements!!, (e TypeClauseSyntax) -> Assert.True(e.IsArrowFunction))
    }

    @Fact
    func TupleType_WithArrowElement_NestedInGeneric() {
        const source = "package P\nvar xs List[((int32) -> int32, string)]"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.True(tuple.TupleElements!![0].IsArrowFunction)
        Assert.Equal("string", tuple.TupleElements!![1].Identifier!!.Text)
    }

    @Fact
    func TupleType_NamedElements_WithArrowElementTypes() {
        // ADR-0172 named elements compose with arrow element types.
        const source = `package P
func mk() (f (int32) -> int32, g () -> int32) {
    return ((x int32) -> x - 1, () -> 7)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.Equal("f", tuple.TupleElements!![0].TupleElementNameToken?.Text)
        Assert.Equal("g", tuple.TupleElements!![1].TupleElementNameToken?.Text)
        Assert.All(tuple.TupleElements!!, (e TypeClauseSyntax) -> Assert.True(e.IsArrowFunction))
    }

    @Fact
    func TupleType_ParenthesizedNullableArrowElement() {
        const source = "package P\nvar t (((int32) -> int32)?, string)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tuple = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, tuple.TupleElements!!.Count)
        Assert.True(tuple.TupleElements!![0].IsArrowFunction)
        Assert.True(tuple.TupleElements!![0].IsNullable)
    }

    @Fact
    func NestedTupleType_WithArrowElement() {
        const source = "package P\nvar t (((int32) -> int32, string), bool)"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let outer = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.Equal(2, outer.TupleElements!!.Count)
        let inner = outer.TupleElements!![0]
        Assert.True(inner.IsTuple)
        Assert.Equal(2, inner.TupleElements!!.Count)
        Assert.True(inner.TupleElements!![0].IsArrowFunction)
    }

    @Fact
    func ParenthesizedNullableArrowType_StillParsesAsArrow_NotTuple() {
        // Negative guard: the ADR-0137 spelling `((T) -> R)?` must keep its
        // meaning — an arrow function type made nullable as a whole.
        const source = "package P\nvar f ((int32) -> int32)?"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.False(clause.IsTuple)
        Assert.True(clause.IsNullable)
        Assert.Single(clause.FunctionParameterTypes!!)
    }

    @Fact
    func ParenthesizedNullableArrowType_MultiParameter_StillParsesAsArrow() {
        // Negative guard: the comma inside `((int32, string) -> bool)?` is a
        // PARAMETER-list comma (nested paren depth), not a tuple comma.
        const source = "package P\nvar f ((int32, string) -> bool)?"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.False(clause.IsTuple)
        Assert.True(clause.IsNullable)
        Assert.Equal(2, clause.FunctionParameterTypes!!.Count)
    }

    @Fact
    func ArrowType_WithTupleReturn_StillParsesAsArrow() {
        // Negative guard: `((int32) -> (int32, string))?` — the comma sits in
        // the RETURN tuple (nested paren depth), so the parenthesized-arrow
        // form must still win.
        const source = "package P\nvar f ((int32) -> (int32, string))?"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsNullable)
        Assert.True(clause.ReturnTypeClause!!.IsTuple)
    }

    shared {
        private func FindAll[T SyntaxNode](tree SyntaxTree) IEnumerable[T] {
            return Walk(tree.Root).OfType[T]()
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
