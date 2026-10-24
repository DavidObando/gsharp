// <copyright file="MemberSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents an abstract member in the language.
@SyntaxChildSourceOrder
abstract class MemberSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:MemberSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    protected init(syntaxTree SyntaxTree) : base(syntaxTree) {
        Annotations = ImmutableArray[AnnotationSyntax].Empty
    }

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this member
    /// declaration. Empty when the member has no `@` lead-ins.
    /// @remarks Annotations are populated by the parser via (cref:WithAnnotations)
    /// immediately after the concrete member node is constructed, so that
    /// existing constructor overloads on derived members do not need to be
    /// touched. (cref:SyntaxNode.GetChildren) finds the slot
    /// through reflection on the public `IEnumerable<SyntaxNode>`
    /// property.
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get;
        private set;
    }

    /// Attaches the given annotation list to this member and returns the same instance for fluent use by
    /// the parser.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:MemberSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) MemberSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }
}
