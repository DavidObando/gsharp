// <copyright file="SyntaxToken.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text

/// Represents a syntax token in the language.
open partial class SyntaxToken : SyntaxNode {
    /// Initializes a new instance of the (cref:SyntaxToken) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param kind The kind of syntax token.
    /// @param position The position of the syntax token.
    /// @param text The text of the syntax token.
    /// @param value The value of the syntax token.
    convenience init(syntaxTree SyntaxTree, kind SyntaxKind, position int32, text string, value object?) {
        init(syntaxTree, kind, position, text, value, false)
    }

    private init(
        syntaxTree SyntaxTree,
        kind SyntaxKind,
        position int32,
        text string,
        value object?,
        isMissing bool
    ) : base(syntaxTree) {
        _kind = kind
        Position = position
        Text = text
        Value = value
        IsMissing = isMissing
    }

    /// Gets the kind of this syntax token.
    private var _kind SyntaxKind

    open override prop Kind SyntaxKind -> _kind

    /// Gets the position of this syntax token.
    prop Position int32 {
        get;
    }

    /// Gets the text seen by the lexer that created this syntax token.
    prop Text string {
        get;
    }

    /// Gets the value of this syntax token, if any.
    prop Value object? {
        get;
    }

    /// Gets the semantic name text of this token (ADR-0170 / issue #3610):
    /// for an escaped identifier `$name` this is the unescaped
    /// `name` the lexer stashed in (cref:Value); for every other
    /// token it is (cref:Text). Semantic consumers (binder, symbols,
    /// lowering, emit) read identifier names through this property so an
    /// escaped spelling and its plain form denote the same name; syntactic
    /// consumers (printers, formatters, contextual-keyword commitments) keep
    /// using (cref:Text) for source fidelity.
    prop ValueText string -> Value as string ?? Text

    /// Gets the text span associated to the token.
    open override prop Span TextSpan -> TextSpan(Position, Text?.Length ?? 0)

    /// Gets a value indicating whether the token was inserted by the parser and doesn't appear in source.
    /// @remarks Issue #3332: this was previously derived from `Text == null`. It is
    /// now carried explicitly, so a missing token can hold
    /// (cref:string.Empty) text without losing the distinction that
    /// CodeLens, semantic lookup and function declaration all rely on.
    prop IsMissing bool {
        get;
    }

    shared {
        /// Creates a token the parser inserted during error recovery, which does not
        /// appear in source.
        /// @remarks Issue #3332: the text is (cref:string.Empty), never
        /// `null`. Missing tokens flow on through the rest of the
        /// parse, so a null (cref:Text) made every consumer of it a latent
        /// (cref:System.NullReferenceException) on any recovery path — the
        /// shape that produced issue #2144. (cref:IsMissing) carries the
        /// distinction instead.
        /// @param syntaxTree The parent syntax tree.
        /// @param kind The kind of token the parser expected.
        /// @param position The position at which it was expected.
        /// @returns A zero-width token with empty text.
        func Missing(syntaxTree SyntaxTree, kind SyntaxKind, position int32) SyntaxToken -> SyntaxToken(
            syntaxTree,
            kind,
            position,
            string.Empty,
            nil,
            isMissing: true
        )
    }
}
