// <copyright file="TypeOrConstantPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a name-shaped pattern that can bind as either an existing value
/// pattern or a bare type pattern.
/// </summary>
public sealed class TypeOrConstantPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TypeOrConstantPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="expression">The value-pattern interpretation.</param>
    /// <param name="candidateType">The type-pattern interpretation.</param>
    /// <param name="propertyPattern">The optional recursive property-pattern suffix.</param>
    public TypeOrConstantPatternSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax expression,
        TypeClauseSyntax candidateType,
        PropertyPatternSyntax? propertyPattern)
        : base(syntaxTree)
    {
        Expression = expression;
        CandidateType = candidateType;
        PropertyPattern = propertyPattern;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeOrConstantPattern;

    /// <summary>Gets the value-pattern interpretation.</summary>
    public ExpressionSyntax Expression { get; }

    /// <summary>
    /// Gets the type-pattern interpretation. Its tokens are already represented
    /// by <see cref="Expression"/>, so it is excluded from the generic child walk.
    /// </summary>
    [SyntaxChildIgnore]
    public TypeClauseSyntax CandidateType { get; }

    /// <summary>Gets the optional recursive property-pattern suffix.</summary>
    public PropertyPatternSyntax? PropertyPattern { get; }
}
