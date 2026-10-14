// <copyright file="DiagnosticWriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.IO

import GSharp.Core.CodeAnalysis
import System.Collections.Generic
import System.IO

/// Provides an ordinary CLR type entry point for diagnostic rendering.
shared class DiagnosticWriter {
    /// Writes diagnostics using the compiler's standard rendering.
    /// @param writer The destination writer.
    /// @param diagnostics The diagnostics to render.
    func WriteDiagnostics(writer TextWriter, diagnostics IEnumerable[Diagnostic]) {
        writer.WriteDiagnostics(diagnostics)
    }
}
