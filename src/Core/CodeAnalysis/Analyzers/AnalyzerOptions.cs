// <copyright file="AnalyzerOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Analyzers;

/// <summary>
/// Host-supplied options for a <see cref="GSharpAnalyzerDriver"/> run.
/// </summary>
public sealed class AnalyzerOptions
{
    /// <summary>
    /// Gets or sets the per-analyzer wall-clock budget in milliseconds, or
    /// <see langword="null"/> for no budget. An analyzer whose accumulated
    /// callback time exceeds the budget is disabled for the rest of the run
    /// and reports GS9302. Interactive hosts (the language server) set this;
    /// batch compilation leaves it unset.
    /// </summary>
    public int? TimeBudgetMilliseconds { get; set; }
}
