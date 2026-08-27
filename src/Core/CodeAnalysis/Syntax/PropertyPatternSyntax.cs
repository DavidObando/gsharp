// <copyright file="PropertyPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Represents a property pattern <c>{ Name: pattern }</c>, optionally followed by a designation <c>{ Name: pattern } name</c>.</summary>
public sealed class PropertyPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="PropertyPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openBraceToken">The opening brace token.</param>
    /// <param name="fields">The field patterns.</param>
    /// <param name="closeBraceToken">The closing brace token.</param>
    /// <param name="designation">The optional ADR-0166 designation that names the matched (non-nil) value.</param>
    public PropertyPatternSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<PropertyPatternFieldSyntax> fields,
        SyntaxToken closeBraceToken,
        SyntaxToken? designation = null)
        : base(syntaxTree)
    {
        OpenBraceToken = openBraceToken;
        Fields = fields;
        CloseBraceToken = closeBraceToken;
        Designation = designation;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.PropertyPattern;

    /// <summary>Gets the opening brace token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field patterns.</summary>
    public SeparatedSyntaxList<PropertyPatternFieldSyntax> Fields { get; }

    /// <summary>Gets the closing brace token.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>
    /// Gets the optional designation identifier written after the closing brace
    /// (<c>{ Length: &gt; 0 } text</c>). ADR-0166: the designation binds the
    /// matched, non-nil value at the pattern's input type.
    /// </summary>
    public SyntaxToken? Designation { get; }

    /// <inheritdoc/>
    [SyntaxChildIgnore]
    public override SyntaxToken? BindingIdentifier => Designation;
}
