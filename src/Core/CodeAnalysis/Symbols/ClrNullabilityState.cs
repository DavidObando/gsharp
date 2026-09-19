// <copyright file="ClrClrNullabilityState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0186 §2: what one C# nullable-metadata byte actually says about a
/// reference position — the three-state successor to ADR-0136's two-valued
/// <c>IsFlagNonNull</c>.
/// <para>
/// The names are C#'s own, deliberately: these are <em>readings of metadata</em>,
/// not G# types. The mapping from a state to a G# type is a separate decision
/// and lives in exactly one place
/// (<see cref="ClrNullability.SymbolForState"/>), which is what lets
/// ADR-0186's pivot change one cell of ADR-0136's table without touching the
/// readers.
/// </para>
/// <para>
/// ADR-0186 spells this <c>NullabilityState</c>. It is named
/// <c>ClrNullabilityState</c> here because <c>System.Reflection</c> already
/// declares a <c>NullabilityState</c> — the BCL's own reading of the same
/// metadata, which this repository's emit tests use heavily via
/// <c>NullabilityInfoContext</c>. Under the ADR's spelling, every file that
/// imports both <c>System.Reflection</c> and this namespace stops compiling
/// with CS0104, and several already do.
/// </para>
/// </summary>
internal enum ClrNullabilityState
{
    /// <summary>
    /// The declarer said <b>nothing</b> — byte <c>0</c>, or no
    /// <c>[Nullable]</c>/<c>[NullableContext]</c> reaching the position at all.
    /// <para>
    /// ADR-0136 read this as <c>T?</c>; ADR-0186 reads it as the platform type
    /// <c>T!</c>. This is the <b>only</b> cell of ADR-0136's table whose answer
    /// changes.
    /// </para>
    /// </summary>
    Oblivious,

    /// <summary>
    /// The declarer said <b>non-null</b> — byte <c>1</c>. Reads as <c>T</c>,
    /// unchanged by ADR-0186. Modern annotated assemblies (the whole current
    /// BCL, via <c>[NullableContext(1)]</c>) land here.
    /// </summary>
    NotAnnotated,

    /// <summary>
    /// The declarer said <b>nullable</b> — byte <c>2</c>. Reads as <c>T?</c>,
    /// unchanged by ADR-0186; such a position still requires narrowing before
    /// non-null use.
    /// </summary>
    Annotated,
}
