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
        switch token.Text {
            case "or", "and" {
                if context.Diagnostic.Id != "GS0125" {
                    return
                }
                let previous SyntaxToken? = FixSyntax.PreviousRealToken(tree, token)
                if previous == nil || !FixSyntax.SameLine(tree.Text, previous.Span.Start, token.Span.Start) {
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
                let following = next
                context.RegisterFix(
                    "Use '!'",
                    "LogicalWord.not",
                    Applicability.MaybeIncorrect,
                    (editor SyntaxEditor) -> {
                        editor.RemoveToken(token)
                        editor.InsertBefore(following, "!")
                    }
                )
            }
        }
    }
}
