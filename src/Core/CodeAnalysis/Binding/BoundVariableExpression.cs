#nullable disable

// <copyright file="BoundVariableExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound variable expression.
/// </summary>
public sealed class BoundVariableExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundVariableExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="variable">The variable symbol.</param>
    public BoundVariableExpression(SyntaxNode syntax, VariableSymbol variable)
        : this(syntax, variable, narrowedType: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundVariableExpression"/>
    /// class with a narrowed type. Phase 3.C.4: used by smart-cast flow
    /// analysis to surface a non-nullable view of a nullable variable
    /// inside an <c>if x != nil { ... }</c> guard, without losing the
    /// underlying symbol identity (so the evaluator still loads from the
    /// original slot).
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="variable">The variable symbol.</param>
    /// <param name="narrowedType">The narrowed type to report from
    /// <see cref="Type"/>. Pass <c>null</c> to use the variable's declared
    /// type.</param>
    public BoundVariableExpression(SyntaxNode syntax, VariableSymbol variable, TypeSymbol narrowedType)
        : base(syntax)
    {
        Variable = variable;
        NarrowedType = narrowedType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.VariableExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => NarrowedType ?? Variable.Type;

    /// <summary>Gets the variable symbol.</summary>
    public VariableSymbol Variable { get; }

    /// <summary>
    /// Gets the narrowed type, or <c>null</c> if the variable's declared
    /// type is in effect.
    /// </summary>
    public TypeSymbol NarrowedType { get; }
}
