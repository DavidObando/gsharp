// <copyright file="DebugInformationFormat.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

/// Selects how debug information is emitted alongside the compiled PE.
/// Mirrors the C# / Roslyn nomenclature so SDK consumers can use the same
/// MSBuild semantics. The full PDB pipeline is implemented across Phases
/// 4–7 of ADR-0027 §7.7; this Phase 3 enum is the option surface that
/// downstream phases consume.
enum DebugInformationFormat {
    None,
    Portable,
    Embedded
}
