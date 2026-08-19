// <copyright file="GSharpDiagnosticAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// Base class for G# diagnostic analyzers (ADR-0169). The counterpart of
/// Roslyn's <c>DiagnosticAnalyzer</c>: implementations declare the rules they
/// can produce via <see cref="SupportedDiagnostics"/> and register callbacks
/// in <see cref="Initialize"/>. Concrete analyzers must also carry
/// <see cref="GSharpDiagnosticAnalyzerAttribute"/> and expose a parameterless
/// constructor to be discoverable by the host.
/// </summary>
public abstract class GSharpDiagnosticAnalyzer
{
    /// <summary>
    /// Gets the descriptors of every diagnostic this analyzer can produce.
    /// Reporting a diagnostic whose ID is not declared here is suppressed and
    /// surfaced as GS9304.
    /// </summary>
    public abstract ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; }

    /// <summary>
    /// Called once per analysis run to register the analyzer's actions.
    /// </summary>
    /// <param name="context">The registration surface.</param>
    public abstract void Initialize(AnalysisContext context);
}
