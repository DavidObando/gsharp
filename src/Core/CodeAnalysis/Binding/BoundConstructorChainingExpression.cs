#nullable disable

// <copyright file="BoundConstructorChainingExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0065 §2: a <c>init(args)</c> self-delegation appearing inside a
/// <c>convenience init</c> body. Lowered to a CIL <c>call .ctor(this, args)</c>
/// chained-constructor call that delegates to another initializer in the
/// same class. The expression is value-less (type <see cref="TypeSymbol.Void"/>)
/// and is normally wrapped in a <see cref="BoundExpressionStatement"/>.
/// </summary>
public sealed class BoundConstructorChainingExpression : BoundExpression
{
    public BoundConstructorChainingExpression(SyntaxNode syntax, ConstructorSymbol selectedConstructor, ImmutableArray<BoundExpression> arguments)
        : base(syntax)
    {
        SelectedConstructor = selectedConstructor;
        Arguments = arguments;
    }

    /// <summary>Gets the chosen sibling constructor overload to chain to.</summary>
    public ConstructorSymbol SelectedConstructor { get; }

    /// <summary>Gets the bound arguments (already permuted to parameter order and converted).</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    public override TypeSymbol Type => TypeSymbol.Void;

    public override BoundNodeKind Kind => BoundNodeKind.ConstructorChainingExpression;
}
