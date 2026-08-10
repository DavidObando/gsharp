// <copyright file="RemapScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Runtime.CompilerServices;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Issue #3163: the reified generic-remap scope identity that every Emit-layer
/// cache keyed on symbols and producing scope-sensitive metadata rows
/// (TypeSpec / MemberRef / MethodSpec) must carry in its key.
/// </summary>
/// <remarks>
/// <para>
/// The same <see cref="GSharp.Core.CodeAnalysis.Symbols.TypeParameterSymbol"/>
/// (or a symbol constructed over one) encodes to different
/// <c>ELEMENT_TYPE_VAR</c> / <c>ELEMENT_TYPE_MVAR</c> ordinals depending on
/// which remaps are active on <see cref="GenericRemapState"/> — the
/// state-machine/nested/closure class remap (VAR) and the generic-promoted
/// lambda method remap (MVAR). A cache key that omits either scope reuses a
/// row whose signature blob encodes the <em>other</em> scope's ordinals,
/// producing an invalid assembly (<c>BadImageFormatException</c>): this shipped
/// as #2930/#3057 (constructor MemberRefs) and again as #3065 (MethodSpecs).
/// </para>
/// <para>
/// Discrimination is <see cref="object.ReferenceEquals(object, object)"/> on
/// the remap dictionary objects: <see cref="GenericRemapState.PushSmRemap"/> /
/// <see cref="GenericRemapState.PushLambdaMethodRemap"/> install a distinct
/// dictionary object per reified class and per promoted lambda rather than
/// mutating a shared buffer, so object identity is the intended discriminator
/// (a stale identity fails safe: cache miss, recompute). Obtain the current
/// scope via <see cref="GenericRemapState.CurrentScope"/> at the point of
/// key construction — never cache a <see cref="RemapScope"/> across a
/// push/pop boundary.
/// </para>
/// <para>
/// The internal analyzer rule GSA0004
/// (<c>EmitCacheKeyRemapScopeAnalyzer</c>, ADR-0147) enforces the invariant:
/// any <c>Dictionary</c>/<c>ConcurrentDictionary</c> field or property in
/// this namespace whose key mentions a symbol type and whose value is a
/// scope-sensitive handle must include a <see cref="RemapScope"/> in its key.
/// </para>
/// </remarks>
internal readonly struct RemapScope : IEquatable<RemapScope>
{
    private readonly object? classRemap;
    private readonly object? methodRemap;

    /// <summary>
    /// Initializes a new instance of the <see cref="RemapScope"/> struct.
    /// Prefer <see cref="GenericRemapState.CurrentScope"/>; this constructor
    /// exists for that property and for tests.
    /// </summary>
    /// <param name="classRemap">The active state-machine/nested/closure class remap (VAR channel), or <see langword="null"/>.</param>
    /// <param name="methodRemap">The active generic-promoted lambda method remap (MVAR channel), or <see langword="null"/>.</param>
    internal RemapScope(object? classRemap, object? methodRemap)
    {
        this.classRemap = classRemap;
        this.methodRemap = methodRemap;
    }

    /// <inheritdoc />
    public bool Equals(RemapScope other)
        => ReferenceEquals(this.classRemap, other.classRemap)
        && ReferenceEquals(this.methodRemap, other.methodRemap);

    /// <inheritdoc />
    public override bool Equals(object? obj) => obj is RemapScope other && this.Equals(other);

    /// <inheritdoc />
    public override int GetHashCode()
    {
        var hash = this.classRemap == null ? 0 : RuntimeHelpers.GetHashCode(this.classRemap);
        var methodHash = this.methodRemap == null ? 0 : RuntimeHelpers.GetHashCode(this.methodRemap);
        return unchecked((hash * 31) + methodHash);
    }
}
