// <copyright file="SyntaxToken.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a syntax token in the language.
/// </summary>
public class SyntaxToken : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SyntaxToken"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="kind">The kind of syntax token.</param>
    /// <param name="position">The position of the syntax token.</param>
    /// <param name="text">The text of the syntax token.</param>
    /// <param name="value">The value of the syntax token.</param>
    public SyntaxToken(SyntaxTree syntaxTree, SyntaxKind kind, int position, string text, object? value)
        : this(syntaxTree, kind, position, text, value, isMissing: false)
    {
    }

    private SyntaxToken(SyntaxTree syntaxTree, SyntaxKind kind, int position, string text, object? value, bool isMissing)
        : base(syntaxTree)
    {
        Kind = kind;
        Position = position;
        Text = text;
        Value = value;
        IsMissing = isMissing;
    }

    /// <summary>
    /// Gets the kind of this syntax token.
    /// </summary>
    public override SyntaxKind Kind { get; }

    /// <summary>
    /// Gets the position of this syntax token.
    /// </summary>
    public int Position { get; }

    /// <summary>
    /// Gets the text seen by the lexer that created this syntax token.
    /// </summary>
    public string Text { get; }

    /// <summary>
    /// Gets the value of this syntax token, if any.
    /// </summary>
    public object? Value { get; }

    /// <summary>
    /// Gets the semantic name text of this token (ADR-0170 / issue #3610):
    /// for an escaped identifier <c>$name</c> this is the unescaped
    /// <c>name</c> the lexer stashed in <see cref="Value"/>; for every other
    /// token it is <see cref="Text"/>. Semantic consumers (binder, symbols,
    /// lowering, emit) read identifier names through this property so an
    /// escaped spelling and its plain form denote the same name; syntactic
    /// consumers (printers, formatters, contextual-keyword commitments) keep
    /// using <see cref="Text"/> for source fidelity.
    /// </summary>
    public string ValueText => Value as string ?? Text;

    /// <summary>
    /// Gets the text span associated to the token.
    /// </summary>
    public override TextSpan Span => new TextSpan(Position, Text?.Length ?? 0);

    /// <summary>
    /// Gets a value indicating whether the token was inserted by the parser and doesn't appear in source.
    /// </summary>
    /// <remarks>
    /// Issue #3332: this was previously derived from <c>Text == null</c>. It is
    /// now carried explicitly, so a missing token can hold
    /// <see cref="string.Empty"/> text without losing the distinction that
    /// CodeLens, semantic lookup and function declaration all rely on.
    /// </remarks>
    public bool IsMissing { get; }

    /// <summary>
    /// Creates a token the parser inserted during error recovery, which does not
    /// appear in source.
    /// </summary>
    /// <remarks>
    /// Issue #3332: the text is <see cref="string.Empty"/>, never
    /// <see langword="null"/>. Missing tokens flow on through the rest of the
    /// parse, so a null <see cref="Text"/> made every consumer of it a latent
    /// <see cref="System.NullReferenceException"/> on any recovery path — the
    /// shape that produced issue #2144. <see cref="IsMissing"/> carries the
    /// distinction instead.
    /// </remarks>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="kind">The kind of token the parser expected.</param>
    /// <param name="position">The position at which it was expected.</param>
    /// <returns>A zero-width token with empty text.</returns>
    public static SyntaxToken Missing(SyntaxTree syntaxTree, SyntaxKind kind, int position)
        => new SyntaxToken(syntaxTree, kind, position, string.Empty, null, isMissing: true);
}
