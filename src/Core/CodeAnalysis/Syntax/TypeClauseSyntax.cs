// <copyright file="TypeClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a type clause in the language.
    /// </summary>
    public sealed class TypeClauseSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="TypeClauseSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="identifier">The type clause identifier.</param>
        public TypeClauseSyntax(SyntaxTree syntaxTree, SyntaxToken identifier)
            : base(syntaxTree)
        {
            Identifier = identifier;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.TypeClause;

        /// <summary>
        /// Gets the type clause identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }
    }
}
