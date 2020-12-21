// <copyright file="ExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an abstract expression in the language.
    /// </summary>
    public abstract class ExpressionSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ExpressionSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        protected ExpressionSyntax(SyntaxTree syntaxTree)
            : base(syntaxTree)
        {
        }
    }
}