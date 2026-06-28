#nullable disable

// <copyright file="BoundConversionExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound conversion expression.
/// </summary>
public sealed class BoundConversionExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundConversionExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The type symbol.</param>
    /// <param name="expression">The expression to convert.</param>
    /// <param name="isChecked">
    /// When true, the emitter must use overflow-checking <c>conv.ovf.*</c> opcodes for
    /// the numeric narrowing portion of the conversion. The binder does not yet surface
    /// <c>checked</c> contexts (issue #421 P2-5), so callers default to false; the flag
    /// exists so the emitter is ready when the binder begins distinguishing checked vs.
    /// unchecked conversions.
    /// </param>
    public BoundConversionExpression(SyntaxNode syntax, TypeSymbol type, BoundExpression expression, bool isChecked = false)
        : base(syntax)
    {
        Type = type;
        Expression = expression;
        IsChecked = isChecked;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ConversionExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the expression to convert.
    /// </summary>
    public BoundExpression Expression { get; }

    /// <summary>
    /// Gets a value indicating whether this conversion runs in a checked / overflow-trapping
    /// context. When true, the emitter selects <c>conv.ovf.*</c> opcodes so a numeric
    /// narrowing that loses information traps at runtime via <see cref="System.OverflowException"/>
    /// instead of silently truncating.
    /// </summary>
    public bool IsChecked { get; }
}
