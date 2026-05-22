// <copyright file="GsharpCompiler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

namespace Gsharp.CodeAnalysis.CommandLine;

/// <summary>
/// CLI host for <c>gsc</c>. Will subclass Roslyn's <c>CommonCompiler</c> in Phase 3.
/// </summary>
/// <remarks>
/// Mirrors <c>Pchp.CodeAnalysis.CommandLine.PhpCompiler</c> from peachpie:
/// <c>/tmp/peachpie-study/src/Peachpie.CodeAnalysis/CommandLine/PhpCompiler.cs</c>.
/// </remarks>
internal abstract class GsharpCompiler
{
    // TODO Phase 3: extend CommonCompiler; implement constructor wiring sources, refs,
    // response file, build paths. Override CreateCompilation to construct a
    // GsharpCompilation. Deferred until Phase 1 emit lands.
}

#endif
