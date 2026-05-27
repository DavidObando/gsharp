// <copyright file="DebugInformationFormat.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Selects how debug information is emitted alongside the compiled PE.
/// Mirrors the C# / Roslyn nomenclature so SDK consumers can use the same
/// MSBuild semantics. The full PDB pipeline is implemented across Phases
/// 4–7 of ADR-0027 §7.7; this Phase 3 enum is the option surface that
/// downstream phases consume.
/// </summary>
public enum DebugInformationFormat
{
    /// <summary>
    /// Do not emit any debug information. The PE still goes out, but no
    /// PDB sidecar is produced and no <c>Debug</c> directory entries
    /// describing a PDB are written. Equivalent to <c>/debug-</c>.
    /// </summary>
    None = 0,

    /// <summary>
    /// Emit a Portable PDB sidecar file next to the PE. The PE's
    /// <c>Debug</c> directory carries a <c>CodeView</c> entry pointing at
    /// the sidecar by name and a matching <c>PdbChecksum</c> entry.
    /// Equivalent to <c>/debug</c>, <c>/debug+</c>, <c>/debug:portable</c>,
    /// and <c>/debug:full</c>.
    /// </summary>
    Portable = 1,

    /// <summary>
    /// Emit the Portable PDB stream embedded directly into the PE via an
    /// <c>EmbeddedPortablePdb</c> debug-directory entry — no sidecar file
    /// is produced. Equivalent to <c>/debug:embedded</c>.
    /// </summary>
    Embedded = 2,
}
