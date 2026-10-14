// <copyright file="AnalyzerRegistry.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic

/// The registration store a (cref:GSharpAnalyzerDriver) run dispatches
/// from: kind-bucketed action lists, each entry tagged with its owning
/// analyzer so crashes disable by owner and reports validate against the
/// owner's (cref:GSharpDiagnosticAnalyzer.SupportedDiagnostics).
internal class AnalyzerRegistry {
    init() {
        SyntaxNodeActions = Dictionary[SyntaxKind, List[AnalyzerActionEntry[SyntaxNodeAnalysisContext]]]()
        SymbolActions = Dictionary[SymbolKind, List[AnalyzerActionEntry[SymbolAnalysisContext]]]()
        BoundNodeActions = Dictionary[BoundNodeKind, List[AnalyzerActionEntry[BoundNodeAnalysisContext]]]()
        BoundBodyActions = List[AnalyzerActionEntry[BoundBodyAnalysisContext]]()
        SyntaxTreeActions = List[AnalyzerActionEntry[SyntaxTreeAnalysisContext]]()
        SemanticModelActions = List[AnalyzerActionEntry[SemanticModelAnalysisContext]]()
        CompilationStartActions = List[AnalyzerActionEntry[CompilationStartAnalysisContext]]()
        CompilationEndActions = List[AnalyzerActionEntry[CompilationAnalysisContext]]()
        CompilationActions = List[AnalyzerActionEntry[CompilationAnalysisContext]]()
        GeneratedCodeFlags = Dictionary[GSharpDiagnosticAnalyzer, GeneratedCodeAnalysisFlags]()
    }

    prop SyntaxNodeActions Dictionary[SyntaxKind, List[AnalyzerActionEntry[SyntaxNodeAnalysisContext]]] {
        get;
    }

    prop SymbolActions Dictionary[SymbolKind, List[AnalyzerActionEntry[SymbolAnalysisContext]]] {
        get;
    }

    prop BoundNodeActions Dictionary[BoundNodeKind, List[AnalyzerActionEntry[BoundNodeAnalysisContext]]] {
        get;
    }

    prop BoundBodyActions List[AnalyzerActionEntry[BoundBodyAnalysisContext]] {
        get;
    }

    prop SyntaxTreeActions List[AnalyzerActionEntry[SyntaxTreeAnalysisContext]] {
        get;
    }

    prop SemanticModelActions List[AnalyzerActionEntry[SemanticModelAnalysisContext]] {
        get;
    }

    prop CompilationStartActions List[AnalyzerActionEntry[CompilationStartAnalysisContext]] {
        get;
    }

    prop CompilationEndActions List[AnalyzerActionEntry[CompilationAnalysisContext]] {
        get;
    }

    prop CompilationActions List[AnalyzerActionEntry[CompilationAnalysisContext]] {
        get;
    }

    prop GeneratedCodeFlags Dictionary[GSharpDiagnosticAnalyzer, GeneratedCodeAnalysisFlags] {
        get;
    }

    func AddKeyed[TKind, TContext](
        bucket Dictionary[TKind, List[AnalyzerActionEntry[TContext]]],
        owner GSharpDiagnosticAnalyzer,
        action(TContext) -> void,
        kinds[]TKind
    ) {
        // Issue #4436: several Roslyn kinds can map to one G# kind (a type,
        // declaration and recursive pattern are all a G# TypePattern), so one
        // registration naming them all must still dispatch each node once.
        // First-seen order is kept so registration order stays deterministic.
        let seen = HashSet[TKind]()
        for kind in kinds {
            if !seen.Add(kind) {
                continue
            }
            if !bucket.TryGetValue(kind, out var entries) {
                entries = List[AnalyzerActionEntry[TContext]]()
                bucket.Add(kind, entries)
            }
            entries.Add(AnalyzerActionEntry[TContext](owner, action))
        }
    }
}
