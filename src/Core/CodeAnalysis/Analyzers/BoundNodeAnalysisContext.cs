// <copyright file="BoundNodeAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to bound-node actions — the counterpart of Roslyn's
/// <c>OperationAnalysisContext</c>, with <see cref="BoundNode"/> standing in
/// for <c>IOperation</c> (ADR-0169). <see cref="BoundNode.Syntax"/> may be
/// null for synthesized nodes; report locations against the nearest anchored
/// ancestor via <see cref="ContainingFunction"/> when it is.
/// </summary>
public readonly struct BoundNodeAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal BoundNodeAnalysisContext(
        BoundNode boundNode,
        FunctionSymbol? containingFunction,
        Compilation.Compilation compilation,
        Action<Diagnostic> reportDiagnostic,
        CancellationToken cancellationToken)
    {
        BoundNode = boundNode;
        ContainingFunction = containingFunction;
        Compilation = compilation;
        this.reportDiagnostic = reportDiagnostic;
        CancellationToken = cancellationToken;
    }

    /// <summary>
    /// Gets the bound node being analyzed.
    /// </summary>
    public BoundNode BoundNode { get; }

    /// <summary>
    /// Gets the function whose body contains the node, or null for top-level
    /// statements.
    /// </summary>
    public FunctionSymbol? ContainingFunction { get; }

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
