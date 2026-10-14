// <copyright file="GSharpDiagnosticAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import GSharp.Core.CodeAnalysis
import System.Collections.Immutable

/// Base class for G# diagnostic analyzers (ADR-0169). The counterpart of
/// Roslyn's `DiagnosticAnalyzer`: implementations declare the rules they
/// can produce via (cref:SupportedDiagnostics) and register callbacks
/// in (cref:Initialize). Concrete analyzers must also carry
/// (cref:GSharpDiagnosticAnalyzerAttribute) and expose a parameterless
/// constructor to be discoverable by the host.
abstract class GSharpDiagnosticAnalyzer {
    /// Gets the descriptors of every diagnostic this analyzer can produce.
    /// Reporting a diagnostic whose ID is not declared here is suppressed and
    /// surfaced as GS9304.
    abstract prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] {
        get;
    }

    /// Called once per analysis run to register the analyzer's actions.
    /// @param context The registration surface.
    open func Initialize(context AnalysisContext);
}
