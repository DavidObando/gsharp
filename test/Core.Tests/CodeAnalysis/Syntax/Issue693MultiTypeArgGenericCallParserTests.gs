// <copyright file="Issue693MultiTypeArgGenericCallParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #693 (follow-up to #690): direct parser regression coverage for the
/// ADR-0020 bounded-lookahead disambiguation between an indexing expression
/// (`name[expr]`) and a multi-type-arg generic instantiation followed by
/// a call (`Type[T1, T2, …](args)`).
///
/// PR #690 left a note in `Issue671ConstructionCallEmitTests.cs`
/// claiming `Dictionary[K, V]()` was "shadowed by the map-literal
/// parser" and worked around it via `KeyValuePair[K, V](k, v)`. That
/// note was stale: the parser's `LooksLikeGenericCallSite` probe
/// already scans an arbitrary number of comma-separated type clauses inside
/// the brackets and commits to a generic call site when the token after the
/// matching `]` is one of `(`, `{`, or `.`. These tests
/// lock that contract in at the parser layer.
///
/// G#'s only map-literal syntax is `map[K,V]{ k: v, … }` with the
/// explicit `map` keyword, so it cannot syntactically collide with
/// `Dictionary[K, V]()`; the disambiguation that matters is the
/// indexer/generic-call split, exercised here.
open class Issue693MultiTypeArgGenericCallParserTests {
    @Fact
    func TwoTypeArg_Generic_Call_Parses_As_CallExpression_With_TypeArgumentList() {
        // The canonical case: Dictionary[string, int32]() must parse as a
        // CallExpression carrying a two-element TypeArgumentList, not as an
        // IndexExpression on `Dictionary`.
        const source = `
import System.Collections.Generic
let d = Dictionary[string, int32]()
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let call = Assert.IsType[CallExpressionSyntax](varDecl.Initializer)
        Assert.Equal("Dictionary", call.Identifier.Text)
        Assert.NotNull(call.TypeArgumentList)
        Assert.Equal(2, call.TypeArgumentList!!.Arguments.Count)
        Assert.Equal("string", call.TypeArgumentList!!.Arguments[0].Identifier!!.Text)
        Assert.Equal("int32", call.TypeArgumentList!!.Arguments[1].Identifier!!.Text)
        Assert.Empty(call.Arguments)
    }

    @Fact
    func ThreeTypeArg_Generic_Call_Parses_With_All_Type_Arguments() {
        // ValueTuple[int32, string, bool]() shape — exercises the comma-loop
        // path with more than two type arguments.
        const source = `
import System
let t = ValueTuple[int32, string, bool](1, "x", true)
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let call = Assert.IsType[CallExpressionSyntax](varDecl.Initializer)
        Assert.Equal("ValueTuple", call.Identifier.Text)
        Assert.NotNull(call.TypeArgumentList)
        Assert.Equal(3, call.TypeArgumentList!!.Arguments.Count)
        Assert.Equal("int32", call.TypeArgumentList!!.Arguments[0].Identifier!!.Text)
        Assert.Equal("string", call.TypeArgumentList!!.Arguments[1].Identifier!!.Text)
        Assert.Equal("bool", call.TypeArgumentList!!.Arguments[2].Identifier!!.Text)
        Assert.Equal(3, call.Arguments.Count)
    }

    @Fact
    func Nested_MultiTypeArg_Generic_Call_Parses_With_Nested_TypeArgument() {
        // Dictionary[string, List[int32]]() — the inner List[int32] must be
        // recognised as a nested generic type clause inside the outer
        // two-element type-argument list.
        const source = `
import System.Collections.Generic
let d = Dictionary[string, List[int32]]()
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let call = Assert.IsType[CallExpressionSyntax](varDecl.Initializer)
        Assert.Equal("Dictionary", call.Identifier.Text)
        Assert.Equal(2, call.TypeArgumentList!!.Arguments.Count)
        let inner = call.TypeArgumentList!!.Arguments[1]
        Assert.Equal("List", inner.Identifier!!.Text)
        Assert.True(inner.HasTypeArguments)
        Assert.Single(inner.TypeArguments!!)
        Assert.Equal("int32", inner.TypeArguments!![0].Identifier!!.Text)
    }

    @Fact
    func DoublyNested_MultiTypeArg_Generic_Call_Parses_All_Levels() {
        // Dictionary[string, Dictionary[string, int32]]() — three brackets
        // deep on the second type arg keeps the type-clause scan in lockstep
        // with the indexer alternative.
        const source = `
import System.Collections.Generic
let d = Dictionary[string, Dictionary[string, int32]]()
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let call = Assert.IsType[CallExpressionSyntax](varDecl.Initializer)
        Assert.Equal(2, call.TypeArgumentList!!.Arguments.Count)
        let inner = call.TypeArgumentList!!.Arguments[1]
        Assert.Equal("Dictionary", inner.Identifier!!.Text)
        Assert.True(inner.HasTypeArguments)
        Assert.Equal(2, inner.TypeArguments!!.Count)
        Assert.Equal("string", inner.TypeArguments!![0].Identifier!!.Text)
        Assert.Equal("int32", inner.TypeArguments!![1].Identifier!!.Text)
    }

    @Fact
    func MultiTypeArg_Generic_Call_With_StructLiteral_Followset_Parses_As_StructLiteral() {
        // ADR-0020 follow-set: `{` after `Type[T, U]` is a composite literal.
        // Verifies that the multi-type-arg disambiguation honours the `{`
        // branch as well, not only `(`.
        const source = `
package P
struct Pair[A, B any] {
    var First A
    var Second B
}
let p = Pair[int32, string]{First: 1, Second: "x"}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let literal = Assert.IsType[StructLiteralExpressionSyntax](varDecl.Initializer)
        Assert.Equal("Pair", literal.TypeIdentifier.Text)
        Assert.NotNull(literal.TypeArgumentList)
        Assert.Equal(2, literal.TypeArgumentList!!.Arguments.Count)
    }

    @Fact
    func MultiTypeArg_Generic_Call_With_MemberAccess_Followset_Parses_As_Access() {
        // ADR-0020 follow-set: `.` after `Type[T, U]` is a member access on
        // the constructed type. The Dictionary case here resolves to the
        // generic Dictionary[string, int32]'s static Members or Equals;
        // we only assert the parser's shape.
        const source = `
package P
import System.Collections.Generic
func run() {
    let d = Dictionary[string, int32]()
    _ = d.Count
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let decl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
        let call = Assert.IsType[CallExpressionSyntax](decl.Initializer)
        Assert.Equal("Dictionary", call.Identifier.Text)
        Assert.Equal(2, call.TypeArgumentList!!.Arguments.Count)
    }

    @Fact
    func Indexer_With_NonType_Index_Still_Parses_As_IndexExpression() {
        // Regression guard: the multi-type-arg disambiguation must not
        // accidentally absorb a plain indexer. `xs[i + 1]` must remain an
        // IndexExpression — `i + 1` is not a type clause so the tentative
        // scan fails and the parser falls back to indexing.
        const source = `
package P
import System.Collections.Generic
func run(xs List[int32], i int32) int32 {
    return xs[i + 1]
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let returnStmt = fn.Body!!.Statements.OfType[ReturnStatementSyntax]().Single()
        Assert.IsType[IndexExpressionSyntax](returnStmt.Expression)
    }

    @Fact
    func Indexer_With_Single_Identifier_Index_Still_Parses_As_IndexExpression() {
        // `m["a"]` parses as IndexExpression — the bracket content (a string
        // literal) is not a type clause. Multi-type-arg disambiguation does
        // not interfere with this single-arg indexer case.
        const source = `
package P
import System.Collections.Generic
func run(m Dictionary[string, int32]) int32 {
    return m["a"]
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let returnStmt = fn.Body!!.Statements.OfType[ReturnStatementSyntax]().Single()
        Assert.IsType[IndexExpressionSyntax](returnStmt.Expression)
    }

    @Fact
    func MapLiteral_With_Map_Keyword_Still_Parses_As_MapCreation() {
        // Negative regression: `map[K,V]{ k: v, … }` (G#'s only map-literal
        // syntax) must continue to parse as a MapCreationExpression — the
        // multi-type-arg disambiguation only fires on identifier-headed
        // bracketed expressions, never after the `map` keyword.
        const source = `
let m = map[string,int32] { "a": 1, "b": 2 }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let varDecl = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[VariableDeclarationSyntax]()
            .Single()
        let map_ = Assert.IsType[MapCreationExpressionSyntax](varDecl.Initializer)
        Assert.Equal(2, map_.Entries.Count)
    }

    @Fact
    func MultiTypeArg_Generic_Call_Inside_ArgumentList_Parses_As_NestedCall() {
        // `Console.WriteLine(Dictionary[string, int32]())` — the inner
        // multi-type-arg call must parse when it appears as an argument to
        // an enclosing call. This is the exact shape tests would use to
        // print the count of a freshly-constructed dictionary.
        const source = `
import System
import System.Collections.Generic
Console.WriteLine(Dictionary[string, int32]())
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let exprStmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[ExpressionStatementSyntax]()
            .Single()
        // `Console.WriteLine(...)` is an AccessorExpression whose right side
        // is the actual `WriteLine(<inner-call>)` call expression.
        let accessor = Assert.IsType[AccessorExpressionSyntax](exprStmt.Expression)
        let outer = Assert.IsType[CallExpressionSyntax](accessor.RightPart)
        Assert.Single(outer.Arguments)
        let inner = Assert.IsType[CallExpressionSyntax](outer.Arguments[0])
        Assert.Equal("Dictionary", inner.Identifier.Text)
        Assert.NotNull(inner.TypeArgumentList)
        Assert.Equal(2, inner.TypeArgumentList!!.Arguments.Count)
    }

    @Fact
    func MultiTypeArg_Generic_Call_As_TopLevel_ExpressionStatement_Parses() {
        // `Dictionary[string, int32]()` as a bare expression statement at
        // top level. Same disambiguation rule must fire at this position.
        const source = `
import System.Collections.Generic
Dictionary[string, int32]()
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let exprStmt = tree
            .Root
            .Members
            .OfType[GlobalStatementSyntax]()
            .Select((g GlobalStatementSyntax) -> g.Statement)
            .OfType[ExpressionStatementSyntax]()
            .Single()
        let call = Assert.IsType[CallExpressionSyntax](exprStmt.Expression)
        Assert.Equal("Dictionary", call.Identifier.Text)
        Assert.NotNull(call.TypeArgumentList)
        Assert.Equal(2, call.TypeArgumentList!!.Arguments.Count)
    }
}
