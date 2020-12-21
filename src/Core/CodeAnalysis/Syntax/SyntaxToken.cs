// <copyright file="SyntaxToken.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using GSharp.Core.CodeAnalysis.Text;

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
        public SyntaxToken(SyntaxTree syntaxTree, SyntaxKind kind, int position, string text, object value)
            : base(syntaxTree)
        {
            Kind = kind;
            Position = position;
            Text = text;
            Value = value;
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
        public object Value { get; }

        /// <summary>
        /// Gets the text span associated to the token.
        /// </summary>
        public override TextSpan Span => new TextSpan(Position, Text?.Length ?? 0);

        /// <summary>
        /// Gets a value indicating whether the token was inserted by the parser and doesn't appear in source.
        /// </summary>
        public bool IsMissing => Text == null;
    }
}
