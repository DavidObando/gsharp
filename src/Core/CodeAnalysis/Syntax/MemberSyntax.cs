// <copyright file="MemberSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents an abstract member in the language.
    /// </summary>
    public abstract class MemberSyntax : SyntaxNode
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="MemberSyntax"/> class.
        /// </summary>
        /// <param name="syntaxTree">The parent syntax tree.</param>
        protected MemberSyntax(SyntaxTree syntaxTree)
            : base(syntaxTree)
        {
        }
    }
}
