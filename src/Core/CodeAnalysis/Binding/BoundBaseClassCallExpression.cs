#nullable disable

// <copyright file="BoundBaseClassCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #986: a base-class call expression of the form
/// <c>base.Method(args)</c> (and the bracketed
/// <c>base[BaseClass].Method(args)</c> form). Lets an override delegate to
/// the nearest base class's virtual implementation non-virtually — exactly
/// like C# <c>base.M(...)</c>. The emitter lowers this to
/// <c>ldarg.0</c> + a non-virtual <c>call instance R BaseClass::Method(...)</c>;
/// the interpreter dispatches directly to the base method body without
/// re-entering the derived type's v-table (which would recurse infinitely).
/// </summary>
public sealed class BoundBaseClassCallExpression : BoundExpression
{
    private readonly TypeSymbol returnTypeOverride;

    /// <summary>Initializes a new instance of the <see cref="BoundBaseClassCallExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="receiver">The implicit <c>this</c> receiver of the enclosing instance member.</param>
    /// <param name="baseClass">The base class whose member is invoked (the declaring type of <paramref name="method"/>).</param>
    /// <param name="method">The base-class method whose implementation is invoked non-virtually.</param>
    /// <param name="arguments">The bound argument expressions in declared order.</param>
    /// <param name="returnTypeOverride">Optional substituted return type for a constructed generic base; <see langword="null"/> uses <see cref="FunctionSymbol.Type"/>.</param>
    public BoundBaseClassCallExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        StructSymbol baseClass,
        FunctionSymbol method,
        ImmutableArray<BoundExpression> arguments,
        TypeSymbol returnTypeOverride = null)
        : base(syntax)
    {
        Receiver = receiver;
        BaseClass = baseClass;
        Method = method;
        Arguments = arguments;
        this.returnTypeOverride = returnTypeOverride;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.BaseClassCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => returnTypeOverride ?? Method.Type;

    /// <summary>Gets the implicit <c>this</c> receiver — a <see cref="BoundVariableExpression"/> reading the enclosing method's first parameter.</summary>
    public BoundExpression Receiver { get; }

    /// <summary>Gets the base class whose member is invoked (the declaring type of <see cref="Method"/>).</summary>
    public StructSymbol BaseClass { get; }

    /// <summary>Gets the base-class method whose implementation is invoked non-virtually.</summary>
    public FunctionSymbol Method { get; }

    /// <summary>Gets the bound argument expressions in declared order.</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }
}
