// <copyright file="DocumentContent.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Used on (cref:DocumentContentService).
/// @param syntaxTree The (cref:SyntaxTree) of the document.
/// @param lines The position for line breaks in the document content.
/// @param project The owning project state, if available.
/// @param workspace The owning workspace state, if available. Threaded
/// through so cross-project features (e.g. Go-to-Definition into a sibling
/// `.gsproj`) can reach other projects from a per-document computer.
open class DocumentContent {
    init(
        syntaxTree SyntaxTree,
        lines IReadOnlyList[int32],
        project ProjectState? = nil,
        workspace WorkspaceState? = nil
    ) {
        SyntaxTree = syntaxTree
        Lines = lines
        Project = project
        Workspace = workspace
    }

    /// Gets the document syntax tree.
    prop SyntaxTree SyntaxTree {
        get;
    }

    /// Gets the document content line breaks.
    prop Lines IReadOnlyList[int32] {
        get;
    }

    /// Gets the owning project state, or null if the file is not part of a project.
    prop Project ProjectState? {
        get;
    }

    /// Gets the owning workspace state, or null when no workspace is attached
    /// (single-file scenarios and most unit tests). Cross-project Go-to-Definition
    /// reads this to locate sibling projects by their output assembly name; if
    /// the workspace is missing, those features gracefully degrade to
    /// PDB-based navigation or null.
    prop Workspace WorkspaceState? {
        get;
    }
}
