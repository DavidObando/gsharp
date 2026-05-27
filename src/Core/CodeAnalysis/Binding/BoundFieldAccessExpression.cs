// <copyright file="BoundFieldAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Reads a field from a struct value: <c>receiver.Field</c> (Phase 3.B.1).
/// </summary>
public sealed class BoundFieldAccessExpression : BoundExpression
{
    public BoundFieldAccessExpression(SyntaxNode syntax, BoundExpression receiver, StructSymbol structType, FieldSymbol field)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Field = field;
    }

    public BoundExpression Receiver { get; }

    public StructSymbol StructType { get; }

    public FieldSymbol Field { get; }

    public override TypeSymbol Type => Field.Type;

    public override BoundNodeKind Kind => BoundNodeKind.FieldAccessExpression;
}
