// <copyright file="NullabilityOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Threading

/// ADR-0186: the ambient (cref:NullabilityMode) for the compilation
/// currently being bound.
///
/// <b>Why ambient, and why temporary.</b> This repository threads compilation
/// options explicitly (`Compilation.ImplicitSystemImport` reaches
/// `Binder.BindGlobalScope` as a parameter), and that is the right shape.
/// It is not available here: the metadata reader that must consult the mode is
/// `ClrNullability.SymbolFromFlagsOffset`, a static leaf reached from
/// (cref:NullabilityAnnotatedTypeSymbol), `MemberLookup`,
/// `NullableFlagsBuilder` and the importer, none of which carry a
/// `Compilation`. Threading one down would touch far more of the compiler
/// than the pivot this flag gates.
///
/// The mode is therefore scoped with an (cref:AsyncLocal{T}) for the
/// duration of a bind, which makes it flow into the whole logical call — across
/// the `Task.Run` hops the language server uses — while staying invisible
/// to a concurrent bind of a different compilation, and to sibling xunit tests.
/// It is set once at the start of a bind and never mutated mid-flight, so the
/// same-thread reentrancy hazard recorded in
/// `ClrOverloadResolution`'s "install/clear around the call" note does not
/// arise: there is no window to clear out from under a nested caller, only a
/// value that is uniform for the whole compilation.
///
/// <b>Step 1 said this type was scaffolding to delete at step 3. It is
/// kept, deliberately.</b> Step 3 flipped the default to
/// (cref:NullabilityMode.PlatformTypes), but the mode does not stop
/// being a choice there: (cref:NullabilityMode.Enabled) has to stay
/// selectable for two concrete reasons. ADR-0136's
/// `Issue3705MemberKindNullabilityDifferentialTests` asserts <em>both</em>
/// columns off one piece of real csc-emitted metadata — that differential is
/// the standing uniformity gate, and it cannot express "the other reading"
/// without a switch. And `--nullability=enabled` is the escape hatch the
/// release note points at for source the flip breaks. Issue #4356 deleted the
/// old member-lookup carve-out, so under this mode an oblivious member chain
/// (`Environment.Version.Major`) reports on its `T?` link exactly as
/// ADR-0136 always said it should, and needs `!!`, narrowing or
/// `?.`. Retiring the mode is a separate decision.
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
    ///
    /// <b>Nullable, not a bare enum, and that is load-bearing at step 3.</b>
    /// Step 1 relied on (cref:NullabilityMode.Enabled) being the enum's
    /// zero value so an unset (cref:AsyncLocal{T}) already answered the
    /// default. The flip makes that reasoning silently wrong in the dangerous
    /// direction: every reader that never entered a scope — and there are
    /// some, because `ClrNullability` is a static leaf reachable from the
    /// importer — would keep reading ADR-0136's answer while the compilation
    /// around it reads ADR-0186's. "Two readers disagreeing about one
    /// declaration" is the #3705 family-2 defect this whole design is
    /// careful about. Storing "unset" distinctly and resolving it to
    /// (cref:DefaultMode) makes the default a single fact.
    private let Current AsyncLocal[NullabilityMode?] = AsyncLocal[NullabilityMode?]()

    /// ADR-0186 §4: whether the coercion check is inserted at each
    /// `T! -> T` boundary. Stored <b>inverted</b> — as "suppressed" —
    /// so that the unset (cref:AsyncLocal{T})'s `false` already
    /// means "checks on", which is the default the ADR specifies and the only
    /// supported mode.
    private let ChecksSuppressed AsyncLocal[bool] = AsyncLocal[bool]()

    /// Gets the mode in effect for the current logical call, falling back to
    /// (cref:DefaultMode) — ADR-0186's (cref:NullabilityMode.PlatformTypes)
    /// since step 3 — when nothing installed one.
    internal prop Mode NullabilityMode -> Current.Value ?? DefaultMode

    /// Gets the mode a `Compilation` starts at when its embedder does
    /// not say. <b>ADR-0186 step 3 flipped this to
    /// <see cref="NullabilityMode.PlatformTypes" />.</b>
    ///
    /// `GSHARP_NULLABILITY` still selects, and its polarity is inverted
    /// with the default: it now recognises `enabled` and leaves
    /// `platform-types` as the no-op it names. That is not symmetry for
    /// its own sake — it is how the "before" half of a before/after
    /// measurement stays runnable on a branch that has already flipped, which
    /// is exactly the use the variable was introduced for in step 2. Step 5 adds
    /// `oblivious` (see (cref:ParseEnvironmentMode)). An
    /// unrecognised value selects the default rather than failing, because
    /// this is a measurement affordance and not a supported product switch;
    /// `/nullability:` is the supported one and it rejects an unknown
    /// mode by name.
    ///
    /// The variable is read <b>once</b>, and only a compilation that never
    /// sets `Nullability` observes it — an explicit assignment always
    /// wins, so the differential fixtures that assert both columns keep
    /// asserting both columns under either setting.
    private let _defaultMode NullabilityMode = ParseEnvironmentMode(
        Environment.GetEnvironmentVariable("GSHARP_NULLABILITY")
    )

    internal prop DefaultMode NullabilityMode {
        get {
            return _defaultMode
        }
    }

    /// Gets a value indicating whether oblivious imported reference positions
    /// read as the platform type `T!` rather than as `T?`.
    ///
    /// ADR-0186 §9's (cref:NullabilityMode.Oblivious) reads them that
    /// way too: an oblivious compilation is a platform-types compilation whose
    /// own source declarations are additionally oblivious by default.
    internal prop PlatformTypesEnabled bool -> (Mode is NullabilityMode.PlatformTypes or NullabilityMode.Oblivious)

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

    /// Reads `GSHARP_NULLABILITY`. Recognises `enabled` (ADR-0136's
    /// reading) and, since ADR-0186 step 5, `oblivious` — so the whole
    /// test suite can be run with every G# source declaration oblivious, which
    /// is how step 5 stress-tested the platform wrapper's reach into
    /// source-declared members. Anything else, including unset, is the
    /// default.
    /// @param value The raw environment value.
    /// @returns The selected mode.
    internal func ParseEnvironmentMode(value string?) NullabilityMode {
        let normalized = value?.Replace("-", string.Empty, StringComparison.Ordinal)
        if string.Equals(normalized, "enabled", StringComparison.OrdinalIgnoreCase) {
            return NullabilityMode.Enabled
        }
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
