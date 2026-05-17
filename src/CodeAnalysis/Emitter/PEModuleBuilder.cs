// <copyright file="PEModuleBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

using Microsoft.Cci;

namespace Gsharp.CodeAnalysis.Emitter;

/// <summary>
/// GSharp's <see cref="CommonPEModuleBuilder"/> subclass. Roslyn's emit pipeline walks
/// this object to serialize a managed PE.
/// </summary>
/// <remarks>
/// Mirrors <c>Pchp.CodeAnalysis.Emit.PEModuleBuilder</c> from peachpie:
/// <c>/tmp/peachpie-study/src/Peachpie.CodeAnalysis/Emitter/Model/PEModuleBuilder.cs</c>.
/// </remarks>
internal abstract partial class PEModuleBuilder : CommonPEModuleBuilder
{
    // TODO Phase 1: enumerate GsharpTypeSymbol instances to expose them as CCI types.
    // TODO Phase 1: synthesize a top-level <Module> Main entry point that wraps the
    //   user's `func Main()` (matching design/Gsharp-design-v0.1.md).
}

#endif
