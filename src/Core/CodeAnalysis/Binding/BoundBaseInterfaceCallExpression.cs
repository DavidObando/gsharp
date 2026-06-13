// <copyright file="BoundBaseInterfaceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0091 / issue #757: an explicit-base interface call expression of
/// the form <c>base[IFoo].Method(args)</c>. Lets a class member delegate
/// to a specific interface's inherited default method (DIM) body, either
/// to disambiguate a diamond (ADR-0085 GS0318) or to augment a default
/// from inside an override. The emitter lowers this to a non-virtual
/// <c>call instance R IFoo::Method(...)</c>; the interpreter dispatches
/// directly to the interface method body without re-entering the
/// implementer's v-table.
/// </summary>
public sealed class BoundBaseInterfaceCallExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundBaseInterfaceCallExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="receiver">The implicit <c>this</c> receiver of the enclosing instance member.</param>
    /// <param name="interfaceSymbol">The interface named in <c>base[IFoo]</c>.</param>
    /// <param name="method">The interface method whose default body is invoked. Must satisfy <see cref="InterfaceSymbol.HasDefaultBody"/>.</param>
    /// <param name="arguments">The bound argument expressions in declared order.</param>
    public BoundBaseInterfaceCallExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        InterfaceSymbol interfaceSymbol,
        FunctionSymbol method,
        ImmutableArray<BoundExpression> arguments)
        : base(syntax)
    {
        Receiver = receiver;
        Interface = interfaceSymbol;
        Method = method;
        Arguments = arguments;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BaseInterfaceCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => Method.Type;

    /// <summary>Gets the implicit <c>this</c> receiver — a <see cref="BoundVariableExpression"/> reading the enclosing method's first parameter.</summary>
    public BoundExpression Receiver { get; }

    /// <summary>Gets the interface named in <c>base[IFoo]</c>.</summary>
    public InterfaceSymbol Interface { get; }

    /// <summary>Gets the interface method whose default body is invoked.</summary>
    public FunctionSymbol Method { get; }

    /// <summary>Gets the bound argument expressions in declared order.</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }
}
