// <copyright file="CompilationAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to compilation and compilation-end actions (Roslyn's
/// <c>CompilationAnalysisContext</c>).
/// </summary>
public readonly struct CompilationAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal CompilationAnalysisContext(Compilation.Compilation compilation, Action<Diagnostic> reportDiagnostic, CancellationToken cancellationToken)
    {
        Compilation = compilation;
        this.reportDiagnostic = reportDiagnostic;
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
    /// Reports a diagnostic. The diagnostic's ID must be declared in the
    /// reporting analyzer's SupportedDiagnostics.
    /// </summary>
    /// <param name="diagnostic">The diagnostic to report.</param>
    public void ReportDiagnostic(Diagnostic diagnostic) => reportDiagnostic(diagnostic);
}
