// <copyright file="Highlight.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Repl.Tokens
import Spectre.Console
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Text

/// Turns a line of G# into themed Spectre markup using the lexer.
shared class Highlight {
    func Markup(line string) string {
        if string.IsNullOrEmpty(line) {
            return string.Empty
        }
        let sb = StringBuilder()
        for token in SyntaxTree.ParseTokens(line) {
            if string.IsNullOrEmpty(token.Text) {
                continue
            }
            for (_, text, color) in ExpandToken(token) {
                if string.IsNullOrEmpty(text) {
                    continue
                }
                sb.Append('[').Append(color.Value.ToMarkup()).Append(']').Append(Markup.Escape(text)).Append("[/]")
            }
        }
        return sb.ToString()
    }

    /// Highlights a full line in one lex pass, drawing a reverse-video block cursor
    /// at [`cursorCol`](paramref) without splitting the token under the caret.
    func MarkupWithCursor(line string, cursorCol int32, cursorMarkup string) string {
        let sb = StringBuilder()
        var rendered = 0
        for token in SyntaxTree.ParseTokens(line) {
            if string.IsNullOrEmpty(token.Text) {
                continue
            }
            for (start, text, color) in ExpandToken(token) {
                if string.IsNullOrEmpty(text) {
                    continue
                }
                let colorMarkup = color.Value.ToMarkup()
                for var i = 0; i < text.Length; i++ {
                    let ch = Markup.Escape(text[i].ToString())
                    let open_ = if start + i == cursorCol {
                        cursorMarkup
                    } else {
                        colorMarkup
                    }
                    sb.Append('[').Append(open_).Append(']').Append(ch).Append("[/]")
                }
                rendered = start + text.Length
            }
        }
        if cursorCol >= rendered {
            sb.Append('[').Append(cursorMarkup).Append("] [/]")
        }
        return sb.ToString()
    }

    /// Splits a single lexed token into absolutely-positioned (start, text, color) spans.
    /// Every token except (cref:SyntaxKind.InterpolatedStringToken) is a single span
    /// colored by its own kind. An interpolated string's holes (`${expr}` / `$ident`)
    /// are re-lexed and colored individually — without this, the whole literal (including any
    /// holes) falls through (cref:ColorFor)'s default case and renders as one flat color.
    private func ExpandToken(token SyntaxToken) sequence[(Start int32, Text string, Color SemanticColor)] {
        if token.Kind == SyntaxKind.InterpolatedStringToken && token.Value is InterpolationFragments frags {
            var cursor = token.Position
            let tokenEnd = token.Position + token.Text.Length
            let stringColor = Tokens.StringLit
            for frag in frags.Items {
                if !frag.IsExpression {
                    // Literal-fragment positions aren't populated by the lexer (see
                    // InterpolationFragment.FromText); the literal span is instead whatever
                    // lies between the previous hole's end and this hole's start below.
                    continue
                }
                if frag.Position > cursor {
                    yield(cursor, token.Text.Substring(cursor - token.Position, frag.Position - cursor), stringColor)
                }
                for exprToken in SyntaxTree.ParseTokens(frag.Text) {
                    if string.IsNullOrEmpty(exprToken.Text) {
                        continue
                    }
                    yield(frag.Position + exprToken.Position, exprToken.Text, ColorFor(exprToken.Kind))
                }
                cursor = frag.Position + frag.Text.Length
            }
            if tokenEnd > cursor {
                yield(cursor, token.Text.Substring(cursor - token.Position, tokenEnd - cursor), stringColor)
            }
            yield break
        }
        yield(token.Position, token.Text, ColorFor(token.Kind))
    }

    private func ColorFor(kind SyntaxKind) SemanticColor {
        if kind.ToString().EndsWith("Keyword", StringComparison.Ordinal) {
            return Tokens.Keyword
        }
        return switch kind {
            case SyntaxKind.NumberToken: Tokens.Number
            case SyntaxKind.StringToken: Tokens.StringLit
            case SyntaxKind.ByteStringToken: Tokens.StringLit
            case SyntaxKind.Utf8StringToken: Tokens.StringLit
            case SyntaxKind.CommentToken: Tokens.Comment
            case SyntaxKind.IdentifierToken: Tokens.Identifier
            default: Tokens.TextTertiary
        }
    }
}
