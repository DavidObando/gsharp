// <copyright file="VariableDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a variable declaration syntax in the language.
partial class VariableDeclarationSyntax : StatementSyntax {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private var asyncModifier SyntaxToken?

    private var scopedModifier SyntaxToken?
    private var refKindModifier SyntaxToken?
    private var readOnlyRefModifier SyntaxToken?
    private var typeParameterList TypeParameterListSyntax?

    /// Initializes a new instance of the (cref:VariableDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The var keyword.
    /// @param identifier The variable identifier.
    /// @param typeClause The optional type clause.
    /// @param equalsToken The equals token.
    /// @param initializer The initializer expression.
    convenience init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken?,
        identifier SyntaxToken,
        typeClause TypeClauseSyntax?,
        equalsToken SyntaxToken?,
        initializer ExpressionSyntax?
    ) {
        init(syntaxTree, nil, keyword, identifier, typeClause, equalsToken, initializer)
    }

    /// Initializes a new instance of the (cref:VariableDeclarationSyntax) class with an explicit
    /// accessibility modifier.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier (only allowed at top level).
    /// @param keyword The var keyword.
    /// @param identifier The variable identifier.
    /// @param typeClause The optional type clause.
    /// @param equalsToken The equals token.
    /// @param initializer The initializer expression.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        keyword SyntaxToken?,
        identifier SyntaxToken,
        typeClause TypeClauseSyntax?,
        equalsToken SyntaxToken?,
        initializer ExpressionSyntax?
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        Keyword = keyword
        Identifier = identifier
        TypeClause = typeClause
        EqualsToken = equalsToken
        Initializer = initializer
        Annotations = ImmutableArray[AnnotationSyntax].Empty
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.VariableDeclaration

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this variable
    /// declaration. Empty when no `@` lead-ins are present. Populated by
    /// the parser via (cref:WithAnnotations) so existing constructor
    /// overloads do not need to be touched. Declared first so that
    /// (cref:SyntaxNode.GetChildren) visits annotations before the
    /// remaining tokens — keeping spans and first/last-token lookups stable.
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get;
        private set;
    }

    /// Gets the optional accessibility modifier token. Only meaningful for top-level declarations.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets or sets the optional `async` modifier of an `async let`
    /// binding (ADR-0174 D15). When non-null the initializer is started as a
    /// child of the enclosing `scope` and the binding names its eventual
    /// result, read with `await`. Declared before (cref:Keyword) so
    /// child enumeration stays in source order.
    prop AsyncModifier SyntaxToken? {
        get -> asyncModifier
        set {
            asyncModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this is an `async let` binding (ADR-0174 D15).
    prop IsAsyncLet bool -> AsyncModifier != nil

    /// Gets the var keyword.
    prop Keyword SyntaxToken? {
        get;
    }

    /// Gets or sets the optional `scoped` contextual modifier token (ADR-0058 / issue #376).
    /// When non-null, the local's safe-to-escape scope is restricted to the current function body.
    prop ScopedModifier SyntaxToken? {
        get -> scopedModifier
        set {
            scopedModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries the `scoped` modifier (ADR-0058).
    prop IsScoped bool -> ScopedModifier != nil

    /// Gets or sets the optional `ref` contextual modifier token (ADR-0060 follow-up / issue #491).
    /// When non-null, this declaration is a ref-aliasing local: the slot stores a managed pointer to the
    /// initializer's lvalue and reads/writes through the local indirect through the alias.
    prop RefKindModifier SyntaxToken? {
        get -> refKindModifier
        set {
            refKindModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries the `ref` aliasing modifier (issue #491).
    prop HasRefKindModifier bool -> RefKindModifier != nil

    /// Gets or sets the contextual `readonly` token following a local alias's `ref`.
    prop ReadOnlyRefModifier SyntaxToken? {
        get -> readOnlyRefModifier
        set {
            readOnlyRefModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the variable identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets or sets the optional generic type-parameter list (e.g. `[T]`, `[T, U]`) on a
    /// `let`-bound generic function literal (issue #1886):
    /// `let First[T] = func (a T, b T) T { ... }`. `null` for non-generic declarations.
    /// Assigned by the parser.
    prop TypeParameterList TypeParameterListSyntax? {
        get -> typeParameterList
        set {
            typeParameterList = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries a generic type-parameter list (issue
    /// #1886).
    prop IsGeneric bool -> TypeParameterList != nil

    /// GEts the optional type clause.
    prop TypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the equals token.
    prop EqualsToken SyntaxToken? {
        get;
    }

    /// Gets the initializer expression.
    prop Initializer ExpressionSyntax? {
        get;
    }

    /// Attaches the given annotation list to this variable declaration and returns this same instance for
    /// fluent parser use.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:VariableDeclarationSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) VariableDeclarationSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }
}
