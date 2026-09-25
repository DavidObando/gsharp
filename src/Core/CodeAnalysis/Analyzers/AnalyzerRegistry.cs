// <copyright file="AnalyzerRegistry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The registration store a <see cref="GSharpAnalyzerDriver"/> run dispatches
/// from: kind-bucketed action lists, each entry tagged with its owning
/// analyzer so crashes disable by owner and reports validate against the
/// owner's <see cref="GSharpDiagnosticAnalyzer.SupportedDiagnostics"/>.
/// </summary>
internal sealed class AnalyzerRegistry
{
    public Dictionary<SyntaxKind, List<AnalyzerActionEntry<SyntaxNodeAnalysisContext>>> SyntaxNodeActions { get; } = new();

    public Dictionary<SymbolKind, List<AnalyzerActionEntry<SymbolAnalysisContext>>> SymbolActions { get; } = new();

    public Dictionary<BoundNodeKind, List<AnalyzerActionEntry<BoundNodeAnalysisContext>>> BoundNodeActions { get; } = new();

    public List<AnalyzerActionEntry<BoundBodyAnalysisContext>> BoundBodyActions { get; } = new();

    public List<AnalyzerActionEntry<SyntaxTreeAnalysisContext>> SyntaxTreeActions { get; } = new();

    public List<AnalyzerActionEntry<SemanticModelAnalysisContext>> SemanticModelActions { get; } = new();

    public List<AnalyzerActionEntry<CompilationStartAnalysisContext>> CompilationStartActions { get; } = new();

    public List<AnalyzerActionEntry<CompilationAnalysisContext>> CompilationEndActions { get; } = new();

    public List<AnalyzerActionEntry<CompilationAnalysisContext>> CompilationActions { get; } = new();

    public Dictionary<GSharpDiagnosticAnalyzer, GeneratedCodeAnalysisFlags> GeneratedCodeFlags { get; } = new();

    public void AddKeyed<TKind, TContext>(
        Dictionary<TKind, List<AnalyzerActionEntry<TContext>>> bucket,
        GSharpDiagnosticAnalyzer owner,
        Action<TContext> action,
        TKind[] kinds)
        where TKind : notnull
    {
        // Issue #4436: several Roslyn kinds can map to one G# kind (a type,
        // declaration and recursive pattern are all a G# TypePattern), so one
        // registration naming them all must still dispatch each node once.
        // First-seen order is kept so registration order stays deterministic.
        var seen = new HashSet<TKind>();
        foreach (var kind in kinds)
        {
            if (!seen.Add(kind))
            {
                continue;
            }

            if (!bucket.TryGetValue(kind, out var entries))
            {
                entries = new List<AnalyzerActionEntry<TContext>>();
                bucket.Add(kind, entries);
            }

            entries.Add(new AnalyzerActionEntry<TContext>(owner, action));
        }
    }
}
