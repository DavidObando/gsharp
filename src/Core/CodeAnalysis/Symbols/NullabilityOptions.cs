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
    /// Gets the mode in effect for the current logical call. Defaults to
    /// <see cref="NullabilityMode.Enabled"/> — ADR-0136's reading — which is
    /// what makes every caller that never sets it behave exactly as it does
    /// today. <see cref="NullabilityMode.Enabled"/> is deliberately the enum's
    /// zero value so that the unset <see cref="AsyncLocal{T}"/> already answers
    /// correctly.
    /// </summary>
    internal static NullabilityMode Mode => Current.Value;

    /// <summary>
    /// Gets a value indicating whether oblivious imported reference positions
    /// read as the platform type <c>T!</c> rather than as <c>T?</c>.
    /// </summary>
    internal static bool PlatformTypesEnabled => Current.Value == NullabilityMode.PlatformTypes;

    /// <summary>
    /// Installs <paramref name="mode"/> for the current logical call and
    /// restores the previous value when the returned scope is disposed.
    /// </summary>
    /// <param name="mode">The mode to install.</param>
    /// <returns>A scope that restores the previous mode on disposal.</returns>
    internal static Scope Enter(NullabilityMode mode)
    {
        var previous = Current.Value;
        Current.Value = mode;
        return new Scope(previous);
    }

    /// <summary>
    /// The restore token returned by <see cref="Enter"/>. A struct rather than
    /// a class so an always-taken <c>using</c> on the hot bind path allocates
    /// nothing.
    /// </summary>
    internal readonly struct Scope : IDisposable
    {
        private readonly NullabilityMode previous;

        internal Scope(NullabilityMode previous) => this.previous = previous;

        /// <summary>Restores the mode in effect before the corresponding <see cref="Enter"/>.</summary>
        public void Dispose() => Current.Value = this.previous;
    }
}
