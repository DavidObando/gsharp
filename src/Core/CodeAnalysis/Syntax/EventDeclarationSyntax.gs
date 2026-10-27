// <copyright file="EventDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents an `event Name Type` declaration inside a type body (ADR-0052).
@SyntaxChildSourceOrder
partial class EventDeclarationSyntax : SyntaxNode {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private var explicitInterfaceOpenParenToken SyntaxToken?

    private var explicitInterfaceType TypeClauseSyntax?
    private var explicitInterfaceCloseParenToken SyntaxToken?

    /// Initializes a new instance of the (cref:EventDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param openModifier The optional `open` contextual keyword.
    /// @param overrideModifier The optional `override` contextual keyword.
    /// @param eventKeyword The identifier token whose text is `event`.
    /// @param identifier The event name.
    /// @param type The event handler type clause.
    /// @param openBraceToken The optional opening brace.
    /// @param accessors The add/remove accessor list.
    /// @param closeBraceToken The optional closing brace.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        eventKeyword SyntaxToken,
        identifier SyntaxToken,
        type TypeClauseSyntax?,
        openBraceToken SyntaxToken?,
        accessors ImmutableArray[EventAccessorSyntax],
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        Annotations = ImmutableArray[AnnotationSyntax].Empty
        AccessibilityModifier = accessibilityModifier
        OpenModifier = openModifier
        OverrideModifier = overrideModifier
        EventKeyword = eventKeyword
        Identifier = identifier
        Type = type
        OpenBraceToken = openBraceToken
        Accessors = accessors
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.EventDeclaration

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this event declaration.
    /// Empty when no `@` lead-ins are present.
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get;
        private set;
    }

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the optional `open` contextual keyword.
    prop OpenModifier SyntaxToken? {
        get;
    }

    /// Gets the optional `override` contextual keyword.
    prop OverrideModifier SyntaxToken? {
        get;
    }

    /// Gets the identifier token whose text is `event`.
    prop EventKeyword SyntaxToken {
        get;
    }

    /// Gets the event name identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the event handler type clause.
    prop Type TypeClauseSyntax? {
        get;
    }

    /// Gets the optional opening brace token.
    prop OpenBraceToken SyntaxToken? {
        get;
    }

    /// Gets the add/remove accessor list. Empty for field-like events.
    prop Accessors ImmutableArray[EventAccessorSyntax] {
        get;
    }

    /// Gets the optional closing brace token.
    prop CloseBraceToken SyntaxToken? {
        get;
    }

    /// Gets or sets the optional open parenthesis introducing a dedicated
    /// explicit-interface-implementation qualifier clause, e.g. `event (IFoo) Changed T`
    /// (ADR-0149). Assigned by the parser; `null` for an ordinary event.
    prop ExplicitInterfaceOpenParenthesisToken SyntaxToken? {
        get -> explicitInterfaceOpenParenToken
        set {
            explicitInterfaceOpenParenToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the interface type referenced by the explicit-interface qualifier
    /// clause (ADR-0149). Assigned by the parser; `null` when no clause is present.
    prop ExplicitInterfaceType TypeClauseSyntax? {
        get -> explicitInterfaceType
        set {
            explicitInterfaceType = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional close parenthesis terminating the explicit-interface qualifier clause
    /// (ADR-0149).
    prop ExplicitInterfaceCloseParenthesisToken SyntaxToken? {
        get -> explicitInterfaceCloseParenToken
        set {
            explicitInterfaceCloseParenToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries an explicit-interface qualifier clause
    /// (ADR-0149).
    prop HasExplicitInterfaceClause bool -> ExplicitInterfaceType != nil

    /// Attaches the given annotation list to this event declaration and returns this same instance for
    /// fluent parser use.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:EventDeclarationSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) EventDeclarationSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }

    /// ADR-0149: attaches a parsed explicit-interface qualifier clause (or no-ops when
    /// [`type`](paramref) is `null`). Returns this same instance for
    /// fluent parser use.
    /// @param openParen The open parenthesis token, or `null` when no clause is present.
    /// @param type The interface type clause, or `null` when no clause is present.
    /// @param closeParen The close parenthesis token, or `null` when no clause is present.
    /// @returns This same (cref:EventDeclarationSyntax).
    internal func WithExplicitInterfaceClause(
        openParen SyntaxToken?,
        type TypeClauseSyntax?,
        closeParen SyntaxToken?
    ) EventDeclarationSyntax {
        if type == nil {
            return this
        }
        ExplicitInterfaceOpenParenthesisToken = openParen
        ExplicitInterfaceType = type
        ExplicitInterfaceCloseParenthesisToken = closeParen
        return this
    }
}
