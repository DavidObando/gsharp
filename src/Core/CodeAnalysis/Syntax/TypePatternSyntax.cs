// <copyright file="TypePatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a type pattern: the bare <c>T</c>, the switch binding spelling
/// <c>v is T</c>, or the ADR-0166 designation spelling <c>T v</c>. A recursive
/// property-pattern suffix may follow the type in every spelling.
/// </summary>
public sealed class TypePatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="TypePatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The binding identifier of the <c>v is T</c> spelling.</param>
    /// <param name="isKeyword">The <c>is</c> keyword.</param>
    /// <param name="type">The target type clause.</param>
    /// <param name="propertyPattern">The optional recursive property-pattern suffix.</param>
    /// <param name="designation">The optional ADR-0166 designation written after the type (<c>T v</c>).</param>
    public TypePatternSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? identifier,
        SyntaxToken? isKeyword,
        TypeClauseSyntax type,
        PropertyPatternSyntax? propertyPattern = null,
        SyntaxToken? designation = null)
        : base(syntaxTree)
    {
        Identifier = identifier;
        IsKeyword = isKeyword;
        Type = type;
        PropertyPattern = propertyPattern;
        Designation = designation;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypePattern;

    /// <summary>Gets the binding identifier of the <c>v is T</c> spelling.</summary>
    public SyntaxToken? Identifier { get; }

    /// <summary>Gets the <c>is</c> keyword.</summary>
    public SyntaxToken? IsKeyword { get; }

    /// <summary>Gets the target type clause.</summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Gets the optional recursive property-pattern suffix.</summary>
    public PropertyPatternSyntax? PropertyPattern { get; }

    /// <summary>
    /// Gets the optional designation identifier written after the type and any
    /// property-pattern suffix (<c>string text</c>, <c>Dog { Name: "Rex" } dog</c>).
    /// ADR-0166: this is the C#-equivalent spelling for a pattern variable.
    /// </summary>
    public SyntaxToken? Designation { get; }

    /// <summary>
    /// Gets the identifier that names the pattern variable in either spelling,
    /// or <see langword="null"/> when the pattern binds nothing.
    /// </summary>
    [SyntaxChildIgnore]
    public SyntaxToken? BindingIdentifier => Identifier ?? Designation;
}
