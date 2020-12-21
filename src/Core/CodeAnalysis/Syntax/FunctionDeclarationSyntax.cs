// <copyright file="FunctionDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a function declaration in the language.
    /// </summary>
    public sealed class FunctionDeclarationSyntax : MemberSyntax
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="FunctionDeclarationSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        /// <param name="functionKeyword">The func keyword.</param>
        /// <param name="identifier">The function identifier.</param>
        /// <param name="openParenthesisToken">The open parenthesis token.</param>
        /// <param name="parameters">The function's parameters.</param>
        /// <param name="closeParenthesisToken">The close parenthesis token.</param>
        /// <param name="type">The function's type.</param>
        /// <param name="body">The function's body.</param>
        public FunctionDeclarationSyntax(
            SyntaxTree syntaxTree,
            SyntaxToken functionKeyword,
            SyntaxToken identifier,
            SyntaxToken openParenthesisToken,
            SeparatedSyntaxList<ParameterSyntax> parameters,
            SyntaxToken closeParenthesisToken,
            TypeClauseSyntax type,
            BlockStatementSyntax body)
            : base(syntaxTree)
        {
            FunctionKeyword = functionKeyword;
            Identifier = identifier;
            OpenParenthesisToken = openParenthesisToken;
            Parameters = parameters;
            CloseParenthesisToken = closeParenthesisToken;
            Type = type;
            Body = body;
        }

        /// <inheritdoc/>
        public override SyntaxKind Kind => SyntaxKind.FunctionDeclaration;

        /// <summary>
        /// Gets the func keyword.
        /// </summary>
        public SyntaxToken FunctionKeyword { get; }

        /// <summary>
        /// Gets the function identifier.
        /// </summary>
        public SyntaxToken Identifier { get; }

        /// <summary>
        /// Gets the open parenthesis token.
        /// </summary>
        public SyntaxToken OpenParenthesisToken { get; }

        /// <summary>
        /// Gets the function's parameters.
        /// </summary>
        public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

        /// <summary>
        /// Gets the close parenthesis token.
        /// </summary>
        public SyntaxToken CloseParenthesisToken { get; }

        /// <summary>
        /// Gets the function's type.
        /// </summary>
        public TypeClauseSyntax Type { get; }

        /// <summary>
        /// Gets the function's body.
        /// </summary>
        public BlockStatementSyntax Body { get; }
    }
}
