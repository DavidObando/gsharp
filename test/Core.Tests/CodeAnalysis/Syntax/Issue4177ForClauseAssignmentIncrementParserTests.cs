// <copyright file="Issue4177ForClauseAssignmentIncrementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #4177: a C-style <c>for</c> whose increment (post) clause is a
/// general assignment expression (not <c>++</c>/<c>--</c>, including a
/// compound assignment such as <c>+=</c>) and ends in a bare identifier —
/// <c>c = c.Next</c>, <c>c = s</c>, <c>c += d</c> — must let the loop body's
/// <c>{</c> open the body. #1023 already suppressed the OBJECT-initializer
/// wrap for an indexer-/call-tailed post (<see cref="Issue1023ForIndexerHeaderParserTests"/>),
/// but left the sibling STRUCT-literal check (<c>ParseNameOrCallExpression</c>'s
/// <c>Identifier {</c> shape, gated by the separate <c>suppressStructLiteral</c>
/// counter) unsuppressed. An EMPTY body right after such a post clause was
/// mis-parsed as that identifier's (empty) struct-literal initializer,
/// swallowing the body's opening brace and producing a stray, unparseable
/// closing brace downstream. A body whose first statement happens to look
/// like a struct-literal field (a label, <c>retry:</c>, or a spread,
/// <c>...</c>) is a DIFFERENT, pre-existing ambiguity this fix does not
/// close — <c>StructLiteralAllowedInSuppressedHeader</c> treats any
/// non-empty brace content as unambiguously a struct literal regardless of
/// suppression, identically for <c>if</c>/<c>while</c>/<c>for</c>-in too;
/// tracked separately as issue #4189.
/// </summary>
public sealed class Issue4177ForClauseAssignmentIncrementParserTests
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
    public void ForClause_Post_SimpleAssignment_Ending_In_MemberAccess_With_Empty_Body_Parses()
    {
        // The exact translated shape from issue #4177's repro
        // (`for (var c = s; c != null; c = c.Next) { }`).
        const string source = @"
package p
class C { var Next C? }
class D { func F(s C?) { for var c C? = s; c != nil; c = c!!.Next { } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.NotNull(forClause.Post);
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Empty(((BlockStatementSyntax)forClause.Body).Statements);

        // No part of the header may have been reinterpreted as a struct literal.
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
        Assert.Contains(Descendants(forClause.Post), n => n is AssignmentExpressionSyntax);
    }

    [Fact]
    public void ForClause_Post_SimpleAssignment_Ending_In_Bare_Identifier_With_Empty_Body_Parses()
    {
        const string source = @"
package p
class C { func F(s C?) { for var c C? = s; c != nil; c = s { } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void ForClause_Post_SimpleAssignment_Ending_In_MemberAccess_With_NonEmpty_Body_Parses()
    {
        // Regression control: a non-empty body already dodged the bug (its
        // first token is never the struct-literal-triggering `}`/`...`/
        // `Identifier:` shapes) — confirm the fix doesn't disturb it.
        const string source = @"
package p
class C { var Next C? }
class D { func F(s C?) { for var c C? = s; c != nil; c = c!!.Next { print(c) } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Single(((BlockStatementSyntax)forClause.Body).Statements);
    }

    [Fact]
    public void ForClause_Post_CompoundAssignment_Ending_In_Identifier_With_Empty_Body_Parses()
    {
        // A compound assignment (`+=`) whose RHS is a bare identifier hits the
        // exact same `Identifier {` shape as simple assignment — confirm the
        // fix isn't scoped to `=` specifically.
        const string source = @"
package p
class C { func F() { var d = 1
    for var c = 0; c < 10; c += d { } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void GenericCompositeLiteral_In_Expression_Position_Still_Parses_As_StructLiteral()
    {
        // Regression guard: the suppression must apply ONLY to the for-clause
        // post header, not to ordinary expression position.
        const string source = @"
package p
class Box { var Value int32 }
class C { func F() { var b = Box{Value: 42} } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Box", structLiteral.TypeIdentifier.Text);
        Assert.Single(structLiteral.Initializers);
    }
}
