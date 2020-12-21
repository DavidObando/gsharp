// <copyright file="StatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an abstract statement syntax in the language.
    /// </summary>
    public abstract class StatementSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="StatementSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        protected StatementSyntax(SyntaxTree syntaxTree)
            : base(syntaxTree)
        {
        }
    }
}
