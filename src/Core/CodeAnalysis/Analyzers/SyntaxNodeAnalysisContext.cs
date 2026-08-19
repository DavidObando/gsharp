// <copyright file="SyntaxNodeAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to syntax-node actions (Roslyn's
/// <c>SyntaxNodeAnalysisContext</c>).
/// </summary>
public readonly struct SyntaxNodeAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal SyntaxNodeAnalysisContext(
        SyntaxNode node,
        SemanticModel semanticModel,
        Action<Diagnostic> reportDiagnostic,
        CancellationToken cancellationToken)
    {
        Node = node;
        SemanticModel = semanticModel;
        this.reportDiagnostic = reportDiagnostic;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the node being analyzed.
    /// </summary>
    public SyntaxNode Node { get; }

    /// <summary>
    /// Gets the semantic model for the node's tree.
    /// </summary>
    public SemanticModel SemanticModel { get; }

    /// <summary>
    /// Gets the compilation being analyzed.
    /// </summary>
    public Compilation.Compilation Compilation => SemanticModel.Compilation;

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
