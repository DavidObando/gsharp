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
/// (Phase 3.B.1). For Phase 3.B.1 the receiver must be a simple variable
/// reference (no nested field paths yet).
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

    public VariableSymbol Receiver { get; }

    public StructSymbol StructType { get; }

    public FieldSymbol Field { get; }

    public BoundExpression Value { get; }

    public override TypeSymbol Type => Field.Type;

    public override BoundNodeKind Kind => BoundNodeKind.FieldAssignmentExpression;
}
