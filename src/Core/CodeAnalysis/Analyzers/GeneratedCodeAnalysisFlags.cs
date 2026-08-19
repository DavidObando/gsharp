// <copyright file="GeneratedCodeAnalysisFlags.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// Controls whether an analyzer runs on, and reports in, generated code
/// (<c>.g.gs</c> trees). Mirrors Roslyn's enum of the same name (ADR-0169).
/// </summary>
[Flags]
public enum GeneratedCodeAnalysisFlags
{
    /// <summary>Skip generated trees entirely.</summary>
    None = 0,

    /// <summary>Run callbacks on generated trees.</summary>
    Analyze = 1,

    /// <summary>Report diagnostics located in generated trees.</summary>
    ReportDiagnostics = 2,
}
