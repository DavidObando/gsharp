// <copyright file="AnalyzerOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Analyzers

/// Host-supplied options for a (cref:GSharpAnalyzerDriver) run.
class AnalyzerOptions {
    /// Gets or sets the per-analyzer wall-clock budget in milliseconds, or
    /// `null` for no budget. An analyzer whose accumulated
    /// callback time exceeds the budget is disabled for the rest of the run
    /// and reports GS9302. Interactive hosts (the language server) set this;
    /// batch compilation leaves it unset.
    prop TimeBudgetMilliseconds int32?
}
