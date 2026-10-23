// <copyright file="VarPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a total `var name` pattern. The pattern always matches and
/// binds the input at its static type; `var _` binds nothing.
partial class VarPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:VarPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param varKeyword The `var` keyword.
    /// @param designation The binding identifier or discard.
    init(syntaxTree SyntaxTree, varKeyword SyntaxToken, designation SyntaxToken) : base(syntaxTree) {
        VarKeyword = varKeyword
        Designation = designation
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.VarPattern

    /// Gets the `var` keyword.
    prop VarKeyword SyntaxToken {
        get;
    }

    /// Gets the binding identifier or discard.
    prop Designation SyntaxToken {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    @SyntaxChildIgnore
    override prop BindingIdentifier SyntaxToken? -> if Designation.Text == "_" {
        default(SyntaxToken?)
    } else {
        Designation
    }
}
