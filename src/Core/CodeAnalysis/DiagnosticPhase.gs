// <copyright file="DiagnosticPhase.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

/// The pipeline that reported a diagnostic (#6177, ADR-0225 follow-up).
enum DiagnosticPhase {
    /// A diagnostic that no compilation pipeline reported: an analyzer's, or one that a host created.
    Unknown,
    /// The lexer or the parser.
    Parse,
    /// The declaration bind: types, members and signatures, the entry point, documentation comments.
    Declaration,
    /// The bind of member bodies and top-level statements, with their flow analyses.
    Body,
    /// Lowering and emit.
    Emit
}
