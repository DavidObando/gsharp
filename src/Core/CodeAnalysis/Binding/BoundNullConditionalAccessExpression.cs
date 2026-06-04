// <copyright file="BoundNullConditionalAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.C.3b / ADR-0001: bound representation of the null-conditional
/// member access operator <c>?.</c>.
///
/// The evaluator:
///   1. evaluates <see cref="Receiver"/> exactly once;
///   2. if the value is nil, the whole expression evaluates to nil without
///      touching <see cref="WhenNotNull"/>;
///   3. otherwise it assigns the receiver value to <see cref="Capture"/>
///      in the current scope and evaluates <see cref="WhenNotNull"/>, whose
///      receiver reference IS <see cref="Capture"/>. This guarantees the
///      original receiver expression is evaluated exactly once, even when
///      it has side-effects.
/// </summary>
public sealed class BoundNullConditionalAccessExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the
    /// <see cref="BoundNullConditionalAccessExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="receiver">The nullable receiver expression.</param>
    /// <param name="capture">The synthetic local that the receiver value
    /// is captured into for the duration of <see cref="WhenNotNull"/>.</param>
    /// <param name="whenNotNull">The bound access expression, built with
    /// <paramref name="capture"/> standing in for the receiver.</param>
    /// <param name="type">The result type — always a
    /// <see cref="NullableTypeSymbol"/>.</param>
    /// <param name="resultSlot">Optional synthetic local that the emitter
    /// uses to materialize <c>default(Nullable&lt;T&gt;)</c> when the access
    /// result is a value type. Null for reference-typed results.</param>
    public BoundNullConditionalAccessExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        VariableSymbol capture,
        BoundExpression whenNotNull,
        TypeSymbol type,
        VariableSymbol resultSlot = null)
        : base(syntax)
    {
        Receiver = receiver;
        Capture = capture;
        WhenNotNull = whenNotNull;
        Type = type;
        ResultSlot = resultSlot;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.NullConditionalAccessExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the nullable receiver expression.</summary>
    public BoundExpression Receiver { get; }

    /// <summary>Gets the synthetic capture variable.</summary>
    public VariableSymbol Capture { get; }

    /// <summary>Gets the access expression evaluated when the receiver is non-nil.</summary>
    public BoundExpression WhenNotNull { get; }

    /// <summary>
    /// Gets the synthetic temp slot used to materialize <c>default(Nullable&lt;T&gt;)</c>
    /// in the nil branch when the access result is a value type. Null when the
    /// result is a reference type (the nil branch then just pushes <c>ldnull</c>).
    /// </summary>
    public VariableSymbol ResultSlot { get; }
}
