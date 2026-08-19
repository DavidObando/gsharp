// <copyright file="DiagnosticSeverity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Severity of a compiler diagnostic message. Ordered from least to most
/// severe (Roslyn ordering), so relational comparisons are meaningful.
/// </summary>
public enum DiagnosticSeverity
{
    /// <summary>Diagnostic that is not surfaced to the user by default; carried for tooling (e.g. code fixes) or surfaced when promoted via severity configuration.</summary>
    Hidden = 0,

    /// <summary>Informational diagnostic that does not prevent compilation.</summary>
    Info = 1,

    /// <summary>Warning diagnostic that does not prevent compilation unless <c>/warnaserror</c> is active.</summary>
    Warning = 2,

    /// <summary>Error diagnostic that prevents the compilation from succeeding.</summary>
    Error = 3,
}
