// <copyright file="LogicalWordCodeFixProvider.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.CodeFixes
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// GS0125 or GS0130 on `or`, `and` or `not` in an expression: `||`, `&&`, `!` (ADR-0227 D8).
/// @remarks In a pattern the parser reads these words as pattern combinators and reports no
/// diagnostic, so a fix applies only in an expression. `or` and `and` need an operand before them
/// on the same line. `not` is (cref:Applicability.MaybeIncorrect): `!` binds tighter than a
/// comparison, so `not a == b` becomes `!a == b`.
internal class LogicalWordCodeFixProvider : GSharpCodeFixProvider {
    override prop FixableDiagnosticIds ImmutableArray[string] -> ImmutableArray.Create("GS0125", "GS0130")

    override prop Id string -> "GSharp.CodeFixes.LogicalWord"

    override func RegisterCodeFixes(context CodeFixContext) {
        let tree = context.Tree
        let token SyntaxToken? = FixSyntax.TokenAt(tree, context.Diagnostic)
        if token == nil || token.Kind != SyntaxKind.IdentifierToken {
            return
        }
        let next SyntaxToken? = FixSyntax.NextRealToken(tree, token)
        if next == nil || !FixSyntax.SameLine(tree.Text, token.Span.Start, next.Span.Start) {
            return
        }
        // `and()` is a call with no argument, not an operand.
        if next.Kind == SyntaxKind.OpenParenthesisToken {
            let afterParenthesis SyntaxToken? = FixSyntax.NextRealToken(tree, next)
            if afterParenthesis == nil || afterParenthesis.Kind == SyntaxKind.CloseParenthesisToken {
                return
            }
        }
        switch token.Text {
            case "or", "and" {
                // `a or b` reports GS0125; `a or (b)` parses as a call and reports GS0130.
                // A binary operator needs an operand on each side, on the line.
                let previous SyntaxToken? = FixSyntax.PreviousRealToken(tree, token)
                if previous == nil || !FixSyntax.SameLine(tree.Text, previous.Span.Start, token.Span.Start) ||
                    !EndsOperand(previous) ||
                    !StartsOperand(next) {
                    return
                }
                let replacement = if token.Text == "or" {
                    "||"
                } else {
                    "&&"
                }
                context.RegisterFix(
                    "Use '${replacement}'",
                    "LogicalWord.${token.Text}",
                    Applicability.MachineApplicable,
                    (editor SyntaxEditor) -> editor.ReplaceToken(token, replacement)
                )
            }
            case "not" {
                // A prefix operator needs an operand after it, and no operand before it.
                let before SyntaxToken? = FixSyntax.PreviousRealToken(tree, token)
                if !StartsOperand(next) ||
                    (
                    before != nil && FixSyntax.SameLine(tree.Text, before.Span.Start, token.Span.Start) &&
                        EndsOperand(before)
                ) {
                    return
                }
                let following = next
                context.RegisterFix(
                    "Use '!'",
                    "LogicalWord.not",
                    Applicability.MaybeIncorrect,
                    (editor SyntaxEditor) -> {
                        editor.RemoveToken(token)
                        // `!` before `!` would lex as `!!`, the postfix null assertion.
                        editor.InsertBefore(
                            following,
                            if following.Kind == SyntaxKind.BangToken {
                                "! "
                            } else {
                                "!"
                            }
                        )
                    }
                )
            }
        }
    }

    private func EndsOperand(token SyntaxToken) bool -> switch token.Kind {
        case SyntaxKind.IdentifierToken: token.Text != "return" &&
            token.Text != "or" &&
            token.Text != "and" &&
            token.Text != "not"
        case SyntaxKind.NumberToken,
        SyntaxKind.StringToken,
        SyntaxKind.CharacterToken,
        SyntaxKind.InterpolatedStringToken: true
        case SyntaxKind.CloseParenthesisToken, SyntaxKind.CloseSquareBracketToken: true
        case SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NilKeyword: true
        default: false
    }

    private func StartsOperand(token SyntaxToken) bool -> switch token.Kind {
        case SyntaxKind.IdentifierToken: token.Text != "or" && token.Text != "and"
        case SyntaxKind.NumberToken,
        SyntaxKind.StringToken,
        SyntaxKind.CharacterToken,
        SyntaxKind.InterpolatedStringToken: true
        case SyntaxKind.OpenParenthesisToken, SyntaxKind.BangToken, SyntaxKind.MinusToken: true
        case SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NilKeyword: true
        default: false
    }
}
