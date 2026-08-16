// <copyright file="DiagnosticWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis;

namespace GSharp.Core.IO;

/// <summary>
/// Provides an ordinary CLR type entry point for diagnostic rendering.
/// </summary>
public static class DiagnosticWriter
{
    /// <summary>
    /// Writes diagnostics using the compiler's standard rendering.
    /// </summary>
    /// <param name="writer">The destination writer.</param>
    /// <param name="diagnostics">The diagnostics to render.</param>
    public static void WriteDiagnostics(TextWriter writer, IEnumerable<Diagnostic> diagnostics)
    {
        writer.WriteDiagnostics(diagnostics);
    }
}
