// <copyright file="Issue1575EmptyBodyConditionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1575: an `if` / `while` / `for` statement whose
/// controlling expression is a bare identifier (or any composite-literal-shaped
/// expression) immediately followed by an EMPTY body `{ }` must parse the
/// identifier as the condition and let `{ }` open the (empty) body — it
/// must NOT be mis-parsed as an empty struct literal (`Ident{}`), which
/// previously surfaced a spurious `GS0157`.
///
/// A non-empty body already backtracked correctly; only the empty `{ }`
/// slipped through because the struct-literal lookahead accepts `{}`. The
/// body-header context now suppresses the bare struct-literal form (as it
/// already did the trailing `Call() { … }` form), while the fresh inner
/// contexts (parentheses, argument lists, indexers, collection/object-literal
/// element values) still admit a struct literal so `(Pt{X: 1})` and
/// `Foo(Pt{X: 1})` keep working inside a condition.
open class Issue1575EmptyBodyConditionParserTests {
    @Fact
    func If_With_BareIdentifier_Condition_And_EmptyBody_Parses_As_Condition() {
        const source = `
package p
class C { func F(disposing bool) { if disposing { } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let ifStatement = Descendants(tree.Root).OfType[IfStatementSyntax]().Single()
        // The condition must be a plain name reference, not a struct literal.
        Assert.Empty(Descendants(ifStatement.Condition).OfType[StructLiteralExpressionSyntax]())
        Assert.IsNotType[StructLiteralExpressionSyntax](ifStatement.Condition)
    }

    @Fact
    func While_With_BareIdentifier_Condition_And_EmptyBody_Parses_As_Condition() {
        const source = `
package p
class C { func F(disposing bool) { while disposing { } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let whileStatement = Descendants(tree.Root).OfType[WhileStatementSyntax]().Single()
        Assert.Empty(Descendants(whileStatement.Condition).OfType[StructLiteralExpressionSyntax]())
    }

    @Fact
    func If_With_EmptyBody_Followed_By_Block_Parses_As_Condition() {
        // #1580 (follow-up): the empty-body `if` is immediately followed by a
        // block statement. The identifier is still the condition and `{}` the
        // empty body — the trailing block must NOT be consumed as the `if`
        // condition's struct-literal body (`if (disposing{}) { .. }`).
        const source = `
package p
class C { func F(disposing bool) { if disposing { } { var y = 2 } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let ifStatement = Descendants(tree.Root).OfType[IfStatementSyntax]().Single()
        Assert.Empty(Descendants(ifStatement.Condition).OfType[StructLiteralExpressionSyntax]())
    }

    @Fact
    func While_With_EmptyBody_Followed_By_Block_Parses_As_Condition() {
        const source = `
package p
class C { func F(disposing bool) { while disposing { } { var y = 2 } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let whileStatement = Descendants(tree.Root).OfType[WhileStatementSyntax]().Single()
        Assert.Empty(Descendants(whileStatement.Condition).OfType[StructLiteralExpressionSyntax]())
    }

    @Fact
    func ParenthesizedStructLiteral_In_Condition_Still_Parses() {
        // Regression guard: a struct literal inside parentheses is a fresh inner
        // context, so it is still recognised even in a body-header condition.
        const source = `
package p
data struct Pt { let X int32 }
class C { func F(p Pt) { if p == (Pt{X: 1}) { } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text)
    }

    @Fact
    func StructLiteral_As_CallArgument_In_Condition_Still_Parses() {
        const source = `
package p
data struct Pt { let X int32 }
class C {
 func Check(p Pt) bool { return p.X > 0 }
 func F() { if Check(Pt{X: 1}) { } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text)
    }

    @Fact
    func BareStructLiteral_In_Expression_Position_Still_Parses() {
        // The suppression must apply ONLY in statement-header controlling
        // expressions; ordinary expression position still parses a struct literal.
        const source = `
package p
data struct Pt { let X int32 }
class C { func F() { var p = Pt{X: 1} } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text)
    }

    @Fact
    func EmptyStructLiteral_As_ForIn_Collection_Followed_By_Body_Still_Parses() {
        // Regression guard for the inverse case: an EMPTY struct literal that IS
        // a `for-in` collection is followed by a real body `{`, so it must remain
        // a struct literal (`for v in Numbers{} { .. }`), not be split into an
        // identifier collection with an empty body.
        const source = `
package p
class Numbers { func GetEnumerator() NumberEnum { return NumberEnum() } }
class NumberEnum { func MoveNext() bool { return false }
 func Current() int32 { return 0 } }
class C { func F() { for v in Numbers{} { var x = v } } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Numbers", structLiteral.TypeIdentifier.Text)
    }

    @Fact
    func NonEmptyStructLiteral_At_Start_Of_Condition_Still_Parses() {
        // A non-empty struct literal is unambiguous even as the head of a
        // condition (`{ Ident : .. }` cannot open a body), so `if Pt{X: 1} == p`
        // keeps parsing `Pt{X: 1}` as a struct literal.
        const source = `
package p
data struct Pt { let X int32 }
class C { func F(p Pt) { if Pt{X: 1} == p { } var x = 1 } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let structLiteral = Descendants(tree.Root).OfType[StructLiteralExpressionSyntax]().Single()
        Assert.Equal("Pt", structLiteral.TypeIdentifier.Text)
    }

    shared {
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            for child in node.GetChildren() {
                yield child
                for d in Descendants(child) {
                    yield d
                }
            }
        }
    }
}
