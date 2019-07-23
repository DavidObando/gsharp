// <copyright file="DocumentContent.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.LSP
{
    using System.Collections.Generic;
    using GSharp.Core.CodeAnalysis.Syntax;

    /// <summary>
    /// Used on <see cref="DocumentContentService"/>.
    /// </summary>
    internal class DocumentContent
    {
        /// <summary>
        /// Initializes a new instance of the <see cref="DocumentContent"/> class.
        /// </summary>
        /// <param name="syntaxTree">The <see cref="SyntaxTree"/> of the document.</param>
        /// <param name="lines">The position for line breaks in the document content.</param>
        public DocumentContent(SyntaxTree syntaxTree, IReadOnlyList<int> lines)
        {
            SyntaxTree = syntaxTree;
            Lines = lines;
        }

        /// <summary>
        /// Gets the document syntax tree.
        /// </summary>
        public SyntaxTree SyntaxTree { get; }

        /// <summary>
        /// Gets the document content line breaks.
        /// </summary>
        public IReadOnlyList<int> Lines { get; }
    }
}
