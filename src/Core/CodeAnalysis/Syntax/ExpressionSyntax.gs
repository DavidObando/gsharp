// <copyright file="ExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an abstract expression in the language.
abstract class ExpressionSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:ExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    protected init(syntaxTree SyntaxTree) : base(syntaxTree) { }
}
