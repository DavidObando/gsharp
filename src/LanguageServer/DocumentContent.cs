// <copyright file="DocumentContent.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.LanguageServer;

/// <summary>
/// Used on <see cref="DocumentContentService"/>.
/// </summary>
/// <param name="syntaxTree">The <see cref="SyntaxTree"/> of the document.</param>
/// <param name="lines">The position for line breaks in the document content.</param>
public class DocumentContent(SyntaxTree syntaxTree, IReadOnlyList<int> lines)
{
    /// <summary>
    /// Gets the document syntax tree.
    /// </summary>
    public SyntaxTree SyntaxTree { get; } = syntaxTree;

    /// <summary>
    /// Gets the document content line breaks.
    /// </summary>
    public IReadOnlyList<int> Lines { get; } = lines;
}
