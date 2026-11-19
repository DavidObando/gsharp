// <copyright file="FixSyntax.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes.BuiltIn

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System

/// Token queries that the built-in providers share (ADR-0227 D8).
internal shared class FixSyntax {
    /// Gets the real token that starts at the diagnostic and has exactly its span, or `null`.
    func TokenAt(tree SyntaxTree, diagnostic Diagnostic) SyntaxToken? {
        let span = diagnostic.Location.Span
        let token SyntaxToken? = tree.Root.FindToken(span.Start)
        if token == nil || token.Span.Start != span.Start || token.Span.Length != span.Length {
            return nil
        }
        return token
    }

    /// Gets the first real token that starts at or after the end of [`token`](paramref), or `null`.
    func NextRealToken(tree SyntaxTree, token SyntaxToken) SyntaxToken? {
        var best SyntaxToken? = nil
        for candidate in tree.Root.DescendantTokens() {
            if !IsReal(candidate) || candidate.Span.Start < token.Span.End || object.ReferenceEquals(candidate, token) {
                continue
            }
            if best == nil || candidate.Span.Start < best.Span.Start {
                best = candidate
            }
        }
        return best
    }

    /// Gets the last real token that ends at or before the start of [`token`](paramref), or `null`.
    func PreviousRealToken(tree SyntaxTree, token SyntaxToken) SyntaxToken? {
        var best SyntaxToken? = nil
        for candidate in tree.Root.DescendantTokens() {
            if !IsReal(candidate) || candidate.Span.End > token.Span.Start || object.ReferenceEquals(candidate, token) {
                continue
            }
            if best == nil || candidate.Span.End > best.Span.End {
                best = candidate
            }
        }
        return best
    }

    /// Gets a value that tells whether two positions are on one line.
    func SameLine(text SourceText, a int32, b int32) bool -> text.GetLineIndex(a) == text.GetLineIndex(b)

    /// Gets the smallest node whose real-token span is exactly [`span`](paramref), or `null`.
    func NodeWithSpan(tree SyntaxTree, span TextSpan) SyntaxNode? {
        var best SyntaxNode? = nil
        for node in tree.Root.DescendantNodesAndSelf() {
            let nodeSpan = node.Span
            if nodeSpan.Start == span.Start && nodeSpan.Length == span.Length {
                best = node
            }
        }
        return best
    }

    /// Gets a value that tells whether a token has source text.
    func IsReal(token SyntaxToken) bool -> !token.IsMissing && !token.IsSynthesized && token.Span.Length > 0
}
