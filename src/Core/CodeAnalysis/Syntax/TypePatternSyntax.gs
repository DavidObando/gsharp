// <copyright file="TypePatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a type pattern: the bare `T`, the switch binding spelling
/// `v is T`, or the ADR-0166 designation spelling `T v`. A recursive
/// property-pattern suffix may follow the type in every spelling.
partial class TypePatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:TypePatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The binding identifier of the `v is T` spelling.
    /// @param isKeyword The `is` keyword.
    /// @param type The target type clause.
    /// @param propertyPattern The optional recursive property-pattern suffix.
    /// @param designation The optional ADR-0166 designation written after the type (`T v`).
    init(
        syntaxTree SyntaxTree,
        identifier SyntaxToken?,
        isKeyword SyntaxToken?,
        type TypeClauseSyntax,
        propertyPattern PropertyPatternSyntax? = nil,
        designation SyntaxToken? = nil
    ) : base(syntaxTree) {
        Identifier = identifier
        IsKeyword = isKeyword
        Type = type
        PropertyPattern = propertyPattern
        Designation = designation
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TypePattern

    /// Gets the binding identifier of the `v is T` spelling.
    prop Identifier SyntaxToken? {
        get;
    }

    /// Gets the `is` keyword.
    prop IsKeyword SyntaxToken? {
        get;
    }

    /// Gets the target type clause.
    prop Type TypeClauseSyntax {
        get;
    }

    /// Gets the optional recursive property-pattern suffix.
    prop PropertyPattern PropertyPatternSyntax? {
        get;
    }

    /// Gets the optional designation identifier written after the type and any
    /// property-pattern suffix (`string text`, `Dog { Name: "Rex" } dog`).
    /// ADR-0166: this is the C#-equivalent spelling for a pattern variable.
    prop Designation SyntaxToken? {
        get;
    }

    /// Gets the identifier that names the pattern variable in either spelling,
    /// or `null` when the pattern binds nothing.
    @SyntaxChildIgnore
    override prop BindingIdentifier SyntaxToken? -> Identifier ?? Designation
}
