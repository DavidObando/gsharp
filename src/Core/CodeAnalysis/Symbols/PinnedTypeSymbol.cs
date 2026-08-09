// <copyright file="PinnedTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0125 / issue #1026: a synthetic marker type for the <em>pinned</em> CLR
/// local introduced by a <c>fixed</c> statement. It wraps the local's real
/// storage type (<see cref="UnderlyingType"/>) — either the managed array type
/// <c>T[]</c> (array-pin form) or a managed by-ref <c>T&amp;</c>
/// (<see cref="ByRefTypeSymbol"/>, string-pin form) — and signals the emitter
/// to set the <c>pinned</c> flag on that local's signature
/// (<c>.locals init ([n] … pinned)</c>) so the GC cannot relocate the buffer.
/// </summary>
/// <remarks>
/// This wrapper is attached only to a synthetic local that the emitter touches
/// directly (via its IL slot); it never flows through expression binding, so no
/// general <c>is</c>/equality checks elsewhere observe it. The only consumer is
/// <c>ReflectionMetadataEmitter.EncodeLocalVariableType</c>.
/// </remarks>
public sealed class PinnedTypeSymbol : TypeSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PinnedTypeSymbol"/> class.
    /// </summary>
    /// <param name="underlyingType">The pinned local's underlying storage type.</param>
    public PinnedTypeSymbol(TypeSymbol underlyingType)
        : base($"pinned {underlyingType?.Name}", (underlyingType ?? throw new ArgumentNullException(nameof(underlyingType))).ClrType)
    {
        UnderlyingType = underlyingType;
    }

    /// <summary>
    /// Gets the pinned local's underlying storage type (<c>T[]</c> for the
    /// array-pin form, or a <see cref="ByRefTypeSymbol"/> for the string-pin form).
    /// </summary>
    public TypeSymbol UnderlyingType { get; }
}
