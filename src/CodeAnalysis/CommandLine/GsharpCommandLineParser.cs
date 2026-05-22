// <copyright file="GsharpCommandLineParser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

using Microsoft.CodeAnalysis;

namespace Gsharp.CodeAnalysis.CommandLine;

/// <summary>
/// Parses gsc command-line arguments into a <see cref="CommandLineArguments"/>.
/// </summary>
/// <remarks>
/// Mirrors <c>Pchp.CodeAnalysis.CommandLine.PhpCommandLineParser</c>.
/// </remarks>
internal sealed class GsharpCommandLineParser : CommandLineParser
{
    // TODO Phase 3: implement.
    internal GsharpCommandLineParser()
        : base(MessageProvider.Instance, isScriptCommandLineParser: false)
    {
    }

    // Roslyn's MessageProvider is per-language. We can either reuse C#'s or
    // provide a minimal GSharp implementation; decision deferred to Phase 3.
    private sealed class MessageProvider : CommonMessageProvider
    {
        public static readonly MessageProvider Instance = new();
        // … intentionally elided in this skeleton.
    }
}

#endif
