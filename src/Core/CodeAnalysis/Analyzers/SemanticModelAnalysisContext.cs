// <copyright file="SemanticModelAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to semantic-model actions: once per tree, after
/// binding (Roslyn's <c>SemanticModelAnalysisContext</c>).
/// </summary>
public readonly struct SemanticModelAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal SemanticModelAnalysisContext(SemanticModel semanticModel, Action<Diagnostic> reportDiagnostic, CancellationToken cancellationToken)
    {
        SemanticModel = semanticModel;
        this.reportDiagnostic = reportDiagnostic;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the semantic model for the tree being analyzed.
    /// </summary>
    public SemanticModel SemanticModel { get; }

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
