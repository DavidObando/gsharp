// <copyright file="DiagnosticSeverity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

/// Severity of a compiler diagnostic message. Ordered from least to most
/// severe (Roslyn ordering), so relational comparisons are meaningful.
enum DiagnosticSeverity {
    Hidden,
    Info,
    Warning,
    Error
}
