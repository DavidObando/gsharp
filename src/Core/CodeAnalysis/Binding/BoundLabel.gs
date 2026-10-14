// <copyright file="BoundLabel.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound label.
class BoundLabel {
    /// Initializes a new instance of the (cref:BoundLabel) class.
    /// @param name The label name.
    /// @param declaringSyntax The originating label-declaration syntax (may be `null`
    /// for compiler-synthesised labels — break/continue/exit anchors emitted by
    /// the lowering pipeline, async-resume points, etc.). Used by the Portable
    /// PDB emitter to anchor branch-target sequence points per ADR-0027 §7.7a.
    init(name string, declaringSyntax SyntaxNode? = nil) {
        Name = name
        DeclaringSyntax = declaringSyntax
    }

    /// Gets the label name.
    prop Name string {
        get;
    }

    /// Gets the originating label-declaration syntax for this label, or
    /// `null` when the label is compiler-synthesised.
    prop DeclaringSyntax SyntaxNode? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func ToString() string -> Name
}
