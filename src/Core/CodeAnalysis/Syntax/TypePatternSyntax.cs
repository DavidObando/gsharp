// <copyright file="TypePatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a type pattern <c>v is T</c> or bare <c>T</c>.</summary>
public sealed class TypePatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TypePatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The binding identifier.</param>
    /// <param name="isKeyword">The <c>is</c> keyword.</param>
    /// <param name="type">The target type clause.</param>
    /// <param name="propertyPattern">The optional recursive property-pattern suffix.</param>
    public TypePatternSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? identifier,
        SyntaxToken? isKeyword,
        TypeClauseSyntax type,
        PropertyPatternSyntax? propertyPattern = null)
        : base(syntaxTree)
    {
        Identifier = identifier;
        IsKeyword = isKeyword;
        Type = type;
        PropertyPattern = propertyPattern;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypePattern;

    /// <summary>Gets the binding identifier.</summary>
    public SyntaxToken? Identifier { get; }

    /// <summary>Gets the <c>is</c> keyword.</summary>
    public SyntaxToken? IsKeyword { get; }

    /// <summary>Gets the target type clause.</summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Gets the optional recursive property-pattern suffix.</summary>
    public PropertyPatternSyntax? PropertyPattern { get; }
}
