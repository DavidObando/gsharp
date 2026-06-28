#nullable disable

// <copyright file="DiagnosticSeverity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Severity of a compiler diagnostic message.
/// </summary>
public enum DiagnosticSeverity
{
    /// <summary>Informational diagnostic that does not prevent compilation.</summary>
    Info,

    /// <summary>Warning diagnostic that does not prevent compilation unless <c>/warnaserror</c> is active.</summary>
    Warning,

    /// <summary>Error diagnostic that prevents the compilation from succeeding.</summary>
    Error,
}
