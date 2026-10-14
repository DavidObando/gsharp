// <copyright file="EmittedOracleOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import System.Collections.Generic

/// Compilation-level knobs for (cref:EmittedOracle.Evaluate(IReadOnlyList{string},
/// EmittedOracleOptions)),
/// mirroring the `Compilation` properties the historical
/// `Compilation.Evaluate` tests set on their hand-built compilations
/// (Phase 3b.2, issue #3176). Defaults reproduce the plain
/// `EmittedOracle.Evaluate(source)` behavior exactly.
class EmittedOracleOptions {
    /// Gets reference assembly paths resolvable at compile and run time (the
    /// `/r:` channel); may be `null`.
    prop References IReadOnlyList[string]? {
        get;
        init;
    }

    /// Gets a value indicating whether the sources compile as a library
    /// (`Compilation.IsLibrary`): declarations only, no entry point, no
    /// submission wrapping — the oracle emits and returns diagnostics but
    /// never executes, exactly like the historical evaluator, which had
    /// nothing to run for a library compilation (top-level statements are an
    /// error under `IsLibrary`).
    prop IsLibrary bool {
        get;
        init;
    }

    /// Gets the `Compilation.ImplicitSystemImport` override: whether an
    /// implicit `import System` is seeded before user imports.
    /// `null` keeps the compilation default
    /// (`true`).
    prop ImplicitSystemImport bool? {
        get;
        init;
    }
}
