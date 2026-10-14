// <copyright file="StatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an abstract statement syntax in the language.
abstract class StatementSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:StatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    protected init(syntaxTree SyntaxTree) : base(syntaxTree) { }
}
