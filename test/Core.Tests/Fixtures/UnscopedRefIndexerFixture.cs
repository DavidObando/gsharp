// <copyright file="UnscopedRefIndexerFixture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;

namespace GSharp.Core.Tests.Fixtures;

/// <summary>
/// Soundness-guard regression fixture (found reviewing issue #4265 / PR #4274,
/// before merge): a byref-like (<c>ref struct</c>) CLR type whose indexer
/// getter is marked <c>[UnscopedRef]</c> — a legitimate, fully-supported C# 11+
/// pattern (no <c>unsafe</c>, no IL authoring) that returns a <c>ref</c> into
/// the RECEIVER'S OWN storage (<see cref="value"/>) rather than an
/// encapsulated referent the receiver merely wraps (unlike
/// <c>Span[T]</c>/<c>ReadOnlySpan[T]</c>, whose indexers always return a ref
/// into caller-owned storage the span was constructed over). Real C# rejects
/// forwarding such a member through a BY-VALUE parameter (CS8166) because
/// <c>[UnscopedRef]</c> inverts the receiver's contribution to the call's
/// ref-safe-context from "safe-to-escape" (caller scope) to
/// "ref-safe-context" (function-local, exactly like the receiver's own
/// storage). Before the guard in <c>RefCapabilities.IsUnscopedRefIndexerGetter</c>
/// / <c>StatementBinder.HasFunctionLocalRefScope</c>'s <c>BoundClrIndexExpression</c>
/// case, gsc did not consult this attribute at all and treated ANY byref-like
/// CLR indexer target as safe-to-forward — confirmed exploitable: a G#
/// function forwarding <c>buf[0]</c> from a by-value <see cref="UnscopedRefIndexerFixture"/>
/// parameter compiled clean and returned a reference into the callee's own
/// dead stack frame (an intervening call's locals silently corrupted the
/// "aliased" value on read-back).
/// </summary>
public ref struct UnscopedRefIndexerFixture
{
    private int value;

    /// <summary>Initializes a new instance seeded with <paramref name="seed"/>.</summary>
    /// <param name="seed">The initial value of the fixture's own storage.</param>
    public UnscopedRefIndexerFixture(int seed)
    {
        this.value = seed;
    }

    /// <summary>
    /// Gets a <c>ref</c> to this instance's OWN <see cref="value"/> field —
    /// the unsafe shape this fixture exists to probe. Legal C# only because
    /// of <c>[UnscopedRef]</c>; without it, this getter would not compile at
    /// all (CS8170).
    /// </summary>
    /// <param name="i">Unused; present only to match indexer syntax.</param>
    public ref int this[int i]
    {
        [UnscopedRef]
        get { return ref this.value; }
    }
}

/// <summary>
/// Same unsafe shape as <see cref="UnscopedRefIndexerFixture"/>, but with
/// <c>[UnscopedRef]</c> placed on the PROPERTY itself via the
/// expression-bodied indexer spelling, rather than on the <c>get</c>
/// accessor. C# accepts the attribute on either the accessor or the
/// property (confirmed against a real compiled indexer of each shape); an
/// initial version of <c>RefCapabilities.IsUnscopedRefIndexerGetter</c>
/// checked only <c>PropertyInfo.GetGetMethod()</c>'s attributes and missed
/// this spelling entirely, leaving the same dangling-reference hole open
/// for it. This fixture exists so both attribute placements are covered.
/// </summary>
public ref struct UnscopedRefIndexerPropertyLevelFixture
{
    private int value;

    /// <summary>Initializes a new instance seeded with <paramref name="seed"/>.</summary>
    /// <param name="seed">The initial value of the fixture's own storage.</param>
    public UnscopedRefIndexerPropertyLevelFixture(int seed)
    {
        this.value = seed;
    }

    /// <summary>Gets a <c>ref</c> to this instance's OWN <see cref="value"/> field.</summary>
    /// <param name="i">Unused; present only to match indexer syntax.</param>
    [UnscopedRef]
    public ref int this[int i] => ref this.value;
}
