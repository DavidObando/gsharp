// <copyright file="GsharpCommandLineParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

namespace Gsharp.CodeAnalysis.CommandLine;

/// <summary>
/// Parses gsc command-line arguments. Will subclass Roslyn's <c>CommandLineParser</c>
/// in Phase 3 once the GSharp <c>CommonMessageProvider</c> is implemented.
/// </summary>
/// <remarks>
/// Mirrors <c>Pchp.CodeAnalysis.CommandLine.PhpCommandLineParser</c>.
/// </remarks>
internal sealed class GsharpCommandLineParser
{
    // TODO Phase 3: extend CommandLineParser; provide a GSharp CommonMessageProvider.
    // The MessageProvider abstract surface (~100 members) is substantial; deferred
    // until the IL emit core works end-to-end so we know which diagnostics matter.
}

#endif
