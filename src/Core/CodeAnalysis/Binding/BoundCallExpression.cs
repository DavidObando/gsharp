// <copyright file="BoundCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound call expression.
/// </summary>
public sealed class BoundCallExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundCallExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="function">The function symbol.</param>
    /// <param name="arguments">The provided arguments.</param>
    public BoundCallExpression(SyntaxNode syntax, FunctionSymbol function, ImmutableArray<BoundExpression> arguments)
        : this(syntax, function, arguments, returnType: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundCallExpression"/> class with an explicit (substituted) return type for generic-call sites (Phase 4.1 / ADR-0020).</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="function">The function symbol.</param>
    /// <param name="arguments">The provided arguments.</param>
    /// <param name="returnType">The (already-substituted) call-site return type, or <c>null</c> to use <c>function.Type</c>.</param>
    public BoundCallExpression(SyntaxNode syntax, FunctionSymbol function, ImmutableArray<BoundExpression> arguments, TypeSymbol returnType)
        : this(syntax, function, arguments, returnType, isConditionalElided: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundCallExpression"/>
    /// class, optionally marking it as a <c>[Conditional]</c>-elided call
    /// (ADR-0047 §6 / issue #176). When elided the emitter and interpreter
    /// emit / evaluate no IL or behaviour at the call site, and the argument
    /// list is empty because C# semantics forbid evaluating arguments to a
    /// conditional method whose symbol is undefined.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="function">The function symbol.</param>
    /// <param name="arguments">The provided arguments; empty when elided.</param>
    /// <param name="returnType">The (already-substituted) call-site return type, or <c>null</c> to use <c>function.Type</c>.</param>
    /// <param name="isConditionalElided">When <c>true</c>, the call has been elided per <c>[Conditional]</c> rules.</param>
    public BoundCallExpression(SyntaxNode syntax, FunctionSymbol function, ImmutableArray<BoundExpression> arguments, TypeSymbol returnType, bool isConditionalElided)
        : base(syntax)
    {
        Function = function;
        Arguments = arguments;
        ReturnType = returnType;
        IsConditionalElided = isConditionalElided;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.CallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => ReturnType ?? Function.Type;

    /// <summary>
    /// Gets the function symbol.
    /// </summary>
    public FunctionSymbol Function { get; }

    /// <summary>
    /// Gets the provided arguments.
    /// </summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the call-site (post-substitution) return type for generic-function calls, or <c>null</c> for non-generic calls. Phase 4.1 / ADR-0020.</summary>
    public TypeSymbol ReturnType { get; }

    /// <summary>
    /// Gets a value indicating whether this call has been elided by
    /// <c>[Conditional]</c> processing (ADR-0047 §6 / issue #176). When
    /// <c>true</c>, the emitter and interpreter must not evaluate the
    /// receiver, the arguments, or invoke the target method; the call is a
    /// no-op of type <c>void</c> at the call site.
    /// </summary>
    public bool IsConditionalElided { get; }
}
