// <copyright file="BoundUserInstanceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

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

    public BoundUserInstanceCallExpression(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments)
        : this(receiver, method, arguments, returnTypeOverride: null)
    {
    }

    public BoundUserInstanceCallExpression(BoundExpression receiver, FunctionSymbol method, ImmutableArray<BoundExpression> arguments, TypeSymbol returnTypeOverride)
    {
        Receiver = receiver;
        Method = method;
        Arguments = arguments;
        this.returnTypeOverride = returnTypeOverride;
    }

    public BoundExpression Receiver { get; }

    public FunctionSymbol Method { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public override TypeSymbol Type => returnTypeOverride ?? Method.Type;

    public override BoundNodeKind Kind => BoundNodeKind.UserInstanceCallExpression;
}
