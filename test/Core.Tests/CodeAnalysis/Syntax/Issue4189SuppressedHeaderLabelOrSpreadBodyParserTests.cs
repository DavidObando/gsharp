// <copyright file="Issue4189SuppressedHeaderLabelOrSpreadBodyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #4189: a suppressed body-header identifier (an <c>if</c>/<c>while</c>
/// condition, a <c>for-in</c> collection, or a C-style <c>for</c>'s post
/// clause) immediately followed by a NON-empty <c>{ ... }</c> whose first
/// token happens to look like a struct-literal field — a label
/// (<c>retry:</c>) or a spread (<c>...</c>) — must still parse that brace as
/// the statement's own body, not as a struct literal.
/// <para>
/// <see cref="Parser.StructLiteralAllowedInSuppressedHeader"/> previously
/// treated ANY non-empty brace content as unambiguously a struct literal
/// (issue #1575's design assumed <c>{ Ident : … }</c> could never open a
/// body). That assumption breaks for a label — whose spelling
/// (<c>Identifier ColonToken</c>) is byte-for-byte the same as a struct
/// literal's first field — and for a spread — which is also legal
/// struct-literal syntax. The fix generalizes the existing empty-brace
/// disambiguation (issue #1575): scan to the CANDIDATE brace's matching
/// close, and only admit the struct-literal reading when what follows really
/// continues an expression (a binary/postfix operator, …) or opens a genuine
/// second body brace (<c>Ident{} { … }</c>'s two-brace-pair shape) — exactly
/// the same test the empty-brace case already applied via
/// <c>Peek(braceOffset + 2) == OpenBraceToken</c>. When neither holds, this
/// single <c>{ ... }</c> must be the statement's own body, because a
/// suppressed header's enclosing statement always requires one and none
/// would otherwise be left to satisfy that requirement.
/// </para>
/// </summary>
public class Issue4189SuppressedHeaderLabelOrSpreadBodyParserTests
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
    public void If_Condition_With_LabeledBreak_Body_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { func F(flag bool) { if flag { retry: break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifStatement = Descendants(tree.Root).OfType<IfStatementSyntax>().Single();
        Assert.IsNotType<StructLiteralExpressionSyntax>(ifStatement.Condition);
        Assert.Empty(Descendants(ifStatement.Condition).OfType<StructLiteralExpressionSyntax>());

        var labeled = Descendants(ifStatement.ThenStatement).OfType<LabeledStatementSyntax>().Single();
        Assert.Equal("retry", labeled.LabelIdentifier.Text);
    }

    [Fact]
    public void While_Condition_With_LabeledBreak_Body_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { func F(flag bool) { while flag { retry: break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var whileStatement = Descendants(tree.Root).OfType<WhileStatementSyntax>().Single();
        Assert.Empty(Descendants(whileStatement.Condition).OfType<StructLiteralExpressionSyntax>());

        var labeled = Descendants(whileStatement.Body).OfType<LabeledStatementSyntax>().Single();
        Assert.Equal("retry", labeled.LabelIdentifier.Text);
    }

    [Fact]
    public void ForIn_Collection_With_LabeledBreak_Body_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { func F(xs []int32) { for x in xs { retry: break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forIn = Descendants(tree.Root).OfType<ForRangeStatementSyntax>().Single();
        Assert.Empty(Descendants(forIn.Collection).OfType<StructLiteralExpressionSyntax>());

        var labeled = Descendants(forIn.Body).OfType<LabeledStatementSyntax>().Single();
        Assert.Equal("retry", labeled.LabelIdentifier.Text);
    }

    [Fact]
    public void ForClause_Post_With_LabeledBreak_Body_Parses_Without_Diagnostics()
    {
        const string source = @"
package p
class C { var Next C? }
class D { func F(s C?) { for var c C? = s; c != nil; c = c!!.Next { retry: break } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var forClause = Descendants(tree.Root).OfType<ForClauseStatementSyntax>().Single();
        Assert.NotNull(forClause.Post);
        Assert.Empty(Descendants(forClause.Post!).OfType<StructLiteralExpressionSyntax>());

        var labeled = Descendants(forClause.Body).OfType<LabeledStatementSyntax>().Single();
        Assert.Equal("retry", labeled.LabelIdentifier.Text);
    }

    [Fact]
    public void ForIn_Collection_SpreadLed_TwoBraceShape_Still_Parses_As_StructLiteral()
    {
        // A spread (`...`) is also legal struct-literal syntax (a spread base
        // value), so — unlike a label — it can never collide with a body
        // statement start (no G# statement begins with a bare `...`). This
        // locks in that the generalized fix still recognizes a spread-led
        // struct literal collection followed by the for-in's own, separate
        // body brace (the two-brace-pair shape), exercising the new
        // matching-close-brace scan with Ellipsis-led content specifically.
        const string source = @"
package p
data struct Pt { let X int32 }
class Numbers { var X int32
 func GetEnumerator() NumberEnum { return NumberEnum() } }
class NumberEnum { func MoveNext() bool { return false }
 func Current() int32 { return 0 } }
class C { func F(other Pt) { for v in Numbers{...other, X: 1} { var y = v } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Numbers", structLiteral.TypeIdentifier.Text);
        Assert.NotNull(structLiteral.SpreadExpression);
    }

    [Fact]
    public void EmptyBody_After_BareIdentifier_Condition_Still_Parses_As_Condition()
    {
        // Regression guard (#1575): a genuinely empty body must remain
        // untouched by this fix — it never reaches the new non-empty path.
        const string source = @"
package p
class C { func F(disposing bool) { if disposing { } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifStatement = Descendants(tree.Root).OfType<IfStatementSyntax>().Single();
        Assert.IsNotType<StructLiteralExpressionSyntax>(ifStatement.Condition);
    }

    [Fact]
    public void NonSuppressed_StructLiteral_With_LabelShapedField_Still_Parses_As_StructLiteral()
    {
        // Regression guard: outside a suppressed header, `Pt{X: 1}` (whose
        // first field has the identical `Identifier :` shape as a label) must
        // still parse as an ordinary struct literal.
        const string source = @"
package p
data struct Pt { let X int32 }
class C { func F() { var p = Pt{X: 1} } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text);
    }

    [Fact]
    public void NonEmptyStructLiteral_At_Start_Of_Condition_Still_Parses()
    {
        // Regression guard (#1575): a non-empty struct literal that is
        // followed by MORE expression content (not immediately the body)
        // remains a struct literal — the fix must not blanket-suppress every
        // label-shaped brace, only the ones where no continuation follows.
        const string source = @"
package p
data struct Pt { let X int32 }
class C { func F(p Pt) { if Pt{X: 1} == p { } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text);
    }

    [Fact]
    public void TwoBraceShape_NonEmptyStructLiteral_Followed_By_RealBody_Still_Parses_As_StructLiteral()
    {
        // A non-empty, label-shaped struct literal immediately followed by a
        // SECOND, genuine body brace (the two-brace-pair shape) must still be
        // recognized as a struct literal — this mirrors the existing empty
        // `Numbers{} { … }` for-in carve-out, generalized to non-empty content.
        const string source = @"
package p
class Counters { var X int32
 func GetEnumerator() CounterEnum { return CounterEnum() } }
class CounterEnum { func MoveNext() bool { return false }
 func Current() int32 { return 0 } }
class C { func F() { for v in Counters{X: 1} { var y = v } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Counters", structLiteral.TypeIdentifier.Text);
    }

    [Fact]
    public void TernaryTrueArm_LabelShapedStructLiteral_In_ForIn_Collection_Still_Parses()
    {
        // A label-shaped struct literal that is only a SUB-expression — here,
        // a ternary's true arm — must stay a struct literal even though the
        // token right after its matching `}` is `:` (the ternary's own
        // separator), not a further body brace. `:` is not itself a binary/
        // postfix operator, so it needs its own carve-out alongside
        // IsExpressionContinuation's operator set.
        const string source = @"
package p
class Counters { var X int32
 func GetEnumerator() CounterEnum { return CounterEnum() } }
class CounterEnum { func MoveNext() bool { return false }
 func Current() int32 { return 0 } }
class C { func F(flag bool, other Counters) { for v in flag ? Counters{X: 1} : other { var y = v } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Counters", structLiteral.TypeIdentifier.Text);
    }
}
