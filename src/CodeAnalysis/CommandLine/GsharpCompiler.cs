// <copyright file="GsharpCompiler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

using Microsoft.CodeAnalysis;

namespace Gsharp.CodeAnalysis.CommandLine;

/// <summary>
/// CLI host for <c>gsc</c>. Subclasses Roslyn's <see cref="CommonCompiler"/>
/// so we get standard /r, /out, /target, /debug, /keyfile handling for free.
/// </summary>
/// <remarks>
/// Mirrors <c>Pchp.CodeAnalysis.CommandLine.PhpCompiler</c> from peachpie:
/// <c>/tmp/peachpie-study/src/Peachpie.CodeAnalysis/CommandLine/PhpCompiler.cs</c>.
/// </remarks>
internal abstract class GsharpCompiler : CommonCompiler
{
    // TODO Phase 3: implement constructor wiring sources, refs, response file, build paths.
    // TODO Phase 3: override CreateCompilation to construct a GsharpCompilation.
}

#endif
