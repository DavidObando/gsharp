// <copyright file="NullabilityOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Threading

/// ADR-0186: the ambient (cref:NullabilityMode) for the compilation
/// currently being bound.
///
/// The mode is scoped with an (cref:AsyncLocal{T}) for the duration of a
/// bind, which makes it flow into the whole logical call — across the
/// `Task.Run` hops the language server uses — while staying invisible to
/// a concurrent bind of a different compilation, and to sibling xunit tests.
/// Issue #4372 retired the legacy `enabled` mode; `platform-types` is
/// the default and `oblivious` (ADR-0186 §9) makes unadorned source
/// declarations `T!` by default.
internal shared class NullabilityOptions {
    /// The restore token returned by (cref:Enter). A struct rather than
    /// a class so an always-taken `using` on the hot bind path allocates
    /// nothing.
    internal struct Scope : IDisposable {
        private let previous NullabilityMode?
        private let previousChecksSuppressed bool

        internal init(previous NullabilityMode?, previousChecksSuppressed bool) {
            this.previous = previous
            this.previousChecksSuppressed = previousChecksSuppressed
        }

        /// Restores the mode in effect before the corresponding (cref:Enter).
        func Dispose() {
            NullabilityOptions.Current.Value = this.previous
            NullabilityOptions.ChecksSuppressed.Value = this.previousChecksSuppressed
        }
    }

    /// The mode installed for the current logical call, or `null`
    /// when nothing installed one.
    private let Current AsyncLocal[NullabilityMode?] = AsyncLocal[NullabilityMode?]()

    /// ADR-0186 §4: whether the coercion check is inserted at each
    /// `T! -> T` boundary. Stored <b>inverted</b> — as "suppressed" —
    /// so that the unset (cref:AsyncLocal{T})'s `false` already
    /// means "checks on", which is the default the ADR specifies and the only
    /// supported mode.
    private let ChecksSuppressed AsyncLocal[bool] = AsyncLocal[bool]()

    /// Gets the mode in effect for the current logical call, falling back to
    /// (cref:DefaultMode) when nothing installed one.
    internal prop Mode NullabilityMode -> Current.Value ?? DefaultMode

    /// Gets the mode a `Compilation` starts at when its embedder does
    /// not say. Defaults to (cref:NullabilityMode.PlatformTypes);
    /// `GSHARP_NULLABILITY=oblivious` selects
    /// (cref:NullabilityMode.Oblivious) (see (cref:ParseEnvironmentMode)).
    private let _defaultMode NullabilityMode = ParseEnvironmentMode(
        Environment.GetEnvironmentVariable("GSHARP_NULLABILITY")
    )

    internal prop DefaultMode NullabilityMode {
        get {
            return _defaultMode
        }
    }

    /// Gets a value indicating whether an unadorned reference position written
    /// in G# source is oblivious (`T!`) when no enclosing
    /// `@Oblivious` / `@NullabilityEnabled` says otherwise — ADR-0186
    /// §9's compilation level, selected by `--nullability=oblivious`.
    internal prop SourceObliviousByDefault bool -> Mode == NullabilityMode.Oblivious

    /// Gets a value indicating whether ADR-0186 §4's runtime nil check is
    /// inserted at each `T! → T` coercion.
    ///
    /// <b>On</b> by default. `--platform-nil-checks=off` exists for
    /// measurement and as an escape hatch, and the ADR is explicit that it is
    /// <em>strictly weaker than either the old or the new model</em>: many of
    /// the sites it silences are compile errors today, and with checks off
    /// they are neither an error nor a check — the nil simply travels until
    /// something else notices.
    internal prop PlatformNilChecksEnabled bool -> !ChecksSuppressed.Value

    /// Reads `GSHARP_NULLABILITY`. Recognises `oblivious` (ADR-0186
    /// §9); anything else, including unset, selects
    /// (cref:NullabilityMode.PlatformTypes) (#4372 retired `enabled`).
    /// @param value The raw environment value.
    /// @returns The selected mode.
    internal func ParseEnvironmentMode(value string?) NullabilityMode {
        let normalized = value?.Replace("-", string.Empty, StringComparison.Ordinal)
        if string.Equals(normalized, "oblivious", StringComparison.OrdinalIgnoreCase) {
            return NullabilityMode.Oblivious
        }
        return NullabilityMode.PlatformTypes
    }

    /// Installs [`mode`](paramref) for the current logical call and
    /// restores the previous value when the returned scope is disposed.
    /// @param mode The mode to install.
    /// @param platformNilChecks Whether ADR-0186 §4's coercion check is inserted. Defaults to
    /// `true`, so every caller that does not opt out — every
    /// caller in the compiler, the language server and the test suite — gets
    /// the supported behaviour.
    /// @returns A scope that restores the previous mode on disposal.
    internal func Enter(mode NullabilityMode, platformNilChecks bool = true) NullabilityOptions.Scope {
        let previous = Current.Value
        let previousSuppressed = ChecksSuppressed.Value
        Current.Value = mode
        ChecksSuppressed.Value = !platformNilChecks
        return NullabilityOptions.Scope(previous, previousSuppressed)
    }
}
