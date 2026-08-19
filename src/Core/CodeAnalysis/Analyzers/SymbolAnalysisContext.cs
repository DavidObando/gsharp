// <copyright file="SymbolAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to symbol actions (Roslyn's
/// <c>SymbolAnalysisContext</c>).
/// </summary>
public readonly struct SymbolAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal SymbolAnalysisContext(
        Symbol symbol,
        Compilation.Compilation compilation,
        Action<Diagnostic> reportDiagnostic,
        CancellationToken cancellationToken)
    {
        Symbol = symbol;
        Compilation = compilation;
        this.reportDiagnostic = reportDiagnostic;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the declared symbol being analyzed.
    /// </summary>
    public Symbol Symbol { get; }

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
