#nullable disable

// <copyright file="BoundAwaitSequencePoint.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Hidden sequence-point marker emitted around async await suspension points.
/// Emits a single <c>nop</c> opcode, giving a future PDB writer a definite IL
/// offset to anchor a hidden (0xfeefee) sequence point on.
/// </summary>
public sealed class BoundAwaitSequencePoint : BoundStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAwaitSequencePoint"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="kind">Whether this is a yield point or a resume point.</param>
    /// <param name="state">The await state number for PDB round-trip.</param>
    public BoundAwaitSequencePoint(SyntaxNode syntax, BoundNodeKind kind, int state)
        : base(syntax)
    {
        Kind = kind;
        State = state;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind { get; }

    /// <summary>Gets the await state number.</summary>
    public int State { get; }
}
