// <copyright file="MultiDocumentEditor.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable

/// One (cref:SyntaxEditor) for each tree of a compilation, for a fix that edits more than one
/// document (ADR-0227 D2).
class MultiDocumentEditor {
    private let editors Dictionary[SyntaxTree, SyntaxEditor] = Dictionary[SyntaxTree, SyntaxEditor]()
    private let order List[SyntaxTree] = List[SyntaxTree]()

    internal init(compilation Compilation) {
        Compilation = compilation
    }

    /// Gets the compilation whose trees the editor edits.
    prop Compilation Compilation {
        get;
    }

    /// Gets the editor of a tree. The first call for a tree creates it.
    /// @param tree A tree of (cref:Compilation).
    /// @returns The editor.
    func EditorFor(tree SyntaxTree) SyntaxEditor {
        ArgumentNullException.ThrowIfNull(tree)
        if editors.TryGetValue(tree, out var existing) {
            return existing
        }
        if !Compilation.SyntaxTrees.Contains(tree) {
            throw ArgumentException("The tree is not part of the compilation.", nameof(tree))
        }
        let editor = SyntaxEditor(tree)
        editors.Add(tree, editor)
        order.Add(tree)
        return editor
    }

    internal func GetChanges() FixChanges {
        let documents = ImmutableArray.CreateBuilder[DocumentChanges]()
        for tree in order {
            let editor = editors[tree]
            if editor.HasChanges {
                documents.Add(DocumentChanges(tree, editor.GetChanges(), editor.GetPlaceholders()))
            }
        }
        return FixChanges(documents.ToImmutable())
    }
}
