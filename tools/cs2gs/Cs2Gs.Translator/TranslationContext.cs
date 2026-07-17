// <copyright file="TranslationContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.Translator.Coverage;
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
    private readonly List<TranslationDiagnostic> diagnostics = new List<TranslationDiagnostic>();

    // Issue #1910: a partial type's other declarations live in different
    // `SyntaxTree`s than the one this context was created for, so resolving a
    // symbol on one of their members requires a `SemanticModel` bound to THAT
    // tree — the active model throws "node is not within syntax tree"
    // otherwise. `UseSemanticModelFor` temporarily swaps the active model
    // while a partial declaration's own members are translated; this cache
    // avoids re-creating a `SemanticModel` per member for the same tree.
    private readonly Dictionary<SyntaxTree, SemanticModel> modelsByTree = new Dictionary<SyntaxTree, SemanticModel>();

    // Issue #2412: every project's own `Compilation` loaded alongside this one
    // in the same migration run (the app plus every transitively-referenced
    // sibling project — see `TranslateStage`), consulted by
    // `ObliviousNullabilityAnalyzer.IsTainted`'s multi-compilation overload
    // when a symbol's own compilation (`Compilation`) reports it untainted.
    // Null (default, and every existing single-compilation caller) means "no
    // sibling set is known", so only `Compilation` is ever consulted — the
    // exact prior behavior.
    private readonly IReadOnlyList<CSharpCompilation> siblingCompilations;

    /// <summary>
    /// Initializes a new instance of the <see cref="TranslationContext"/> class.
    /// </summary>
    /// <param name="compilation">The owning C# compilation.</param>
    /// <param name="semanticModel">The active semantic model for the file being translated.</param>
    /// <param name="filePath">The originating file path, used to tag diagnostics.</param>
    /// <param name="siblingCompilations">
    /// Issue #2412: every project's own <see cref="CSharpCompilation"/> loaded
    /// alongside <paramref name="compilation"/> in the same migration run (the
    /// app plus its transitively-referenced sibling projects). A whole-program
    /// fact computed only from one compilation's own syntax trees (e.g.
    /// <see cref="Translator.ObliviousNullabilityAnalyzer"/>'s taint fixpoint)
    /// can be TRUE in a sibling project's own result for a symbol this
    /// compilation cannot prove tainted on its own — not only because the
    /// symbol is declared there, but also because that sibling's own
    /// interface-implementation edges (issue #2285) can record taint for a
    /// symbol declared in a THIRD project (an interface member implemented by
    /// one of the sibling's own types). Pass <see langword="null"/> (default)
    /// for a single-compilation translation (in-memory tests, <c>CompileViaSdk</c>,
    /// a project with no references) — only <paramref name="compilation"/> is
    /// then ever consulted, the exact prior behavior.
    /// </param>
    public TranslationContext(
        CSharpCompilation compilation,
        SemanticModel semanticModel,
        string filePath,
        IReadOnlyList<CSharpCompilation> siblingCompilations = null)
    {
        this.Compilation = compilation ?? throw new ArgumentNullException(nameof(compilation));
        this.SemanticModel = semanticModel ?? throw new ArgumentNullException(nameof(semanticModel));
        this.FilePath = filePath;
        this.siblingCompilations = siblingCompilations;
    }

    /// <summary>Gets the owning C# compilation.</summary>
    public CSharpCompilation Compilation { get; }

    /// <summary>
    /// Gets every project's own <see cref="CSharpCompilation"/> loaded
    /// alongside <see cref="Compilation"/> in the same migration run (issue
    /// #2412), or <see langword="null"/> when no sibling set is known (a
    /// single-compilation translation).
    /// </summary>
    public IReadOnlyList<CSharpCompilation> SiblingCompilations => this.siblingCompilations;

    /// <summary>Gets the active semantic model for the file being translated.</summary>
    public SemanticModel SemanticModel { get; private set; }

    /// <summary>Gets the originating file path.</summary>
    public string FilePath { get; }

    /// <summary>Gets the diagnostics recorded so far, in insertion order.</summary>
    public IReadOnlyList<TranslationDiagnostic> Diagnostics => this.diagnostics.ToImmutableArray();

    /// <summary>
    /// Issue #1910: temporarily makes the semantic model bound to
    /// <paramref name="tree"/> the active <see cref="SemanticModel"/>, so nodes
    /// belonging to a different partial-declaration part (in another file) can
    /// be resolved through the usual <see cref="GetDeclaredSymbol"/>/
    /// <see cref="GetSymbolInfo"/>/<see cref="GetTypeInfo"/> seams. Dispose the
    /// returned scope to restore the previous model.
    /// </summary>
    /// <param name="tree">The syntax tree the next node(s) to resolve belong to.</param>
    /// <returns>A scope that restores the previous active model on <see cref="IDisposable.Dispose"/>.</returns>
    public IDisposable UseSemanticModelFor(SyntaxTree tree)
    {
        if (tree is null || tree == this.SemanticModel.SyntaxTree)
        {
            return NoOpScope.Instance;
        }

        if (!this.modelsByTree.TryGetValue(tree, out SemanticModel model))
        {
            model = this.Compilation.GetSemanticModel(tree);
            this.modelsByTree[tree] = model;
        }

        SemanticModel previous = this.SemanticModel;
        this.SemanticModel = model;
        return new RestoreModelScope(this, previous);
    }

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

        // The exhaustiveness choke point (ADR-0138): a kind registered in
        // UnsupportedByDesign is a recorded design decision; anything else is
        // an accidental fallthrough classified as a gap, which the coverage
        // tests and the triage pipeline surface loudly until it is either
        // translated or registered with a rationale.
        var diagnostic = new TranslationDiagnostic(
            node.Kind().ToString(),
            message,
            node.GetLocation(),
            TranslationSeverity.Unsupported);
        if (UnsupportedByDesign.TryGetRationale(node.Kind(), out UnsupportedRationale rationale))
        {
            diagnostic.Classification = UnsupportedClassification.ByDesign;
            diagnostic.Rationale = rationale;
        }

        this.diagnostics.Add(diagnostic);
    }

    private sealed class RestoreModelScope : IDisposable
    {
        private readonly TranslationContext owner;
        private readonly SemanticModel previous;

        public RestoreModelScope(TranslationContext owner, SemanticModel previous)
        {
            this.owner = owner;
            this.previous = previous;
        }

        public void Dispose() => this.owner.SemanticModel = this.previous;
    }

    private sealed class NoOpScope : IDisposable
    {
        public static readonly NoOpScope Instance = new NoOpScope();

        public void Dispose()
        {
        }
    }
}
