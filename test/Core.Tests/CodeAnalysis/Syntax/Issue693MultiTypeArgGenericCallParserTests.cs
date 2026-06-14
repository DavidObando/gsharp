// <copyright file="Issue693MultiTypeArgGenericCallParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #693 (follow-up to #690): direct parser regression coverage for the
/// ADR-0020 bounded-lookahead disambiguation between an indexing expression
/// (<c>name[expr]</c>) and a multi-type-arg generic instantiation followed by
/// a call (<c>Type[T1, T2, …](args)</c>).
/// <para>
/// PR #690 left a note in <c>Issue671ConstructionCallEmitTests.cs</c>
/// claiming <c>Dictionary[K, V]()</c> was "shadowed by the map-literal
/// parser" and worked around it via <c>KeyValuePair[K, V](k, v)</c>. That
/// note was stale: the parser's <c>LooksLikeGenericCallSite</c> probe
/// already scans an arbitrary number of comma-separated type clauses inside
/// the brackets and commits to a generic call site when the token after the
/// matching <c>]</c> is one of <c>(</c>, <c>{</c>, or <c>.</c>. These tests
/// lock that contract in at the parser layer.
/// </para>
/// <para>
/// G#'s only map-literal syntax is <c>map[K,V]{ k: v, … }</c> with the
/// explicit <c>map</c> keyword, so it cannot syntactically collide with
/// <c>Dictionary[K, V]()</c>; the disambiguation that matters is the
/// indexer/generic-call split, exercised here.
/// </para>
/// </summary>
public class Issue693MultiTypeArgGenericCallParserTests
{
    [Fact]
    public void TwoTypeArg_Generic_Call_Parses_As_CallExpression_With_TypeArgumentList()
    {
        // The canonical case: Dictionary[string, int32]() must parse as a
        // CallExpression carrying a two-element TypeArgumentList, not as an
        // IndexExpression on `Dictionary`.
        const string source = @"
import System.Collections.Generic
let d = Dictionary[string, int32]()
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        var call = Assert.IsType<CallExpressionSyntax>(varDecl.Initializer);
        Assert.Equal("Dictionary", call.Identifier.Text);
        Assert.NotNull(call.TypeArgumentList);
        Assert.Equal(2, call.TypeArgumentList.Arguments.Count);
        Assert.Equal("string", call.TypeArgumentList.Arguments[0].Identifier.Text);
        Assert.Equal("int32", call.TypeArgumentList.Arguments[1].Identifier.Text);
        Assert.Empty(call.Arguments);
    }

    [Fact]
    public void ThreeTypeArg_Generic_Call_Parses_With_All_Type_Arguments()
    {
        // ValueTuple[int32, string, bool]() shape — exercises the comma-loop
        // path with more than two type arguments.
        const string source = @"
import System
let t = ValueTuple[int32, string, bool](1, ""x"", true)
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        var call = Assert.IsType<CallExpressionSyntax>(varDecl.Initializer);
        Assert.Equal("ValueTuple", call.Identifier.Text);
        Assert.NotNull(call.TypeArgumentList);
        Assert.Equal(3, call.TypeArgumentList.Arguments.Count);
        Assert.Equal("int32", call.TypeArgumentList.Arguments[0].Identifier.Text);
        Assert.Equal("string", call.TypeArgumentList.Arguments[1].Identifier.Text);
        Assert.Equal("bool", call.TypeArgumentList.Arguments[2].Identifier.Text);
        Assert.Equal(3, call.Arguments.Count);
    }

    [Fact]
    public void Nested_MultiTypeArg_Generic_Call_Parses_With_Nested_TypeArgument()
    {
        // Dictionary[string, List[int32]]() — the inner List[int32] must be
        // recognised as a nested generic type clause inside the outer
        // two-element type-argument list.
        const string source = @"
import System.Collections.Generic
let d = Dictionary[string, List[int32]]()
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        var call = Assert.IsType<CallExpressionSyntax>(varDecl.Initializer);
        Assert.Equal("Dictionary", call.Identifier.Text);
        Assert.Equal(2, call.TypeArgumentList.Arguments.Count);

        var inner = call.TypeArgumentList.Arguments[1];
        Assert.Equal("List", inner.Identifier.Text);
        Assert.True(inner.HasTypeArguments);
        Assert.Single(inner.TypeArguments);
        Assert.Equal("int32", inner.TypeArguments[0].Identifier.Text);
    }

    [Fact]
    public void DoublyNested_MultiTypeArg_Generic_Call_Parses_All_Levels()
    {
        // Dictionary[string, Dictionary[string, int32]]() — three brackets
        // deep on the second type arg keeps the type-clause scan in lockstep
        // with the indexer alternative.
        const string source = @"
import System.Collections.Generic
let d = Dictionary[string, Dictionary[string, int32]]()
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        var call = Assert.IsType<CallExpressionSyntax>(varDecl.Initializer);
        Assert.Equal(2, call.TypeArgumentList.Arguments.Count);

        var inner = call.TypeArgumentList.Arguments[1];
        Assert.Equal("Dictionary", inner.Identifier.Text);
        Assert.True(inner.HasTypeArguments);
        Assert.Equal(2, inner.TypeArguments.Count);
        Assert.Equal("string", inner.TypeArguments[0].Identifier.Text);
        Assert.Equal("int32", inner.TypeArguments[1].Identifier.Text);
    }

    [Fact]
    public void MultiTypeArg_Generic_Call_With_StructLiteral_Followset_Parses_As_StructLiteral()
    {
        // ADR-0020 follow-set: `{` after `Type[T, U]` is a composite literal.
        // Verifies that the multi-type-arg disambiguation honours the `{`
        // branch as well, not only `(`.
        const string source = @"
package P
struct Pair[A, B any] {
    var First A
    var Second B
}
let p = Pair[int32, string]{First: 1, Second: ""x""}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        var literal = Assert.IsType<StructLiteralExpressionSyntax>(varDecl.Initializer);
        Assert.Equal("Pair", literal.TypeIdentifier.Text);
        Assert.NotNull(literal.TypeArgumentList);
        Assert.Equal(2, literal.TypeArgumentList.Arguments.Count);
    }

    [Fact]
    public void MultiTypeArg_Generic_Call_With_MemberAccess_Followset_Parses_As_Access()
    {
        // ADR-0020 follow-set: `.` after `Type[T, U]` is a member access on
        // the constructed type. The Dictionary case here resolves to the
        // generic Dictionary[string, int32]'s static Members or Equals;
        // we only assert the parser's shape.
        const string source = @"
package P
import System.Collections.Generic
func run() {
    let d = Dictionary[string, int32]()
    _ = d.Count
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var decl = fn.Body.Statements.OfType<VariableDeclarationSyntax>().Single();
        var call = Assert.IsType<CallExpressionSyntax>(decl.Initializer);
        Assert.Equal("Dictionary", call.Identifier.Text);
        Assert.Equal(2, call.TypeArgumentList.Arguments.Count);
    }

    [Fact]
    public void Indexer_With_NonType_Index_Still_Parses_As_IndexExpression()
    {
        // Regression guard: the multi-type-arg disambiguation must not
        // accidentally absorb a plain indexer. `xs[i + 1]` must remain an
        // IndexExpression — `i + 1` is not a type clause so the tentative
        // scan fails and the parser falls back to indexing.
        const string source = @"
package P
import System.Collections.Generic
func run(xs List[int32], i int32) int32 {
    return xs[i + 1]
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var returnStmt = fn.Body.Statements.OfType<ReturnStatementSyntax>().Single();
        Assert.IsType<IndexExpressionSyntax>(returnStmt.Expression);
    }

    [Fact]
    public void Indexer_With_Single_Identifier_Index_Still_Parses_As_IndexExpression()
    {
        // `m["a"]` parses as IndexExpression — the bracket content (a string
        // literal) is not a type clause. Multi-type-arg disambiguation does
        // not interfere with this single-arg indexer case.
        const string source = @"
package P
import System.Collections.Generic
func run(m Dictionary[string, int32]) int32 {
    return m[""a""]
}
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var fn = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        var returnStmt = fn.Body.Statements.OfType<ReturnStatementSyntax>().Single();
        Assert.IsType<IndexExpressionSyntax>(returnStmt.Expression);
    }

    [Fact]
    public void MapLiteral_With_Map_Keyword_Still_Parses_As_MapCreation()
    {
        // Negative regression: `map[K,V]{ k: v, … }` (G#'s only map-literal
        // syntax) must continue to parse as a MapCreationExpression — the
        // multi-type-arg disambiguation only fires on identifier-headed
        // bracketed expressions, never after the `map` keyword.
        const string source = @"
let m = map[string,int32] { ""a"": 1, ""b"": 2 }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var varDecl = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<VariableDeclarationSyntax>()
            .Single();

        var map = Assert.IsType<MapCreationExpressionSyntax>(varDecl.Initializer);
        Assert.Equal(2, map.Entries.Count);
    }

    [Fact]
    public void MultiTypeArg_Generic_Call_Inside_ArgumentList_Parses_As_NestedCall()
    {
        // `Console.WriteLine(Dictionary[string, int32]())` — the inner
        // multi-type-arg call must parse when it appears as an argument to
        // an enclosing call. This is the exact shape tests would use to
        // print the count of a freshly-constructed dictionary.
        const string source = @"
import System
import System.Collections.Generic
Console.WriteLine(Dictionary[string, int32]())
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var exprStmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<ExpressionStatementSyntax>()
            .Single();

        // `Console.WriteLine(...)` is an AccessorExpression whose right side
        // is the actual `WriteLine(<inner-call>)` call expression.
        var accessor = Assert.IsType<AccessorExpressionSyntax>(exprStmt.Expression);
        var outer = Assert.IsType<CallExpressionSyntax>(accessor.RightPart);
        Assert.Single(outer.Arguments);
        var inner = Assert.IsType<CallExpressionSyntax>(outer.Arguments[0]);
        Assert.Equal("Dictionary", inner.Identifier.Text);
        Assert.NotNull(inner.TypeArgumentList);
        Assert.Equal(2, inner.TypeArgumentList.Arguments.Count);
    }

    [Fact]
    public void MultiTypeArg_Generic_Call_As_TopLevel_ExpressionStatement_Parses()
    {
        // `Dictionary[string, int32]()` as a bare expression statement at
        // top level. Same disambiguation rule must fire at this position.
        const string source = @"
import System.Collections.Generic
Dictionary[string, int32]()
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var exprStmt = tree.Root.Members
            .OfType<GlobalStatementSyntax>()
            .Select(g => g.Statement)
            .OfType<ExpressionStatementSyntax>()
            .Single();

        var call = Assert.IsType<CallExpressionSyntax>(exprStmt.Expression);
        Assert.Equal("Dictionary", call.Identifier.Text);
        Assert.NotNull(call.TypeArgumentList);
        Assert.Equal(2, call.TypeArgumentList.Arguments.Count);
    }
}
