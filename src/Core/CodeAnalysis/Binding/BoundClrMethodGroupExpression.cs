#nullable disable

// <copyright file="BoundClrMethodGroupExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #337: a bare reference to a CLR member method (a method group on an
/// imported static type — e.g. <c>Console.WriteLine</c>, <c>Int32.Parse</c> —
/// or on a CLR instance receiver — e.g. <c>sb.Append</c>) used in a value
/// context. Unlike a named G# function group (<see cref="BoundMethodGroupExpression"/>),
/// the target overload cannot be selected until the expected delegate signature
/// is known, so the binder first produces the <em>unresolved</em> form carrying
/// every name-matching overload, then <c>BindConversion</c> picks the single
/// best <see cref="MethodInfo"/> against the target delegate's <c>Invoke</c>
/// signature and produces the <em>resolved</em> form. The emitter materializes
/// the resolved form as <c>ldnull/ldftn</c> (static) or
/// <c>[dup] ldftn/ldvirtftn</c> over the captured receiver (instance), followed
/// by a <c>newobj</c> of the target delegate.
/// </summary>
public sealed class BoundClrMethodGroupExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundClrMethodGroupExpression"/>
    /// class in its <em>unresolved</em> form: a name-matched set of overload
    /// candidates awaiting overload selection against a target delegate type.
    /// </summary>
    /// <param name="syntax">The originating syntax node.</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for a static group.</param>
    /// <param name="declaringType">The CLR type declaring the candidates.</param>
    /// <param name="methodName">The method-group name.</param>
    /// <param name="candidates">All name-matching overloads.</param>
    public BoundClrMethodGroupExpression(SyntaxNode syntax, BoundExpression receiver, Type declaringType, string methodName, ImmutableArray<MethodInfo> candidates)
        : base(syntax)
    {
        Receiver = receiver;
        DeclaringType = declaringType;
        MethodName = methodName;
        Candidates = candidates;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundClrMethodGroupExpression"/>
    /// class in its <em>resolved</em> form: a single overload selected for a
    /// concrete target delegate type.
    /// </summary>
    /// <param name="syntax">The originating syntax node.</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for a static group.</param>
    /// <param name="resolvedMethod">The selected overload.</param>
    /// <param name="delegateType">The target delegate type symbol.</param>
    public BoundClrMethodGroupExpression(SyntaxNode syntax, BoundExpression receiver, MethodInfo resolvedMethod, TypeSymbol delegateType)
        : base(syntax)
    {
        Receiver = receiver;
        DeclaringType = resolvedMethod.DeclaringType;
        MethodName = resolvedMethod.Name;
        Candidates = ImmutableArray.Create(resolvedMethod);
        ResolvedMethod = resolvedMethod;
        DelegateType = delegateType;
    }

    public BoundExpression Receiver { get; }

    public Type DeclaringType { get; }

    public string MethodName { get; }

    public ImmutableArray<MethodInfo> Candidates { get; }

    /// <summary>Gets the overload selected for the target delegate, or <see langword="null"/> while unresolved.</summary>
    public MethodInfo ResolvedMethod { get; }

    /// <summary>Gets the target delegate type symbol once resolved, or <see langword="null"/> while unresolved.</summary>
    public TypeSymbol DelegateType { get; }

    public override TypeSymbol Type => DelegateType ?? TypeSymbol.Error;

    public override BoundNodeKind Kind => BoundNodeKind.ClrMethodGroupExpression;
}
