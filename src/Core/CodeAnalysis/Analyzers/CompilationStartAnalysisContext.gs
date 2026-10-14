// <copyright file="CompilationStartAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis.Compilation
import System
import System.Threading

/// The context for (cref:AnalysisContext.RegisterCompilationStartAction)
/// callbacks: exposes the compilation and the same registration surface, plus
/// compilation-end registration, so per-compilation state can be shared
/// between actions (Roslyn's `CompilationStartAnalysisContext`).
class CompilationStartAnalysisContext : AnalysisContext {
    internal init(
        registry AnalyzerRegistry,
        owner GSharpDiagnosticAnalyzer,
        compilation Compilation,
        cancellationToken CancellationToken
    ) : base(registry, owner) {
        Compilation = compilation
        CancellationToken = cancellationToken
    }

    /// Gets the compilation being analyzed.
    prop Compilation Compilation {
        get;
    }

    /// Gets the token that cancels the analysis run.
    prop CancellationToken CancellationToken {
        get;
    }

    /// Registers a callback invoked once after every other action of this
    /// analyzer has run for the compilation.
    /// @param action The callback.
    func RegisterCompilationEndAction(action(CompilationAnalysisContext) -> void) -> Registry.CompilationEndActions.Add(
        AnalyzerActionEntry[CompilationAnalysisContext](Owner, action)
    )
}
