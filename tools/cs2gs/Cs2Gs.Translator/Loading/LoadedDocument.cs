// <copyright file="LoadedDocument.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator.Loading;

/// <summary>
/// One ingested C# source file: its parsed <see cref="SyntaxTree"/>, the bound
/// <see cref="SemanticModel"/> the translator uses to resolve symbols, and the
/// originating file path. This is the per-file unit the visitor skeleton walks
/// (ADR-0115 §A — Roslyn front-end → emit AST).
/// </summary>
public sealed class LoadedDocument
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LoadedDocument"/> class.
    /// </summary>
    /// <param name="filePath">The originating file path (may be a synthetic name for in-memory sources).</param>
    /// <param name="syntaxTree">The parsed C# syntax tree.</param>
    /// <param name="semanticModel">The bound semantic model for <paramref name="syntaxTree"/>.</param>
    public LoadedDocument(string filePath, SyntaxTree syntaxTree, SemanticModel semanticModel)
    {
        this.FilePath = filePath;
        this.SyntaxTree = syntaxTree;
        this.SemanticModel = semanticModel;
    }

    /// <summary>Gets the originating file path.</summary>
    public string FilePath { get; }

    /// <summary>Gets the parsed C# syntax tree.</summary>
    public SyntaxTree SyntaxTree { get; }

    /// <summary>Gets the bound semantic model for <see cref="SyntaxTree"/>.</summary>
    public SemanticModel SemanticModel { get; }

    /// <summary>
    /// Gets the root <see cref="CompilationUnitSyntax"/> of <see cref="SyntaxTree"/>.
    /// </summary>
    /// <returns>The C# compilation-unit root node.</returns>
    public CompilationUnitSyntax GetRoot() => (CompilationUnitSyntax)this.SyntaxTree.GetRoot();
}
