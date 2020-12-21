// <copyright file="ParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a parameter in the language.
    /// </summary>
    public sealed class ParameterSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="ParameterSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="identifier">The parameter identifier.</param>
        /// <param name="type">The parameter type.</param>
        public ParameterSyntax(SyntaxTree syntaxTree, SyntaxToken identifier, TypeClauseSyntax type)
            : base(syntaxTree)
        {
            Identifier = identifier;
            Type = type;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.Parameter;

        /// <summary>
        /// Gets the parameter identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }

        /// <summary>
        /// Gets the parameter type.
        /// </summary>
        public TypeClauseSyntax Type { get; }
    }
}
