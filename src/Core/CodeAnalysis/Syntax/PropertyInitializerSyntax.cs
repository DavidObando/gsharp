#nullable disable

// <copyright file="PropertyInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #522: a single <c>PropertyName = value</c> element inside a C#-style
/// object initializer suffix (<c>T(args) { P1 = v1, P2 = v2 }</c>). Distinct
/// from <see cref="FieldInitializerSyntax"/> only in that the property name
/// must bind to a writable instance property/field of the constructed type
/// (init-only setters are allowed); the syntactic shape is identical.
/// </summary>
public sealed class PropertyInitializerSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyInitializerSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="propertyIdentifier">The property name.</param>
    /// <param name="equalsToken">The '=' separator.</param>
    /// <param name="value">The value expression.</param>
    public PropertyInitializerSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken propertyIdentifier,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        PropertyIdentifier = propertyIdentifier;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.PropertyInitializer;

    /// <summary>Gets the property identifier.</summary>
    public SyntaxToken PropertyIdentifier { get; }

    /// <summary>Gets the '=' separator token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
