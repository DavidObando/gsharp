// <copyright file="BoundFixedStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0125 / issue #1026: the kind of managed buffer a <c>fixed</c> statement
/// pins, which selects the element-0 pointer-derivation pattern emitted.
/// </summary>
public enum FixedPinKind
{
    /// <summary>A managed array <c>[]T</c> — pin the array, derive <c>&amp;a[0]</c> via <c>ldelema</c>.</summary>
    Array,

    /// <summary>A managed <c>string</c> — pin <c>string.GetPinnableReference()</c>, derive the char-data pointer.</summary>
    String,
}

/// <summary>
/// ADR-0125 / issue #1026: a bound <c>fixed</c> (pinning) statement. Pins the
/// managed buffer <see cref="PinnedSource"/> into the synthetic
/// <see cref="PinnedVariable"/> (a CLR pinned local) for the duration of
/// <see cref="Body"/>, and binds the user-visible unmanaged pointer
/// <see cref="PointerVariable"/> (<c>*T</c>) to the address of element 0.
/// Lowers in the emitter to the CLR pinned-local pattern, mirroring C#
/// <c>fixed (T* p = expr) { … }</c>; the pin is released (the pinned local is
/// nulled) on normal block exit.
/// </summary>
public sealed class BoundFixedStatement : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundFixedStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="pinKind">Whether the pinned source is an array or a string.</param>
    /// <param name="pinnedVariable">The synthetic pinned local.</param>
    /// <param name="pointerVariable">The user-visible <c>*T</c> pointer local.</param>
    /// <param name="pinnedSource">The managed array/string source to pin.</param>
    /// <param name="body">The block over which the pin is held.</param>
    public BoundFixedStatement(
        SyntaxNode syntax,
        FixedPinKind pinKind,
        VariableSymbol pinnedVariable,
        VariableSymbol pointerVariable,
        BoundExpression pinnedSource,
        BoundStatement body)
        : base(syntax)
    {
        PinKind = pinKind;
        PinnedVariable = pinnedVariable ?? throw new ArgumentNullException(nameof(pinnedVariable));
        PointerVariable = pointerVariable ?? throw new ArgumentNullException(nameof(pointerVariable));
        PinnedSource = pinnedSource ?? throw new ArgumentNullException(nameof(pinnedSource));
        Body = body ?? throw new ArgumentNullException(nameof(body));
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.FixedStatement;

    /// <summary>Gets whether the pinned source is an array or a string.</summary>
    public FixedPinKind PinKind { get; }

    /// <summary>Gets the synthetic pinned local (a CLR <c>pinned</c> local).</summary>
    public VariableSymbol PinnedVariable { get; }

    /// <summary>Gets the user-visible <c>*T</c> pointer local.</summary>
    public VariableSymbol PointerVariable { get; }

    /// <summary>Gets the managed array/string source to pin.</summary>
    public BoundExpression PinnedSource { get; }

    /// <summary>Gets the block over which the pin is held.</summary>
    public BoundStatement Body { get; }
}
