#nullable disable

// <copyright file="BoundInterpolatedStringExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0055 (Phase 2): a first-class bound node for an interpolated string
/// literal. Carries an ordered list of <see cref="BoundInterpolatedStringPart"/>
/// — each either literal text or a <c>{ value, alignment, format }</c> hole —
/// so that the tree-walk interpreter and the IL emitter can render the string
/// correctly and identically from one representation.
/// </summary>
/// <remarks>
/// The node's static type is always <see cref="TypeSymbol.String"/>. Lowering
/// happens late, not in the binder:
/// <list type="bullet">
/// <item>the interpreter (<see cref="Evaluator"/>) renders the node directly via
/// composite formatting (alignment + format, current culture), and</item>
/// <item>the IL emitter lowers it (issue #368) to the C# 10
/// <c>System.Runtime.CompilerServices.DefaultInterpolatedStringHandler</c>
/// pattern: construct the handler, call <c>AppendLiteral</c>/
/// <c>AppendFormatted&lt;T&gt;</c> in order, then <c>ToStringAndClear()</c>.</item>
/// </list>
/// Routing lowering late (rather than the legacy eager binder <c>+</c>-chain)
/// also fixes the #366 memory-unsafe-IL crash class.
/// </remarks>
public sealed class BoundInterpolatedStringExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundInterpolatedStringExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="parts">The ordered literal/hole parts.</param>
    public BoundInterpolatedStringExpression(SyntaxNode syntax, ImmutableArray<BoundInterpolatedStringPart> parts)
        : this(syntax, parts, handler: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundInterpolatedStringExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="parts">The ordered literal/hole parts.</param>
    /// <param name="handler">
    /// Issue #368: the user-defined <c>[InterpolatedStringHandler]</c> target this
    /// interpolation is converted to, or <see langword="null"/> for the default
    /// <c>string</c> result.
    /// </param>
    public BoundInterpolatedStringExpression(SyntaxNode syntax, ImmutableArray<BoundInterpolatedStringPart> parts, InterpolatedStringHandlerInfo handler)
        : base(syntax)
    {
        Parts = parts;
        Handler = handler;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.InterpolatedStringExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Handler?.HandlerType ?? TypeSymbol.String;

    /// <summary>Gets the ordered literal/hole parts.</summary>
    public ImmutableArray<BoundInterpolatedStringPart> Parts { get; }

    /// <summary>
    /// Gets the user-defined interpolated-string-handler target (issue #368),
    /// or <see langword="null"/> when this interpolation produces a plain
    /// <c>string</c>.
    /// </summary>
    public InterpolatedStringHandlerInfo Handler { get; }

    /// <summary>Returns a copy of this node with a different handler target and parts.</summary>
    /// <param name="parts">The replacement parts.</param>
    /// <param name="handler">The replacement handler target (may be <see langword="null"/>).</param>
    /// <returns>The updated node.</returns>
    public BoundInterpolatedStringExpression Update(ImmutableArray<BoundInterpolatedStringPart> parts, InterpolatedStringHandlerInfo handler)
        => new(Syntax, parts, handler);
}
