// <copyright file="TypeOrConstantPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a name-shaped pattern that can bind as either an existing value
/// pattern or a bare type pattern.
class TypeOrConstantPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:TypeOrConstantPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param expression The value-pattern interpretation.
    /// @param candidateType The type-pattern interpretation.
    /// @param propertyPattern The optional recursive property-pattern suffix.
    init(
        syntaxTree SyntaxTree,
        expression ExpressionSyntax,
        candidateType TypeClauseSyntax,
        propertyPattern PropertyPatternSyntax?
    ) : base(syntaxTree) {
        Expression = expression
        CandidateType = candidateType
        PropertyPattern = propertyPattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypeOrConstantPattern

    /// Gets the value-pattern interpretation.
    prop Expression ExpressionSyntax {
        get;
    }

    /// Gets the type-pattern interpretation. Its tokens are already represented
    /// by (cref:Expression), so it is excluded from the generic child walk.
    @SyntaxChildIgnore
    prop CandidateType TypeClauseSyntax {
        get;
    }

    /// Gets the optional recursive property-pattern suffix.
    prop PropertyPattern PropertyPatternSyntax? {
        get;
    }
}
