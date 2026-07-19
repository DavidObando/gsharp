// <copyright file="BoundClrBinaryOperatorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// User-defined binary operator resolved to a public static operator method,
/// identified by C#-style operator name (e.g. <c>op_Addition</c>,
/// <c>op_Equality</c>). Stream C lets GSharp source write <c>a + b</c>
/// against operator-bearing CLR types such as <c>TimeSpan</c>,
/// <c>BigInteger</c>, or <c>System.Numerics.Vector2</c>, resolved via
/// <see cref="Method"/> (a reflection <see cref="MethodInfo"/>).
/// </summary>
/// <remarks>
/// Issue #2388: this node is ALSO reused for the nullable-lifted form of a
/// same-compilation struct's Stream D user-defined operator (<c>func (a T)
/// operator ==(b T) bool</c>) when one or both operands are a value-type
/// <c>Nullable&lt;T&gt;</c> — that scenario has no reflection
/// <see cref="MethodInfo"/> available at bind time (the declaring struct is
/// still <see cref="System.Reflection.Emit.TypeBuilder"/>-backed), so
/// <see cref="Function"/> carries the same-compilation
/// <see cref="FunctionSymbol"/> instead. Exactly one of <see cref="Method"/>
/// / <see cref="Function"/> is non-null. Sharing one node type lets the
/// nullable-lifting machinery in <c>SlotPlanner</c> /
/// <c>MethodBodyEmitter.Operators</c> (<c>LiftedBinarySlots</c> /
/// <c>EmitLiftedNullableClrBinary</c>) drive both the imported-CLR-type and
/// same-compilation-struct cases uniformly.
/// </remarks>
public sealed class BoundClrBinaryOperatorExpression : BoundExpression
{
    public BoundClrBinaryOperatorExpression(SyntaxNode syntax, SyntaxKind operatorKind, BoundExpression left, BoundExpression right, MethodInfo method, TypeSymbol resultType)
        : this(syntax, operatorKind, left, right, method, null, null, resultType)
    {
    }

    public BoundClrBinaryOperatorExpression(SyntaxNode syntax, SyntaxKind operatorKind, BoundExpression left, BoundExpression right, Symbols.FunctionSymbol function, TypeSymbol resultType)
        : this(syntax, operatorKind, left, right, function, function?.StaticOwnerType as StructSymbol, resultType)
    {
    }

    public BoundClrBinaryOperatorExpression(
        SyntaxNode syntax,
        SyntaxKind operatorKind,
        BoundExpression left,
        BoundExpression right,
        Symbols.FunctionSymbol function,
        StructSymbol functionOwnerType,
        TypeSymbol resultType)
        : this(syntax, operatorKind, left, right, null, function, functionOwnerType, resultType)
    {
    }

    private BoundClrBinaryOperatorExpression(
        SyntaxNode syntax,
        SyntaxKind operatorKind,
        BoundExpression left,
        BoundExpression right,
        MethodInfo method,
        Symbols.FunctionSymbol function,
        StructSymbol functionOwnerType,
        TypeSymbol resultType)
        : base(syntax)
    {
        OperatorKind = operatorKind;
        Left = left;
        Right = right;
        Method = method;
        Function = function;
        FunctionOwnerType = functionOwnerType;
        Type = resultType;
    }

    public SyntaxKind OperatorKind { get; }

    public BoundExpression Left { get; }

    public BoundExpression Right { get; }

    /// <summary>Gets the resolved imported-CLR-type operator method, or <see langword="null"/> when <see cref="Function"/> is used instead.</summary>
    public MethodInfo Method { get; }

    /// <summary>
    /// Gets the resolved same-compilation struct operator function (issue
    /// #2388), used for the nullable-lifted Stream D case instead of
    /// <see cref="Method"/>. <see langword="null"/> for the ordinary
    /// (imported-CLR-type or non-nullable Stream D) shape.
    /// </summary>
    public Symbols.FunctionSymbol Function { get; }

    /// <summary>
    /// Gets the same-compilation operator's declaring type in the call-site
    /// construction (issue #2400), or <see langword="null"/> for imported CLR
    /// operators. The emitter uses this to parent calls on a closed generic
    /// TypeSpec rather than the open declaring TypeDef.
    /// </summary>
    public StructSymbol FunctionOwnerType { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrBinaryOperatorExpression;
}
