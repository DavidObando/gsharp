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
/// <b>This type is scaffolding.</b> ADR-0186 step 3 flips
/// <see cref="NullabilityMode.PlatformTypes"/> on unconditionally, at which
/// point the mode stops being a choice and this class should be deleted rather
/// than left as a permanent global.
/// </para>
/// </summary>
internal static class NullabilityOptions
{
    private static readonly AsyncLocal<NullabilityMode> Current = new();

    /// <summary>
    /// ADR-0186 §4: whether the coercion check is inserted at each
    /// <c>T! -&gt; T</c> boundary. Stored <b>inverted</b> — as "suppressed" —
    /// so that the unset <see cref="AsyncLocal{T}"/>'s <c>false</c> already
    /// means "checks on", which is the default the ADR specifies and the only
    /// supported mode.
    /// </summary>
    private static readonly AsyncLocal<bool> ChecksSuppressed = new();

    /// <summary>
    /// Gets the mode in effect for the current logical call. Defaults to
    /// <see cref="NullabilityMode.Enabled"/> — ADR-0136's reading — which is
    /// what makes every caller that never sets it behave exactly as it does
    /// today. <see cref="NullabilityMode.Enabled"/> is deliberately the enum's
    /// zero value so that the unset <see cref="AsyncLocal{T}"/> already answers
    /// correctly.
    /// </summary>
    internal static NullabilityMode Mode => Current.Value;

    /// <summary>
    /// Gets the mode a <c>Compilation</c> starts at when its embedder does
    /// not say — ADR-0186 step 2 verification scaffolding.
    /// <para>
    /// <b>Why this exists.</b> ADR-0186's sequencing makes every step before
    /// the default flip claim "no behaviour change with the flag off", and
    /// step 2's other half of that claim is the opposite one: that the full
    /// suite is <em>runnable</em> with the flag on, so the failures it
    /// produces can be triaged into "a test asserting ADR-0136's old reading"
    /// (expected, and the count is the measurement) versus "an emit or bind
    /// crash" (a bug in this step). Step 1 gave each <c>Compilation</c> its
    /// own mode, which is the right shape and cannot express "run the whole
    /// suite the other way".
    /// </para>
    /// <para>
    /// The environment variable is read <b>once</b>, and only a compilation
    /// that never sets <c>Nullability</c> observes it — an explicit
    /// assignment always wins, so the differential fixtures that assert both
    /// columns keep asserting both columns under either setting.
    /// </para>
    /// <para>
    /// <b>Delete this with the rest of the class at step 3</b>, when the
    /// platform-types reading stops being a choice.
    /// </para>
    /// </summary>
    internal static NullabilityMode DefaultMode { get; } =
        string.Equals(
            Environment.GetEnvironmentVariable("GSHARP_NULLABILITY")?.Replace("-", string.Empty, StringComparison.Ordinal),
            "platformtypes",
            StringComparison.OrdinalIgnoreCase)
            ? NullabilityMode.PlatformTypes
            : NullabilityMode.Enabled;

    /// <summary>
    /// Gets a value indicating whether oblivious imported reference positions
    /// read as the platform type <c>T!</c> rather than as <c>T?</c>.
    /// </summary>
    internal static bool PlatformTypesEnabled => Current.Value == NullabilityMode.PlatformTypes;

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
        var previous = Current.Value;
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
        private readonly NullabilityMode previous;
        private readonly bool previousChecksSuppressed;

        internal Scope(NullabilityMode previous, bool previousChecksSuppressed)
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
