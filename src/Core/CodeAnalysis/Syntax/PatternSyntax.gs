// <copyright file="PatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Base type for switch case patterns.
abstract class PatternSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:PatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    protected init(syntaxTree SyntaxTree) : base(syntaxTree) { }

    /// Gets the identifier bound by this pattern, or `null`.
    @SyntaxChildIgnore
    open prop BindingIdentifier SyntaxToken? -> nil
}
