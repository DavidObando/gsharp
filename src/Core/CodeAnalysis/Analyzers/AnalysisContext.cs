// <copyright file="AnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The registration surface passed to
/// <see cref="GSharpDiagnosticAnalyzer.Initialize"/>. Mirrors Roslyn's
/// <c>AnalysisContext</c> (ADR-0169); registrations are scoped to the current
/// driver run.
/// </summary>
public class AnalysisContext
{
    private readonly AnalyzerRegistry registry;
    private readonly GSharpDiagnosticAnalyzer owner;

    internal AnalysisContext(AnalyzerRegistry registry, GSharpDiagnosticAnalyzer owner)
    {
        this.registry = registry;
        this.owner = owner;
    }

    private protected AnalyzerRegistry Registry => registry;

    private protected GSharpDiagnosticAnalyzer Owner => owner;

    /// <summary>
    /// Registers a callback for syntax nodes of the given kinds.
    /// </summary>
    /// <param name="action">The callback.</param>
    /// <param name="syntaxKinds">The node kinds to dispatch on.</param>
    public void RegisterSyntaxNodeAction(Action<SyntaxNodeAnalysisContext> action, params SyntaxKind[] syntaxKinds)
        => registry.AddKeyed(registry.SyntaxNodeActions, owner, action, syntaxKinds);

    /// <summary>
    /// Registers a callback for declared symbols of the given kinds.
    /// </summary>
    /// <param name="action">The callback.</param>
    /// <param name="symbolKinds">The symbol kinds to dispatch on.</param>
    public void RegisterSymbolAction(Action<SymbolAnalysisContext> action, params SymbolKind[] symbolKinds)
        => registry.AddKeyed(registry.SymbolActions, owner, action, symbolKinds);

    /// <summary>
    /// Registers a callback for bound nodes of the given kinds — the
    /// counterpart of Roslyn's <c>RegisterOperationAction</c> (ADR-0169;
    /// bound-node member shapes are stable at the kind level only).
    /// </summary>
    /// <param name="action">The callback.</param>
    /// <param name="boundNodeKinds">The bound-node kinds to dispatch on.</param>
    public void RegisterBoundNodeAction(Action<BoundNodeAnalysisContext> action, params BoundNodeKind[] boundNodeKinds)
        => registry.AddKeyed(registry.BoundNodeActions, owner, action, boundNodeKinds);

    /// <summary>
    /// Registers a callback invoked once per syntax tree, before binding-time
    /// actions.
    /// </summary>
    /// <param name="action">The callback.</param>
    public void RegisterSyntaxTreeAction(Action<SyntaxTreeAnalysisContext> action)
        => registry.SyntaxTreeActions.Add(new AnalyzerActionEntry<SyntaxTreeAnalysisContext>(owner, action));

    /// <summary>
    /// Registers a callback invoked once per syntax tree after binding, with
    /// the tree's <see cref="SemanticModel"/>.
    /// </summary>
    /// <param name="action">The callback.</param>
    public void RegisterSemanticModelAction(Action<SemanticModelAnalysisContext> action)
        => registry.SemanticModelActions.Add(new AnalyzerActionEntry<SemanticModelAnalysisContext>(owner, action));

    /// <summary>
    /// Registers a callback invoked at the start of the compilation pass,
    /// which may register further actions (including compilation-end
    /// actions) sharing state.
    /// </summary>
    /// <param name="action">The callback.</param>
    public void RegisterCompilationStartAction(Action<CompilationStartAnalysisContext> action)
        => registry.CompilationStartActions.Add(new AnalyzerActionEntry<CompilationStartAnalysisContext>(owner, action));

    /// <summary>
    /// Registers a callback invoked once after all other actions have run.
    /// </summary>
    /// <param name="action">The callback.</param>
    public void RegisterCompilationAction(Action<CompilationAnalysisContext> action)
        => registry.CompilationActions.Add(new AnalyzerActionEntry<CompilationAnalysisContext>(owner, action));

    /// <summary>
    /// Recorded no-op: the driver is sequential in v1 (ADR-0169). Present so
    /// mechanically translated Roslyn analyzers compile unchanged.
    /// </summary>
    public void EnableConcurrentExecution()
    {
    }

    /// <summary>
    /// Configures whether this analyzer runs on generated (<c>.g.gs</c>)
    /// trees. Defaults to <see cref="GeneratedCodeAnalysisFlags.None"/>.
    /// </summary>
    /// <param name="flags">The generated-code analysis mode.</param>
    public void ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags flags)
        => registry.GeneratedCodeFlags[owner] = flags;
}
