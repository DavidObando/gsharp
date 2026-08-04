// <copyright file="EmittedOracleOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace GSharp.Tests;

/// <summary>
/// Compilation-level knobs for <see cref="EmittedOracle.Evaluate(IReadOnlyList{string}, EmittedOracleOptions)"/>,
/// mirroring the <c>Compilation</c> properties the historical
/// <c>Compilation.Evaluate</c> tests set on their hand-built compilations
/// (Phase 3b.2, issue #3176). Defaults reproduce the plain
/// <c>EmittedOracle.Evaluate(source)</c> behavior exactly.
/// </summary>
public sealed class EmittedOracleOptions
{
    /// <summary>
    /// Gets reference assembly paths resolvable at compile and run time (the
    /// <c>/r:</c> channel); may be <see langword="null"/>.
    /// </summary>
    public IReadOnlyList<string> References { get; init; }

    /// <summary>
    /// Gets a value indicating whether the sources compile as a library
    /// (<c>Compilation.IsLibrary</c>): declarations only, no entry point, no
    /// submission wrapping — the oracle emits and returns diagnostics but
    /// never executes, exactly like the historical evaluator, which had
    /// nothing to run for a library compilation (top-level statements are an
    /// error under <c>IsLibrary</c>).
    /// </summary>
    public bool IsLibrary { get; init; }

    /// <summary>
    /// Gets the <c>Compilation.ImplicitSystemImport</c> override: whether an
    /// implicit <c>import System</c> is seeded before user imports.
    /// <see langword="null"/> keeps the compilation default
    /// (<see langword="true"/>).
    /// </summary>
    public bool? ImplicitSystemImport { get; init; }
}
