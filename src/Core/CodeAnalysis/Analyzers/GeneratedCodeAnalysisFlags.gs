// <copyright file="GeneratedCodeAnalysisFlags.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

import System

/// Controls whether an analyzer runs on, and reports in, generated code
/// (`.g.gs` trees). Mirrors Roslyn's enum of the same name (ADR-0169).
@Flags
enum GeneratedCodeAnalysisFlags {
    None,
    Analyze,
    ReportDiagnostics
}
