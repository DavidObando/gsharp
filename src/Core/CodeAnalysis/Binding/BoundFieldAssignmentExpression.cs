#nullable disable

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

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundFieldAssignmentExpression"/>
    /// class for an interface static field write (ADR-0089 / issue #1030). The
    /// declaring <see cref="StructType"/> is <c>null</c>; <see cref="InterfaceType"/>
    /// records the owning interface (definition or constructed) so the emitter can
    /// route generic-interface field references through a <c>TypeSpec</c> and the
    /// interpreter can key static storage per closed construction.
    /// </summary>
    /// <param name="syntax">The originating syntax, or <c>null</c> for synthesized nodes.</param>
    /// <param name="field">The interface static field to write.</param>
    /// <param name="interfaceType">The owning interface (definition or constructed).</param>
    /// <param name="value">The value to assign.</param>
    public BoundFieldAssignmentExpression(SyntaxNode syntax, FieldSymbol field, InterfaceSymbol interfaceType, BoundExpression value)
        : base(syntax)
    {
        Receiver = null;
        StructType = null;
        Field = field;
        InterfaceType = interfaceType;
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

    /// <summary>
    /// Gets the owning interface for an interface static field write (ADR-0089 /
    /// issue #1030), or <c>null</c> for a struct/class field. When non-null and
    /// it is a generic-interface reference, the emitter resolves the field via a
    /// <c>TypeSpec</c>-parented MemberRef; the interpreter keys static storage by
    /// this symbol so each closed construction has independent storage.
    /// </summary>
    public InterfaceSymbol InterfaceType { get; }

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
