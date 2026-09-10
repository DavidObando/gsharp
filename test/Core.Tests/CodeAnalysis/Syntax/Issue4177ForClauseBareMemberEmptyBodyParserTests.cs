// <copyright file="Issue4177ForClauseBareMemberEmptyBodyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #4177: a C-style <c>for</c> whose POST clause is an assignment
/// expression ending in a bare member name (<c>c = c!!.Next</c>), immediately
/// followed by an EMPTY loop body (<c>{ }</c>), must let the empty <c>{ }</c>
/// open the loop body — it must NOT be mis-parsed as an empty struct literal
/// applied to the member name (<c>Next{ }</c>).
/// <para>
/// <see cref="Parser.ParseForClauseStatement"/>'s post-clause already
/// suppressed the composite-literal wrap (<c>suppressTrailingObjectInitializer</c>,
/// issue #1023) for a CALL- or INDEXER-tailed post, but never suppressed the
/// separate BARE struct-literal form (<c>suppressStructLiteral</c>) that a
/// plain member-access-ending post can trigger — the same ambiguity
/// <c>ParseExpressionInBodyHeader</c> already resolves for <c>if</c>/
/// <c>while</c>/for-range headers (issue #1575). Without the fix, the empty
/// <c>{ }</c> loop body brace pair is consumed as <c>Next{ }</c>, leaving the
/// parser desynced on whatever follows (surfacing as an unrelated
/// "expected &lt;IdentifierToken&gt;" diagnostic at the next real token).
/// </para>
/// <para>
/// Found while migrating <c>test/InternalAnalyzers.Tests/BaseClassCycleUnsafeWalkAnalyzerTests.cs</c>
/// (issue #4190): <c>for (var c = s.BaseClass; c != null; c = c.BaseClass) { }</c>
/// translates to exactly this shape once cs2gs's nullable bridge inserts
/// <c>!!</c> on the receiver.
/// </para>
/// </summary>
public class Issue4177ForClauseBareMemberEmptyBodyParserTests
{
    private static IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            yield return child;
            foreach (var d in Descendants(child))
            {
                yield return d;
            }
        }
    }

    [Fact]
    public void ForClause_Post_Ending_In_BareMember_With_EmptyBody_Parses_Without_Diagnostics()
    {
        // The canonical #4177 repro (post-fix, once the nullable bridge has
        // already inserted `!!`).
        const string source = @"
package p
class C { func M(s C) { for var c C? = s; c != nil; c = c!!.Next { } } var Next C }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.NotNull(forClause.Post);
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Empty(((BlockStatementSyntax)forClause.Body).Statements);

        // No part of the post may have been reinterpreted as a struct literal.
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void ForClause_Post_Ending_In_BareMember_Without_BangBang_With_EmptyBody_Parses_Without_Diagnostics()
    {
        // The same shape without the nullable-bridge `!!` — the ambiguity is
        // about a bare member name directly abutting `{ }`, not about `!!`.
        const string source = @"
package p
class C { func M(s C) { for var c = s; c != nil; c = c.Next { } } var Next C }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Empty(((BlockStatementSyntax)forClause.Body).Statements);
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void ForClause_Post_Ending_In_BareMember_With_NonEmptyBody_Parses_Without_Diagnostics()
    {
        // A NON-empty body was never ambiguous (IsStructLiteralFollowingBrace
        // requires an immediate `}`, spread, or `Identifier :`) — locks that
        // in so the fix is understood as scoped to the empty-body collision.
        const string source = @"
package p
class C { func M(s C) { for var c = s; c != nil; c = c.Next { Console.WriteLine(1) } } var Next C }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Single(((BlockStatementSyntax)forClause.Body).Statements);
    }

    [Fact]
    public void ForClause_Post_NonEmpty_StructLiteral_StillParses_AsStructLiteral()
    {
        // Regression guard: StructLiteralAllowedInSuppressedHeader still
        // admits a NON-empty struct literal post (unambiguous — `{ Ident :`
        // can never open a body) — the fix must not blanket-suppress every
        // struct literal in this position, only the empty/body-colliding one.
        const string source = @"
package p
class Pt { var X int32 }
class C { func M() { for var i = 0; i < 3; result = Pt{X: i} { } } var result Pt }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Contains(Descendants(forClause.Post), n => n is StructLiteralExpressionSyntax);
    }

    [Fact]
    public void ForClause_Post_Indexer_Tailed_StillParses_AsIndexer()
    {
        // Regression guard for the pre-existing #1023 fix this shares a
        // helper with: an indexer-tailed post must still bind the `[i]` as
        // an indexer, not be disturbed by the new struct-literal suppression.
        const string source = @"
package p
class C { func F(arr []int32) { for var s = 0; s < arr.Length; s += arr[s] { var x = 1 } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
        Assert.Contains(Descendants(forClause.Post), n => n is IndexExpressionSyntax);
    }
}
