// <copyright file="Issue1023ForIndexerHeaderParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1023: a C-style <c>for</c> whose increment (or condition) ends in an
/// indexer (<c>expr[i]</c>) immediately before the body <c>{</c> must bind the
/// <c>[i]</c> as an indexer and let <c>{</c> open the loop body — it must NOT
/// be mis-parsed as the generic-composite literal shape <c>name[args] { … }</c>.
/// <para>
/// The shared Go-style suppression that already blocks <c>Type { … }</c> and
/// <c>Call() { … }</c> in statement-header controlling expressions
/// (<c>if</c>/<c>while</c>/<c>for</c> clauses, <c>switch</c>/<c>match</c>
/// subject) is now also honoured by <c>LooksLikeGenericCallSite</c> for the
/// trailing <c>{</c> follow-set marker. These tests lock that contract in at
/// the parser layer and guard against regressing legitimate composite-literal
/// parsing in expression position.
/// </para>
/// </summary>
public class Issue1023ForIndexerHeaderParserTests
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
    public void ForClause_Post_Ending_In_Indexer_Parses_Without_Diagnostics()
    {
        // The canonical repro from the issue.
        const string source = @"
package p
class C { func F(arr []int32) { for var s = 0; s < arr.Length; s += arr[s] { var x = 1 } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();

        // The post must be `s += arr[s]` (an indexer-tailed assignment), and the
        // body must be a real block — not swallowed by a composite literal.
        Assert.NotNull(forClause.Post);
        Assert.IsType<BlockStatementSyntax>(forClause.Body);

        // No part of the header may have been reinterpreted as a struct literal.
        Assert.Empty(Descendants(forClause.Post).OfType<StructLiteralExpressionSyntax>());
        Assert.Contains(Descendants(forClause.Post), n => n is IndexExpressionSyntax);
    }

    [Fact]
    public void ForClause_Condition_Ending_In_Indexer_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { func F(arr []int32) { for var i = 0; arr[i] > 0; i = i + 1 { break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forClause.Body);
        Assert.Contains(Descendants(forClause.Condition), n => n is IndexExpressionSyntax);
    }

    [Fact]
    public void ForCondition_Form_Ending_In_Indexer_Parses_Without_Diagnostics()
    {
        // The condition-only `for cond { … }` form whose condition ends in an
        // indexer must also let `{` open the body.
        const string source = @"
package p
class C { func F(arr []bool) { for arr[0] { break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forCond = Descendants(tree.Root).OfType<ForConditionStatementSyntax>().Single();
        Assert.IsType<BlockStatementSyntax>(forCond.Body);
    }

    [Fact]
    public void If_With_Indexer_Tailed_Condition_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { func F(arr []int32) { if arr[0] > 0 { var x = 1 } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void While_With_Indexer_Tailed_Condition_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { func F(arr []int32) { while arr[0] > 0 { break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void GenericCompositeLiteral_In_Expression_Position_Still_Parses_As_StructLiteral()
    {
        // Regression guard: the suppression must apply ONLY in statement-header
        // controlling-expression contexts. In ordinary expression position a
        // `name[args] { … }` shape is still a generic composite literal.
        const string source = @"
package p
class Box[T] { var Value T }
class C { func F() { var b = Box[int32]{Value: 42} } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Box", structLiteral.TypeIdentifier.Text);
        Assert.NotNull(structLiteral.TypeArgumentList);
        Assert.Single(structLiteral.Initializers);
    }

    [Fact]
    public void BareStructLiteral_In_Expression_Position_Still_Parses()
    {
        const string source = @"
package p
class Point { var X int32
 var Y int32 }
class C { func F() { var p = Point{X: 1, Y: 2} } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Point", structLiteral.TypeIdentifier.Text);
        Assert.Equal(2, structLiteral.Initializers.Count);
    }
}
