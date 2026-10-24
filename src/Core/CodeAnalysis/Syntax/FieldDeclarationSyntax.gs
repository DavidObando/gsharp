// <copyright file="FieldDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a field declaration inside a struct (Phase 3.B.1).
@SyntaxChildSourceOrder
partial class FieldDeclarationSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:FieldDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param varOrLetKeyword The required `var` or `let` binding keyword (ADR-0067). May be `null` only
    /// for parser error-recovery sites where the keyword was omitted; the parser also emits a diagnostic in
    /// that case.
    /// @param identifier The field identifier.
    /// @param type The field type clause.
    /// @param equalsToken The optional `=` token preceding the initializer.
    /// @param initializer The optional initializer expression.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        varOrLetKeyword SyntaxToken?,
        identifier SyntaxToken,
        type TypeClauseSyntax,
        equalsToken SyntaxToken? = nil,
        initializer ExpressionSyntax? = nil
    ) : base(syntaxTree) {
        Annotations = ImmutableArray[AnnotationSyntax].Empty
        AccessibilityModifier = accessibilityModifier
        VarOrLetKeyword = varOrLetKeyword
        Identifier = identifier
        Type = type
        EqualsToken = equalsToken
        Initializer = initializer
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FieldDeclaration

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this field
    /// declaration. Empty when no `@` lead-ins are present. Populated by
    /// the parser via (cref:WithAnnotations) so existing constructor
    /// overloads do not need to be touched. Declared before
    /// (cref:AccessibilityModifier) so that
    /// (cref:SyntaxNode.GetChildren) visits annotations first —
    /// keeping spans and first/last-token lookups stable.
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get;
        private set;
    }

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the required `var` or `let` binding keyword (ADR-0067).
    /// A `let` keyword marks the field as read-only (CLR `initonly`); a
    /// `var` keyword marks it as mutable. May be `null` only when the
    /// parser is recovering from a missing keyword and has already reported a
    /// diagnostic at the field's position.
    prop VarOrLetKeyword SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this field was declared with the
    /// `let` keyword and is therefore read-only (ADR-0067). A
    /// `const` field (Issue #948) is also read-only; see
    /// (cref:IsConst).
    prop IsReadOnly bool -> VarOrLetKeyword != nil &&
        (VarOrLetKeyword!!.Kind == SyntaxKind.LetKeyword || VarOrLetKeyword!!.Kind == SyntaxKind.ConstKeyword)

    /// Gets a value indicating whether this field was declared with the
    /// `const` keyword (Issue #948) and is therefore a compile-time
    /// constant: implicitly static, read-only, and emitted as a literal
    /// field whose initializer must be a constant expression.
    prop IsConst bool -> VarOrLetKeyword != nil && VarOrLetKeyword!!.Kind == SyntaxKind.ConstKeyword

    /// Gets the field identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the field type clause.
    prop Type TypeClauseSyntax {
        get;
    }

    /// Gets the optional `=` token preceding the initializer (Issue #262).
    prop EqualsToken SyntaxToken? {
        get;
    }

    /// Gets the optional initializer expression (Issue #262).
    prop Initializer ExpressionSyntax? {
        get;
    }

    /// Gets the `fixed` contextual keyword token for a fixed-size buffer
    /// field `fixed name [N]T` (ADR-0122 §10 / issue #1035), or
    /// `null` for an ordinary field.
    prop FixedKeyword SyntaxToken? {
        get;
        private set;
    }

    /// Gets a value indicating whether this declaration is a fixed-size buffer field (ADR-0122 §10 / issue
    /// #1035).
    prop IsFixedBuffer bool -> FixedKeyword != nil

    /// Marks this field declaration as a fixed-size buffer and records its `fixed` keyword token.
    /// @param fixedKeyword The `fixed` contextual keyword token.
    /// @returns This same (cref:FieldDeclarationSyntax) for fluent parser use.
    internal func WithFixedBuffer(fixedKeyword SyntaxToken) FieldDeclarationSyntax {
        FixedKeyword = fixedKeyword
        InvalidateCachedSpan()
        return this
    }

    /// Attaches the given annotation list to this field declaration and returns this same instance for
    /// fluent parser use.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:FieldDeclarationSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) FieldDeclarationSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }
}
