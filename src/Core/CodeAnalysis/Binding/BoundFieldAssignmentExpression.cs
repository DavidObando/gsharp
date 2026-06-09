// <copyright file="BoundFieldAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Writes a field on a struct held in a variable: <c>variable.Field = value</c>
/// (Phase 3.B.1). The receiver is either a simple variable reference or, after
/// closure-boxing lowering, an arbitrary expression (e.g. <c>boxLocal.Value</c>
/// for a boxed reference-type captured variable — issue #567).
/// </summary>
public sealed class BoundFieldAssignmentExpression : BoundExpression
{
    public BoundFieldAssignmentExpression(SyntaxNode syntax, VariableSymbol receiver, StructSymbol structType, FieldSymbol field, BoundExpression value)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Field = field;
        Value = value;
    }

    private BoundFieldAssignmentExpression(SyntaxNode syntax, BoundExpression receiverExpression, StructSymbol structType, FieldSymbol field, BoundExpression value)
        : base(syntax)
    {
        ReceiverExpression = receiverExpression;
        StructType = structType;
        Field = field;
        Value = value;
    }

    public VariableSymbol Receiver { get; }

    /// <summary>
    /// Gets the expression-based receiver, or <c>null</c> when the simple
    /// <see cref="Receiver"/> variable form is used. When non-null, the
    /// emitter evaluates this expression to produce the instance reference
    /// instead of loading <see cref="Receiver"/>.
    /// </summary>
    public BoundExpression ReceiverExpression { get; }

    public StructSymbol StructType { get; }

    public FieldSymbol Field { get; }

    public BoundExpression Value { get; }

    public override TypeSymbol Type => Field.Type;

    public override BoundNodeKind Kind => BoundNodeKind.FieldAssignmentExpression;

    /// <summary>
    /// Creates a field assignment with an expression-based receiver. Used
    /// after closure-boxing lowering when the original receiver local has
    /// been replaced by a field access through a box (issue #567).
    /// </summary>
    /// <param name="syntax">The originating syntax, or <c>null</c> for synthesized nodes.</param>
    /// <param name="receiverExpression">The expression that produces the instance reference.</param>
    /// <param name="structType">The declaring struct/class type.</param>
    /// <param name="field">The field to write.</param>
    /// <param name="value">The value to assign.</param>
    /// <returns>A new <see cref="BoundFieldAssignmentExpression"/> with an expression receiver.</returns>
    public static BoundFieldAssignmentExpression WithExpressionReceiver(
        SyntaxNode syntax,
        BoundExpression receiverExpression,
        StructSymbol structType,
        FieldSymbol field,
        BoundExpression value)
    {
        return new BoundFieldAssignmentExpression(syntax, receiverExpression, structType, field, value);
    }
}
