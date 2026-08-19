// <copyright file="CompilationStartAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context for <see cref="AnalysisContext.RegisterCompilationStartAction"/>
/// callbacks: exposes the compilation and the same registration surface, plus
/// compilation-end registration, so per-compilation state can be shared
/// between actions (Roslyn's <c>CompilationStartAnalysisContext</c>).
/// </summary>
public sealed class CompilationStartAnalysisContext : AnalysisContext
{
    internal CompilationStartAnalysisContext(
        AnalyzerRegistry registry,
        GSharpDiagnosticAnalyzer owner,
        Compilation.Compilation compilation,
        CancellationToken cancellationToken)
        : base(registry, owner)
    {
        Compilation = compilation;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the compilation being analyzed.
    /// </summary>
    public Compilation.Compilation Compilation { get; }

    /// <summary>
    /// Gets the token that cancels the analysis run.
    /// </summary>
    public CancellationToken CancellationToken { get; }

    /// <summary>
    /// Registers a callback invoked once after every other action of this
    /// analyzer has run for the compilation.
    /// </summary>
    /// <param name="action">The callback.</param>
    public void RegisterCompilationEndAction(Action<CompilationAnalysisContext> action)
        => Registry.CompilationEndActions.Add(new AnalyzerActionEntry<CompilationAnalysisContext>(Owner, action));
}
