// <copyright file="TranslationContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Cs2Gs.Translator;

/// <summary>
/// Carries the bound Roslyn state a translation pass needs and accumulates the
/// structured <see cref="TranslationDiagnostic"/> records the later mapping
/// steps (6–8) emit. One context is created per file: it pins the active
/// <see cref="SemanticModel"/> so mapping code can resolve symbols
/// (<c>GetDeclaredSymbol</c>, <c>GetSymbolInfo</c>, <c>GetTypeInfo</c>,
/// data-flow) without threading the model through every call (ADR-0115 §A).
/// </summary>
public sealed class TranslationContext
{
    private readonly List<TranslationDiagnostic> diagnostics = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="TranslationContext"/> class.
    /// </summary>
    /// <param name="compilation">The owning C# compilation.</param>
    /// <param name="semanticModel">The active semantic model for the file being translated.</param>
    /// <param name="filePath">The originating file path, used to tag diagnostics.</param>
    public TranslationContext(CSharpCompilation compilation, SemanticModel semanticModel, string filePath)
    {
        this.Compilation = compilation ?? throw new ArgumentNullException(nameof(compilation));
        this.SemanticModel = semanticModel ?? throw new ArgumentNullException(nameof(semanticModel));
        this.FilePath = filePath;
    }

    /// <summary>Gets the owning C# compilation.</summary>
    public CSharpCompilation Compilation { get; }

    /// <summary>Gets the active semantic model for the file being translated.</summary>
    public SemanticModel SemanticModel { get; }

    /// <summary>Gets the originating file path.</summary>
    public string FilePath { get; }

    /// <summary>Gets the diagnostics recorded so far, in insertion order.</summary>
    public IReadOnlyList<TranslationDiagnostic> Diagnostics => this.diagnostics.ToImmutableArray();

    /// <summary>
    /// Resolves the declared symbol for a declaration node via the active model.
    /// </summary>
    /// <param name="node">The declaration syntax node.</param>
    /// <returns>The declared symbol, or <see langword="null"/> if none.</returns>
    public ISymbol GetDeclaredSymbol(SyntaxNode node) => this.SemanticModel.GetDeclaredSymbol(node);

    /// <summary>
    /// Resolves symbol information for an expression or reference via the active model.
    /// </summary>
    /// <param name="node">The expression or reference node.</param>
    /// <returns>The resolved symbol info.</returns>
    public SymbolInfo GetSymbolInfo(SyntaxNode node) => this.SemanticModel.GetSymbolInfo(node);

    /// <summary>
    /// Resolves type information for an expression via the active model.
    /// </summary>
    /// <param name="node">The expression node.</param>
    /// <returns>The resolved type info.</returns>
    public TypeInfo GetTypeInfo(SyntaxNode node) => this.SemanticModel.GetTypeInfo(node);

    /// <summary>
    /// Records a structured diagnostic for a construct the translator cannot map.
    /// </summary>
    /// <param name="diagnostic">The diagnostic to record.</param>
    public void Report(TranslationDiagnostic diagnostic)
    {
        if (diagnostic is null)
        {
            throw new ArgumentNullException(nameof(diagnostic));
        }

        this.diagnostics.Add(diagnostic);
    }

    /// <summary>
    /// Records an <see cref="TranslationSeverity.Unsupported"/> diagnostic anchored
    /// at a C# syntax node. This is the canonical "not yet translated" seam used
    /// by the visitor skeleton until steps 6–8 implement the real mapping.
    /// </summary>
    /// <param name="node">The C# node that could not be translated.</param>
    /// <param name="message">A human-readable description of the gap.</param>
    public void ReportUnsupported(SyntaxNode node, string message)
    {
        if (node is null)
        {
            throw new ArgumentNullException(nameof(node));
        }

        this.diagnostics.Add(new TranslationDiagnostic(
            node.Kind().ToString(),
            message,
            node.GetLocation(),
            TranslationSeverity.Unsupported));
    }
}
