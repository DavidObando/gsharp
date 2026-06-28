#nullable disable

// <copyright file="BoundUserInstanceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Calls an instance method declared inside a user-defined class body
/// (Phase 3.B.3 sub-step 2b): <c>receiver.Method(args)</c>. The implicit
/// <c>this</c> argument is the bound receiver; user arguments correspond
/// 1:1 with <see cref="FunctionSymbol.Parameters"/>.
/// </summary>
public sealed class BoundUserInstanceCallExpression : BoundExpression
{
    private readonly TypeSymbol returnTypeOverride;

    public BoundUserInstanceCallExpression(SyntaxNode syntax, BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments)
        : this(syntax, receiver, method, arguments, returnTypeOverride: null)
    {
    }

    public BoundUserInstanceCallExpression(SyntaxNode syntax, BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, TypeSymbol returnTypeOverride)
        : this(syntax, receiver, method, arguments, returnTypeOverride, constrainedReceiverTypeParameter: null, constrainedInterfaceType: null)
    {
    }

    public BoundUserInstanceCallExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        FunctionSymbol method,
        ImmutableArray<BoundExpression> arguments,
        TypeSymbol returnTypeOverride,
        TypeParameterSymbol constrainedReceiverTypeParameter,
        TypeSymbol constrainedInterfaceType)
        : base(syntax)
    {
        Receiver = receiver;
        Method = method;
        Arguments = arguments;
        this.returnTypeOverride = returnTypeOverride;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
    }

    public BoundExpression Receiver { get; }

    public FunctionSymbol Method { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>
    /// Gets the type parameter whose user-declared interface constraint backs
    /// this call when it dispatches through a constraint (issue #1052), e.g.
    /// <c>x.Area()</c> where <c>x : T</c> and <c>T : IShape</c>. The emitter then
    /// produces a verifiable <c>constrained. !!T  callvirt IShape::Area()</c>
    /// sequence instead of a bare <c>callvirt</c> on the unboxed type parameter.
    /// Null for ordinary user-instance calls.
    /// </summary>
    public TypeParameterSymbol ConstrainedReceiverTypeParameter { get; }

    /// <summary>
    /// Gets the user-declared interface (possibly a constructed generic
    /// interface) that backs <see cref="ConstrainedReceiverTypeParameter"/>
    /// (issue #1052). Null for ordinary user-instance calls.
    /// </summary>
    public TypeSymbol ConstrainedInterfaceType { get; }

    public bool IsConstrainedTypeParameterCall => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type => returnTypeOverride ?? Method.Type;

    public override BoundNodeKind Kind => BoundNodeKind.UserInstanceCallExpression;
}
