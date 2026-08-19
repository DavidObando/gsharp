// <copyright file="SyntaxTreeAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to syntax-tree actions (parse-level; no semantics).
/// </summary>
public readonly struct SyntaxTreeAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal SyntaxTreeAnalysisContext(SyntaxTree tree, Action<Diagnostic> reportDiagnostic, CancellationToken cancellationToken)
    {
        Tree = tree;
        this.reportDiagnostic = reportDiagnostic;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the syntax tree being analyzed.
    /// </summary>
    public SyntaxTree Tree { get; }

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
