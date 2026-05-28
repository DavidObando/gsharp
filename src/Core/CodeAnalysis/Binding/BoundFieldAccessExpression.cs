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
        : this(syntax, receiver, structType, field, narrowedType: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundFieldAccessExpression"/>
    /// class with a narrowed type. Issue #208: used by smart-cast flow analysis
    /// to surface a non-nullable view of a nullable field inside a block where
    /// a <c>[MemberNotNull]</c> call has been observed, without changing the
    /// underlying field symbol identity (so the emitter still uses the same
    /// field handle).
    /// </summary>
    /// <param name="syntax">The originating syntax, or <c>null</c> for synthesized nodes.</param>
    /// <param name="receiver">The expression that produces the struct/class instance.</param>
    /// <param name="structType">The declaring struct/class type.</param>
    /// <param name="field">The field to read.</param>
    /// <param name="narrowedType">The narrowed type to surface, or <c>null</c> to use <paramref name="field"/>'s declared type.</param>
    public BoundFieldAccessExpression(SyntaxNode syntax, BoundExpression receiver, StructSymbol structType, FieldSymbol field, TypeSymbol narrowedType)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Field = field;
        NarrowedType = narrowedType;
    }

    public BoundExpression Receiver { get; }

    public StructSymbol StructType { get; }

    public FieldSymbol Field { get; }

    /// <summary>
    /// Gets the narrowed type for flow-analysis smart-cast, or <c>null</c> to
    /// use the field's declared type. When non-null the binder reports this
    /// type to callers so that member-access and type-compatibility checks see
    /// the narrowed (non-nullable) view; the emitter always uses
    /// <see cref="Field"/> for the actual field handle.
    /// </summary>
    public TypeSymbol NarrowedType { get; }

    public override TypeSymbol Type => NarrowedType ?? Field.Type;

    public override BoundNodeKind Kind => BoundNodeKind.FieldAccessExpression;
}
