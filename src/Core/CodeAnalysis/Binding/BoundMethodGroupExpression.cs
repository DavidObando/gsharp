// <copyright file="BoundMethodGroupExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #324 / ADR-0063 §9: a bare reference to a named function used in a
/// value context (C#/F# "method group"). When the name resolves to a single
/// candidate, <see cref="Function"/> is bound eagerly and <see cref="FunctionType"/>
/// is its signature. When the name resolves to multiple overloads,
/// <see cref="Candidates"/> contains every overload and final overload
/// selection is deferred to <c>BindConversion</c>, where the target delegate
/// signature drives the pick.
/// </summary>
public sealed class BoundMethodGroupExpression : BoundExpression
{
    public BoundMethodGroupExpression(SyntaxNode syntax, FunctionSymbol function, FunctionTypeSymbol type)
        : this(syntax, receiver: null, function, type)
    {
    }

    public BoundMethodGroupExpression(SyntaxNode syntax, ImmutableArray<FunctionSymbol> candidates)
        : this(syntax, receiver: null, candidates)
    {
    }

    public BoundMethodGroupExpression(SyntaxNode syntax, BoundExpression receiver, FunctionSymbol function, FunctionTypeSymbol type)
        : this(syntax, receiver, function, type, staticOwnerType: null)
    {
    }

    public BoundMethodGroupExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        FunctionSymbol function,
        FunctionTypeSymbol type,
        StructSymbol staticOwnerType)
        : base(syntax)
    {
        Receiver = receiver;
        Function = function;
        FunctionType = type;
        Candidates = ImmutableArray.Create(function);
        StaticOwnerType = staticOwnerType;
    }

    public BoundMethodGroupExpression(SyntaxNode syntax, BoundExpression receiver, ImmutableArray<FunctionSymbol> candidates)
        : this(syntax, receiver, candidates, staticOwnerType: null)
    {
    }

    public BoundMethodGroupExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        ImmutableArray<FunctionSymbol> candidates,
        StructSymbol staticOwnerType)
        : base(syntax)
    {
        Receiver = receiver;
        Function = candidates.IsDefaultOrEmpty ? null : candidates[0];
        FunctionType = null;
        Candidates = candidates;
        StaticOwnerType = staticOwnerType;
    }

    /// <summary>
    /// Gets the bound receiver expression for an instance method group, or
    /// <see langword="null"/> for a static/free-function method group. When
    /// non-null, the emitter binds the resulting delegate's <c>Target</c> to
    /// this receiver (<c>ldarg/ldfld; ldftn</c> or <c>dup; ldvirtftn</c>).
    /// </summary>
    public BoundExpression Receiver { get; }

    public FunctionSymbol Function { get; }

    public FunctionTypeSymbol FunctionType { get; }

    /// <summary>
    /// Gets every candidate overload sharing the source name. Equals
    /// <c>[Function]</c> when there is a single candidate.
    /// </summary>
    public ImmutableArray<FunctionSymbol> Candidates { get; }

    /// <summary>Gets the type used to qualify a static method group.</summary>
    public StructSymbol StaticOwnerType { get; }

    public override TypeSymbol Type => FunctionType ?? (TypeSymbol)TypeSymbol.Error;

    public override BoundNodeKind Kind => BoundNodeKind.MethodGroupExpression;
}
