// <copyright file="BoundIsExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression-level pattern test: <c>expr is pattern</c> → <c>bool</c>.
/// Issues #575 and #3351.
/// </summary>
public sealed class BoundIsExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundIsExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression whose runtime type is tested.</param>
    /// <param name="targetType">The type to test against.</param>
    public BoundIsExpression(SyntaxNode? syntax, BoundExpression expression, TypeSymbol targetType)
        : this(
            syntax,
            expression,
            new BoundTypePattern(
                syntax,
                expression.Type,
                targetType,
                new LocalVariableSymbol("<is-type-value>", isReadOnly: true, targetType),
                hasBinding: false,
                propertyPattern: null))
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundIsExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression whose value is tested.</param>
    /// <param name="pattern">The bound pattern.</param>
    public BoundIsExpression(SyntaxNode? syntax, BoundExpression expression, BoundPattern pattern)
        : base(syntax)
    {
        Expression = expression;
        Pattern = pattern;
        InputVariable = new LocalVariableSymbol("<is-pattern-input>", isReadOnly: true, expression.Type);
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.IsExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Bool;

    /// <summary>Gets the expression being type-tested.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the pattern tested against <see cref="Expression"/>.</summary>
    public BoundPattern Pattern { get; }

    /// <summary>Gets the synthesized local that holds the expression value exactly once.</summary>
    public LocalVariableSymbol InputVariable { get; }

    /// <summary>Gets the direct tested type when the pattern starts with a type test.</summary>
    public TypeSymbol? TargetType => Pattern is BoundTypePattern typePattern ? typePattern.TargetType : null;

    /// <summary>Gets a value indicating whether this is a plain type test with no recursive suffix.</summary>
    public bool IsSimpleTypeTest =>
        Pattern is BoundTypePattern typePattern && typePattern.PropertyPattern == null;
}
