// <copyright file="NullabilityOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0186: the ambient <see cref="NullabilityMode"/> for the compilation
/// currently being bound.
/// <para>
/// <b>Why ambient, and why temporary.</b> This repository threads compilation
/// options explicitly (<c>Compilation.ImplicitSystemImport</c> reaches
/// <c>Binder.BindGlobalScope</c> as a parameter), and that is the right shape.
/// It is not available here: the metadata reader that must consult the mode is
/// <c>ClrNullability.SymbolFromFlagsOffset</c>, a static leaf reached from
/// <see cref="NullabilityAnnotatedTypeSymbol"/>, <c>MemberLookup</c>,
/// <c>NullableFlagsBuilder</c> and the importer, none of which carry a
/// <c>Compilation</c>. Threading one down would touch far more of the compiler
/// than the pivot this flag gates.
/// </para>
/// <para>
/// The mode is therefore scoped with an <see cref="AsyncLocal{T}"/> for the
/// duration of a bind, which makes it flow into the whole logical call — across
/// the <c>Task.Run</c> hops the language server uses — while staying invisible
/// to a concurrent bind of a different compilation, and to sibling xunit tests.
/// It is set once at the start of a bind and never mutated mid-flight, so the
/// same-thread reentrancy hazard recorded in
/// <c>ClrOverloadResolution</c>'s "install/clear around the call" note does not
/// arise: there is no window to clear out from under a nested caller, only a
/// value that is uniform for the whole compilation.
/// </para>
/// <para>
/// <b>Step 1 said this type was scaffolding to delete at step 3. It is
/// kept, deliberately.</b> Step 3 flipped the default to
/// <see cref="NullabilityMode.PlatformTypes"/>, but the mode does not stop
/// being a choice there: <see cref="NullabilityMode.Enabled"/> has to stay
/// selectable for two concrete reasons. ADR-0136's
/// <c>Issue3705MemberKindNullabilityDifferentialTests</c> asserts <em>both</em>
/// columns off one piece of real csc-emitted metadata — that differential is
/// the standing uniformity gate, and it cannot express "the other reading"
/// without a switch. And <c>--nullability=enabled</c> is the escape hatch the
/// release note points at for source the flip breaks. Under it an oblivious
/// member chain still binds through the old member-lookup carve-out exactly as
/// before the flip — step 4 kept that carve-out, because it also serves
/// annotated-nullable members — so the escape hatch restores ADR-0136's
/// behaviour in full. Retiring the mode is a separate decision.
/// </para>
/// </summary>
internal static class NullabilityOptions
{
    /// <summary>
    /// The mode installed for the current logical call, or <see langword="null"/>
    /// when nothing installed one.
    /// <para>
    /// <b>Nullable, not a bare enum, and that is load-bearing at step 3.</b>
    /// Step 1 relied on <see cref="NullabilityMode.Enabled"/> being the enum's
    /// zero value so an unset <see cref="AsyncLocal{T}"/> already answered the
    /// default. The flip makes that reasoning silently wrong in the dangerous
    /// direction: every reader that never entered a scope — and there are
    /// some, because <c>ClrNullability</c> is a static leaf reachable from the
    /// importer — would keep reading ADR-0136's answer while the compilation
    /// around it reads ADR-0186's. "Two readers disagreeing about one
    /// declaration" is the #3705 family-2 defect this whole design is
    /// careful about. Storing "unset" distinctly and resolving it to
    /// <see cref="DefaultMode"/> makes the default a single fact.
    /// </para>
    /// </summary>
    private static readonly AsyncLocal<NullabilityMode?> Current = new();

    /// <summary>
    /// ADR-0186 §4: whether the coercion check is inserted at each
    /// <c>T! -&gt; T</c> boundary. Stored <b>inverted</b> — as "suppressed" —
    /// so that the unset <see cref="AsyncLocal{T}"/>'s <c>false</c> already
    /// means "checks on", which is the default the ADR specifies and the only
    /// supported mode.
    /// </summary>
    private static readonly AsyncLocal<bool> ChecksSuppressed = new();

    /// <summary>
    /// Gets the mode in effect for the current logical call, falling back to
    /// <see cref="DefaultMode"/> — ADR-0186's <see cref="NullabilityMode.PlatformTypes"/>
    /// since step 3 — when nothing installed one.
    /// </summary>
    internal static NullabilityMode Mode => Current.Value ?? DefaultMode;

    /// <summary>
    /// Gets the mode a <c>Compilation</c> starts at when its embedder does
    /// not say. <b>ADR-0186 step 3 flipped this to
    /// <see cref="NullabilityMode.PlatformTypes"/>.</b>
    /// <para>
    /// <c>GSHARP_NULLABILITY</c> still selects, and its polarity is inverted
    /// with the default: it now recognises <c>enabled</c> and leaves
    /// <c>platform-types</c> as the no-op it names. That is not symmetry for
    /// its own sake — it is how the "before" half of a before/after
    /// measurement stays runnable on a branch that has already flipped, which
    /// is exactly the use the variable was introduced for in step 2. Step 5 adds
    /// <c>oblivious</c> (see <see cref="ParseEnvironmentMode"/>). An
    /// unrecognised value selects the default rather than failing, because
    /// this is a measurement affordance and not a supported product switch;
    /// <c>/nullability:</c> is the supported one and it rejects an unknown
    /// mode by name.
    /// </para>
    /// <para>
    /// The variable is read <b>once</b>, and only a compilation that never
    /// sets <c>Nullability</c> observes it — an explicit assignment always
    /// wins, so the differential fixtures that assert both columns keep
    /// asserting both columns under either setting.
    /// </para>
    /// </summary>
    internal static NullabilityMode DefaultMode { get; } =
        ParseEnvironmentMode(Environment.GetEnvironmentVariable("GSHARP_NULLABILITY"));

    /// <summary>
    /// Gets a value indicating whether oblivious imported reference positions
    /// read as the platform type <c>T!</c> rather than as <c>T?</c>.
    /// <para>
    /// ADR-0186 §9's <see cref="NullabilityMode.Oblivious"/> reads them that
    /// way too: an oblivious compilation is a platform-types compilation whose
    /// own source declarations are additionally oblivious by default.
    /// </para>
    /// </summary>
    internal static bool PlatformTypesEnabled => Mode is NullabilityMode.PlatformTypes or NullabilityMode.Oblivious;

    /// <summary>
    /// Gets a value indicating whether an unadorned reference position written
    /// in G# source is oblivious (<c>T!</c>) when no enclosing
    /// <c>@Oblivious</c> / <c>@NullabilityEnabled</c> says otherwise — ADR-0186
    /// §9's compilation level, selected by <c>--nullability=oblivious</c>.
    /// </summary>
    internal static bool SourceObliviousByDefault => Mode == NullabilityMode.Oblivious;

    /// <summary>
    /// Gets a value indicating whether ADR-0186 §4's runtime nil check is
    /// inserted at each <c>T! → T</c> coercion.
    /// <para>
    /// <b>On</b> by default. <c>--platform-nil-checks=off</c> exists for
    /// measurement and as an escape hatch, and the ADR is explicit that it is
    /// <em>strictly weaker than either the old or the new model</em>: many of
    /// the sites it silences are compile errors today, and with checks off
    /// they are neither an error nor a check — the nil simply travels until
    /// something else notices.
    /// </para>
    /// </summary>
    internal static bool PlatformNilChecksEnabled => !ChecksSuppressed.Value;

    /// <summary>
    /// Reads <c>GSHARP_NULLABILITY</c>. Recognises <c>enabled</c> (ADR-0136's
    /// reading) and, since ADR-0186 step 5, <c>oblivious</c> — so the whole
    /// test suite can be run with every G# source declaration oblivious, which
    /// is how step 5 stress-tested the platform wrapper's reach into
    /// source-declared members. Anything else, including unset, is the
    /// default.
    /// </summary>
    /// <param name="value">The raw environment value.</param>
    /// <returns>The selected mode.</returns>
    internal static NullabilityMode ParseEnvironmentMode(string? value)
    {
        var normalized = value?.Replace("-", string.Empty, StringComparison.Ordinal);
        if (string.Equals(normalized, "enabled", StringComparison.OrdinalIgnoreCase))
        {
            return NullabilityMode.Enabled;
        }

        if (string.Equals(normalized, "oblivious", StringComparison.OrdinalIgnoreCase))
        {
            return NullabilityMode.Oblivious;
        }

        return NullabilityMode.PlatformTypes;
    }

    /// <summary>
    /// Installs <paramref name="mode"/> for the current logical call and
    /// restores the previous value when the returned scope is disposed.
    /// </summary>
    /// <param name="mode">The mode to install.</param>
    /// <param name="platformNilChecks">
    /// Whether ADR-0186 §4's coercion check is inserted. Defaults to
    /// <see langword="true"/>, so every caller that does not opt out — every
    /// caller in the compiler, the language server and the test suite — gets
    /// the supported behaviour.
    /// </param>
    /// <returns>A scope that restores the previous mode on disposal.</returns>
    internal static Scope Enter(NullabilityMode mode, bool platformNilChecks = true)
    {
        NullabilityMode? previous = Current.Value;
        var previousSuppressed = ChecksSuppressed.Value;
        Current.Value = mode;
        ChecksSuppressed.Value = !platformNilChecks;
        return new Scope(previous, previousSuppressed);
    }

    /// <summary>
    /// The restore token returned by <see cref="Enter"/>. A struct rather than
    /// a class so an always-taken <c>using</c> on the hot bind path allocates
    /// nothing.
    /// </summary>
    internal readonly struct Scope : IDisposable
    {
        private readonly NullabilityMode? previous;
        private readonly bool previousChecksSuppressed;

        internal Scope(NullabilityMode? previous, bool previousChecksSuppressed)
        {
            this.previous = previous;
            this.previousChecksSuppressed = previousChecksSuppressed;
        }

        /// <summary>Restores the mode in effect before the corresponding <see cref="Enter"/>.</summary>
        public void Dispose()
        {
            Current.Value = this.previous;
            ChecksSuppressed.Value = this.previousChecksSuppressed;
        }
    }
}
