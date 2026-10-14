// <copyright file="Issue715ArrowFunctionTypeClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #715 / ADR-0075 — parser-level tests for the canonical arrow-form
/// function-type clause `(T1, T2, ...) -> R` and its async variant
/// `async (T) -> R`. The legacy `func(T) R` spelling continues to
/// parse for one release with a GS0303 deprecation warning.
open class Issue715ArrowFunctionTypeClauseParserTests {
    @Fact
    func Parses_ArrowFunctionType_InVarDeclaration_SingleParameter() {
        const source = "package P\nvar f (int32) -> int32 = (x int32) -> x + 1"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsFunction)
        Assert.True(clause.IsArrowFunction)
        Assert.False(clause.IsLegacyFuncFunction)
        Assert.Null(clause.FuncKeyword)
        Assert.Equal(SyntaxKind.RightArrowToken, clause.ArrowToken!!.Kind)
        Assert.Single(clause.FunctionParameterTypes!!)
        Assert.Equal("int32", clause.FunctionParameterTypes!![0].Identifier!!.Text)
        Assert.Equal("int32", clause.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_ArrowFunctionType_MultipleParameters() {
        const source = "package P\nvar op (int32, int32) -> int32 = (a int32, b int32) -> a + b"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.Equal(2, clause.FunctionParameterTypes!!.Count)
        Assert.Equal("int32", clause.FunctionParameterTypes!![0].Identifier!!.Text)
        Assert.Equal("int32", clause.FunctionParameterTypes!![1].Identifier!!.Text)
        Assert.Equal("int32", clause.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_ArrowFunctionType_ZeroParameters() {
        const source = "package P\nvar g () -> int32 = () -> 42"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.Empty(clause.FunctionParameterTypes!!)
        Assert.Equal("int32", clause.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_ArrowFunctionType_VoidReturn() {
        const source = "package P\nvar act () -> void = () -> { }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.NotNull(clause.ReturnTypeClause)
        Assert.Equal("void", clause.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_ArrowFunctionType_TupleReturn() {
        const source = `package P
func split(s string) (string, int32) { return (s, s.Length) }
var splitter (string) -> (string, int32) = split`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.ReturnTypeClause!!.IsTuple)
        Assert.Equal(2, clause.ReturnTypeClause!!.TupleElements!!.Count)
    }

    @Fact
    func Parses_AsyncArrowFunctionType() {
        const source = `package P
async func work(x int32) int32 { return x }
var cb async (int32) -> int32 = work`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsFunction)
        Assert.True(clause.IsArrowFunction)
        Assert.NotNull(clause.AsyncModifier)
        Assert.Equal(SyntaxKind.AsyncKeyword, clause.AsyncModifier!!.Kind)
        Assert.Single(clause.FunctionParameterTypes!!)
    }

    @Fact
    func Parses_ParenthesizedArrowFunctionType_AsNullableFunctionType() {
        const source = "package P\nvar cb ((int32) -> void)? = nil"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsNullable)
        Assert.Single(clause.FunctionParameterTypes!!)
        Assert.Equal("void", clause.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_ParenthesizedAsyncArrowFunctionType_AsNullableFunctionType() {
        const source = "package P\nvar cb async ((int32) -> int32)? = nil"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.True(clause.IsNullable)
        Assert.NotNull(clause.AsyncModifier)
        Assert.Equal("int32", clause.ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_NullableReturnArrowFunctionType_WithoutNullableFunctionType() {
        const source = "package P\nvar cb (int32) -> int32? = nil"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.False(clause.IsNullable)
        Assert.True(clause.ReturnTypeClause!!.IsNullable)
    }

    @Fact
    func Parses_ArrowFunctionType_InParameterPosition() {
        const source = "package P\nfunc apply(f (int32) -> int32, v int32) int32 { return f(v) }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clauses = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsArrowFunction).ToList()
        Assert.Single(clauses)
        Assert.Single(clauses[0].FunctionParameterTypes!!)
        Assert.Equal("int32", clauses[0].FunctionParameterTypes!![0].Identifier!!.Text)
        Assert.Equal("int32", clauses[0].ReturnTypeClause!!.Identifier!!.Text)
    }

    @Fact
    func Parses_ArrowFunctionType_InReturnPosition() {
        const source = "package P\nfunc makeAdder(delta int32) (int32) -> int32 { return (x int32) -> x + delta }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clauses = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsArrowFunction).ToList()
        Assert.Single(clauses)
    }

    @Fact
    func Parses_ArrowFunctionType_InLetInitializerType() {
        const source = "package P\nlet f (int32) -> int32 = (x int32) -> x * 2"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clauses = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsArrowFunction).ToList()
        Assert.Single(clauses)
    }

    @Fact
    func Parses_ArrowFunctionType_InGenericTypeArgument() {
        const source = `package P
struct Box[T any] { var Value T }
var b Box[(int32) -> int32]`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clauses = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsArrowFunction).ToList()
        // One arrow-function-typed type argument inside `Box[(int32) -> int32]`.
        Assert.Single(clauses)
    }

    @Fact
    func Parses_ArrowFunctionType_InGenericCallTypeArgument() {
        // The bounded-lookahead generic-call disambiguation must accept a
        // `(T) -> R` type argument so that `wrap[(int32) -> int32](f)`
        // commits to a generic call rather than collapsing to indexing.
        const source = `package P
func wrap[T any](v T) T { return v }
func use() {
    var f (int32) -> int32 = (x int32) -> x
    var g = wrap[(int32) -> int32](f)
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let clauses = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsArrowFunction).ToList()
        // Two arrow-function-typed type clauses: one on `var f` and one in
        // the generic argument list of `wrap[(int32) -> int32]`.
        Assert.Equal(2, clauses.Count)
    }

    @Fact
    func TupleType_StillParses_WhenNoArrowFollows() {
        const source = "package P\nvar p (int32, string) = (1, \"x\")"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        // The variable's type clause is a tuple, not an arrow function.
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsTuple)
        Assert.True(clause.IsTuple)
        Assert.False(clause.IsArrowFunction)
        Assert.False(clause.IsFunction)
    }

    @Fact
    func LegacyFuncType_StillParses_EmitsGS0303_Warning() {
        const source = "package P\nvar f func(int32) int32 = (x int32) -> x + 1"
        let tree = SyntaxTree.Parse(source)
        let warnings = tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303").ToList()
        let warning = Assert.Single(warnings)
        Assert.False(warning.IsError)
        Assert.Equal("func", warning.Location.Text!!.ToString(warning.Location.Span))
        Assert.Equal(
            "'func(...)' as a type clause is deprecated; use the arrow form '(...) -> R' instead (ADR-0075). The managed function-pointer form '*func(...) R' is a distinct construct and is not deprecated (ADR-0122).",
            warning.Message
        )
        let clause = FindAll[TypeClauseSyntax](tree).First((t TypeClauseSyntax) -> t.IsLegacyFuncFunction)
        Assert.True(clause.IsFunction)
        Assert.True(clause.IsLegacyFuncFunction)
        Assert.False(clause.IsArrowFunction)
    }

    @Fact
    func LegacyAsyncFuncType_StillParses_EmitsGS0303_Warning() {
        const source = `package P
async func work(x int32) int32 { return x }
var cb async func(int32) int32 = work`
        let tree = SyntaxTree.Parse(source)
        let warnings = tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303").ToList()
        Assert.Single(warnings)
    }

    @Fact
    func MixedForms_InSameFile_Each_LegacyOccurrence_Warns_Once() {
        const source = `package P
var f func(int32) int32 = (x int32) -> x
var g (int32) -> int32 = (x int32) -> x
var h func(int32) int32 = (x int32) -> x`
        let tree = SyntaxTree.Parse(source)
        let warnings = tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0303").ToList()
        Assert.Equal(2, warnings.Count)
        let clauses = FindAll[TypeClauseSyntax](tree).Where((t TypeClauseSyntax) -> t.IsFunction).ToList()
        Assert.Equal(2, clauses.Count((c TypeClauseSyntax) -> c.IsLegacyFuncFunction))
        Assert.Equal(1, clauses.Count((c TypeClauseSyntax) -> c.IsArrowFunction))
    }

    @Fact
    func LegacyAndArrow_BothFunctionTypes_AreSyntacticallyEquivalent_Shape() {
        const legacy = "package P\nvar f func(int32, int32) int32 = (a int32, b int32) -> a + b"
        const arrow = "package P\nvar f (int32, int32) -> int32 = (a int32, b int32) -> a + b"
        let legacyTree = SyntaxTree.Parse(legacy)
        let arrowTree = SyntaxTree.Parse(arrow)
        let legacyClause = FindAll[TypeClauseSyntax](legacyTree).First((t TypeClauseSyntax) -> t.IsLegacyFuncFunction)
        let arrowClause = FindAll[TypeClauseSyntax](arrowTree).First((t TypeClauseSyntax) -> t.IsArrowFunction)
        Assert.Equal(legacyClause.FunctionParameterTypes!!.Count, arrowClause.FunctionParameterTypes!!.Count)
        Assert.Equal(
            legacyClause.ReturnTypeClause!!.Identifier!!.Text,
            arrowClause.ReturnTypeClause!!.Identifier!!.Text
        )
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
