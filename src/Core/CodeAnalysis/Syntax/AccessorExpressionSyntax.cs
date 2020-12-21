// <copyright file="AccessorExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an accessor expression syntax in the language.
    /// </summary>
    public sealed class AccessorExpressionSyntax : ExpressionSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="AccessorExpressionSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="leftPart">The left part.</param>
        /// <param name="dotToken">The dot token.</param>
        /// <param name="rightPart">The right part.</param>
        public AccessorExpressionSyntax(
            SyntaxTree syntaxTree,
            ExpressionSyntax leftPart,
            SyntaxToken dotToken,
            ExpressionSyntax rightPart)
            : base(syntaxTree)
        {
            LeftPart = leftPart;
            DotToken = dotToken;
            RightPart = rightPart;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.AccessorExpression;

        /// <summary>
        /// Gets the left part.
        /// </summary>
        public ExpressionSyntax LeftPart { get; }

        /// <summary>
        /// Gets the dot token.
        /// </summary>
        public SyntaxToken DotToken { get; }

        /// <summary>
        /// Gets the right part.
        /// </summary>
        public ExpressionSyntax RightPart { get; }
    }
}
