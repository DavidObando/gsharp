// <copyright file="LoadedDocument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Loading

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax

/// One ingested C# source file: its parsed (cref:SyntaxTree), the bound
/// (cref:SemanticModel) the translator uses to resolve symbols, and the
/// originating file path. This is the per-file unit the visitor skeleton walks
/// (ADR-0115 §A — Roslyn front-end → emit AST).
class LoadedDocument {
    /// Initializes a new instance of the (cref:LoadedDocument) class.
    /// @param filePath The originating file path (may be a synthetic name for in-memory sources).
    /// @param syntaxTree The parsed C# syntax tree.
    /// @param semanticModel The bound semantic model for [`syntaxTree`](paramref).
    init(filePath string, syntaxTree SyntaxTree, semanticModel SemanticModel) {
        this.FilePath = filePath
        this.SyntaxTree = syntaxTree
        this.SemanticModel = semanticModel
    }

    /// Gets the originating file path.
    prop FilePath string {
        get;
    }

    /// Gets the parsed C# syntax tree.
    prop SyntaxTree SyntaxTree {
        get;
    }

    /// Gets the bound semantic model for (cref:SyntaxTree).
    prop SemanticModel SemanticModel {
        get;
    }

    /// Gets the root (cref:CompilationUnitSyntax) of (cref:SyntaxTree).
    /// @returns The C# compilation-unit root node.
    func GetRoot() CompilationUnitSyntax -> cast[CompilationUnitSyntax](this.SyntaxTree.GetRoot())
}
