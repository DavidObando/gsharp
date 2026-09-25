// <copyright file="BoundBodyAnalysisContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// The context passed to bound-body actions — the counterpart of Roslyn's
/// <c>OperationBlockAnalysisContext</c> (ADR-0169, issue #4436). A body
/// action runs once per declared function body and sees the whole bound
/// body at once, so a rule can relate nodes to each other (a local's
/// initializer to its later uses, say) without walking up a parent chain,
/// which bound nodes do not have.
/// </summary>
/// <remarks>
/// Function literals and local functions are bound inside the body that
/// declares them, so they are part of that body, as they are part of their
/// containing method's operation block in Roslyn. Top-level statements have
/// no owning function and are not dispatched to body actions.
/// </remarks>
public readonly struct BoundBodyAnalysisContext
{
    private readonly Action<Diagnostic> reportDiagnostic;

    internal BoundBodyAnalysisContext(
        FunctionSymbol owningFunction,
        BoundNode body,
        Compilation.Compilation compilation,
        Action<Diagnostic> reportDiagnostic,
        CancellationToken cancellationToken)
    {
        OwningFunction = owningFunction;
        Bodies = ImmutableArray.Create(body);
        Compilation = compilation;
        this.reportDiagnostic = reportDiagnostic;
        CancellationToken = cancellationToken;
    }

    /// <summary>Gets the function whose body is being analyzed.</summary>
    public FunctionSymbol OwningFunction { get; }

    /// <summary>
    /// Gets the function whose body is being analyzed as a <see cref="Symbol"/>
    /// — the Roslyn <c>OwningSymbol</c> analogue.
    /// </summary>
    public Symbol OwningSymbol => OwningFunction;

    /// <summary>
    /// Gets the bound body — the Roslyn <c>OperationBlocks</c> analogue. A G#
    /// function has one body, so this always has exactly one element.
    /// </summary>
    public ImmutableArray<BoundNode> Bodies { get; }

    /// <summary>Gets the compilation being analyzed.</summary>
    public Compilation.Compilation Compilation { get; }

    /// <summary>Gets the token that cancels the analysis run.</summary>
    public CancellationToken CancellationToken { get; }

    /// <summary>
    /// Reports a diagnostic. The diagnostic's ID must be declared in the
    /// reporting analyzer's SupportedDiagnostics.
    /// </summary>
    /// <param name="diagnostic">The diagnostic to report.</param>
    public void ReportDiagnostic(Diagnostic diagnostic) => reportDiagnostic(diagnostic);
}
