#nullable disable

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
/// <param name="project">The owning project state, if available.</param>
/// <param name="workspace">The owning workspace state, if available. Threaded
/// through so cross-project features (e.g. Go-to-Definition into a sibling
/// <c>.gsproj</c>) can reach other projects from a per-document computer.</param>
public class DocumentContent(SyntaxTree syntaxTree, IReadOnlyList<int> lines, ProjectState project = null, WorkspaceState workspace = null)
{
    /// <summary>
    /// Gets the document syntax tree.
    /// </summary>
    public SyntaxTree SyntaxTree { get; } = syntaxTree;

    /// <summary>
    /// Gets the document content line breaks.
    /// </summary>
    public IReadOnlyList<int> Lines { get; } = lines;

    /// <summary>
    /// Gets the owning project state, or null if the file is not part of a project.
    /// </summary>
    public ProjectState Project { get; } = project;

    /// <summary>
    /// Gets the owning workspace state, or null when no workspace is attached
    /// (single-file scenarios and most unit tests). Cross-project Go-to-Definition
    /// reads this to locate sibling projects by their output assembly name; if
    /// the workspace is missing, those features gracefully degrade to
    /// PDB-based navigation or null.
    /// </summary>
    public WorkspaceState Workspace { get; } = workspace;
}
