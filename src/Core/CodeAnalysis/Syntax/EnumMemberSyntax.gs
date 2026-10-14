// <copyright file="EnumMemberSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a member in a `enum Name { ... }` declaration.
class EnumMemberSyntax : SyntaxNode {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private var payloadOpenParenthesis SyntaxToken?

    private var payloadParameters SeparatedSyntaxList[ParameterSyntax]?
    private var payloadCloseParenthesis SyntaxToken?
    private var equalsToken SyntaxToken?
    private var value ExpressionSyntax?

    /// Initializes a new instance of the (cref:EnumMemberSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param identifier The enum member identifier.
    init(syntaxTree SyntaxTree, identifier SyntaxToken) : base(syntaxTree) {
        Annotations = ImmutableArray[AnnotationSyntax].Empty
        Identifier = identifier
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.EnumMember

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this enum
    /// member. Empty when no `@` lead-ins are present. Populated by the
    /// parser via (cref:WithAnnotations) so existing constructor
    /// overloads do not need to be touched. Declared before
    /// (cref:Identifier) so that (cref:SyntaxNode.GetChildren)
    /// visits annotations first — keeping spans and first/last-token lookups
    /// stable.
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get;
        private set;
    }

    /// Gets the enum member identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the opening parenthesis for the optional payload parameter list
    /// (ADR-0078 / issue #725). Null when the case has no payload.
    prop PayloadOpenParenthesis SyntaxToken? {
        get -> payloadOpenParenthesis
        internal set {
            payloadOpenParenthesis = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the optional primary-constructor parameter list for this enum
    /// case (ADR-0078 / issue #725). Empty when the case has no payload —
    /// inspect (cref:HasPayload) to distinguish.
    prop PayloadParameters SeparatedSyntaxList[ParameterSyntax]? {
        get -> payloadParameters
        internal set {
            payloadParameters = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the closing parenthesis for the optional payload parameter list
    /// (ADR-0078 / issue #725). Null when the case has no payload.
    prop PayloadCloseParenthesis SyntaxToken? {
        get -> payloadCloseParenthesis
        internal set {
            payloadCloseParenthesis = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this case has a payload parameter list.
    prop HasPayload bool -> PayloadOpenParenthesis != nil

    /// Gets the `=` token for an explicit member value (issue #1912),
    /// e.g. `Banana = 2`. Null when the member has no explicit value.
    prop EqualsToken SyntaxToken? {
        get -> equalsToken
        internal set {
            equalsToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the explicit constant-value expression (issue #1912) following
    /// (cref:EqualsToken). Null when the member has no explicit value.
    prop Value ExpressionSyntax? {
        get -> value
        internal set {
            this.value = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this member has an explicit constant-value expression.
    prop HasExplicitValue bool -> EqualsToken != nil

    /// Attaches the given annotation list to this enum member and returns this same instance for fluent
    /// parser use.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:EnumMemberSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) EnumMemberSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }
}
