// <copyright file="Issue1575EmptyBodyConditionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1575: an <c>if</c> / <c>while</c> / <c>for</c> statement whose
/// controlling expression is a bare identifier (or any composite-literal-shaped
/// expression) immediately followed by an EMPTY body <c>{ }</c> must parse the
/// identifier as the condition and let <c>{ }</c> open the (empty) body — it
/// must NOT be mis-parsed as an empty struct literal (<c>Ident{}</c>), which
/// previously surfaced a spurious <c>GS0157</c>.
/// <para>
/// A non-empty body already backtracked correctly; only the empty <c>{ }</c>
/// slipped through because the struct-literal lookahead accepts <c>{}</c>. The
/// body-header context now suppresses the bare struct-literal form (as it
/// already did the trailing <c>Call() { … }</c> form), while the fresh inner
/// contexts (parentheses, argument lists, indexers, collection/object-literal
/// element values) still admit a struct literal so <c>(Pt{X: 1})</c> and
/// <c>Foo(Pt{X: 1})</c> keep working inside a condition.
/// </para>
/// </summary>
public class Issue1575EmptyBodyConditionParserTests
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
    public void If_With_BareIdentifier_Condition_And_EmptyBody_Parses_As_Condition()
    {
        const string source = @"
package p
class C { func F(disposing bool) { if disposing { } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifStatement = Descendants(tree.Root).OfType<IfStatementSyntax>().Single();

        // The condition must be a plain name reference, not a struct literal.
        Assert.Empty(Descendants(ifStatement.Condition).OfType<StructLiteralExpressionSyntax>());
        Assert.IsNotType<StructLiteralExpressionSyntax>(ifStatement.Condition);
    }

    [Fact]
    public void While_With_BareIdentifier_Condition_And_EmptyBody_Parses_As_Condition()
    {
        const string source = @"
package p
class C { func F(disposing bool) { while disposing { } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var whileStatement = Descendants(tree.Root).OfType<WhileStatementSyntax>().Single();
        Assert.Empty(Descendants(whileStatement.Condition).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void If_With_EmptyBody_Followed_By_Block_Parses_As_Condition()
    {
        // #1580 (follow-up): the empty-body `if` is immediately followed by a
        // block statement. The identifier is still the condition and `{}` the
        // empty body — the trailing block must NOT be consumed as the `if`
        // condition's struct-literal body (`if (disposing{}) { .. }`).
        const string source = @"
package p
class C { func F(disposing bool) { if disposing { } { var y = 2 } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var ifStatement = Descendants(tree.Root).OfType<IfStatementSyntax>().Single();
        Assert.Empty(Descendants(ifStatement.Condition).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void While_With_EmptyBody_Followed_By_Block_Parses_As_Condition()
    {
        const string source = @"
package p
class C { func F(disposing bool) { while disposing { } { var y = 2 } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var whileStatement = Descendants(tree.Root).OfType<WhileStatementSyntax>().Single();
        Assert.Empty(Descendants(whileStatement.Condition).OfType<StructLiteralExpressionSyntax>());
    }

    [Fact]
    public void ParenthesizedStructLiteral_In_Condition_Still_Parses()
    {
        // Regression guard: a struct literal inside parentheses is a fresh inner
        // context, so it is still recognised even in a body-header condition.
        const string source = @"
package p
data struct Pt { let X int32 }
class C { func F(p Pt) { if p == (Pt{X: 1}) { } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text);
    }

    [Fact]
    public void StructLiteral_As_CallArgument_In_Condition_Still_Parses()
    {
        const string source = @"
package p
data struct Pt { let X int32 }
class C {
 func Check(p Pt) bool { return p.X > 0 }
 func F() { if Check(Pt{X: 1}) { } var x = 1 } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text);
    }

    [Fact]
    public void BareStructLiteral_In_Expression_Position_Still_Parses()
    {
        // The suppression must apply ONLY in statement-header controlling
        // expressions; ordinary expression position still parses a struct literal.
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
    public void EmptyStructLiteral_As_ForIn_Collection_Followed_By_Body_Still_Parses()
    {
        // Regression guard for the inverse case: an EMPTY struct literal that IS
        // a `for-in` collection is followed by a real body `{`, so it must remain
        // a struct literal (`for v in Numbers{} { .. }`), not be split into an
        // identifier collection with an empty body.
        const string source = @"
package p
class Numbers { func GetEnumerator() NumberEnum { return NumberEnum() } }
class NumberEnum { func MoveNext() bool { return false }
 func Current() int32 { return 0 } }
class C { func F() { for v in Numbers{} { var x = v } } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var structLiteral = Descendants(tree.Root).OfType<StructLiteralExpressionSyntax>().Single();
        Assert.Equal("Numbers", structLiteral.TypeIdentifier.Text);
    }

    [Fact]
    public void NonEmptyStructLiteral_At_Start_Of_Condition_Still_Parses()
    {
        // A non-empty struct literal is unambiguous even as the head of a
        // condition (`{ Ident : .. }` cannot open a body), so `if Pt{X: 1} == p`
        // keeps parsing `Pt{X: 1}` as a struct literal.
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
}
