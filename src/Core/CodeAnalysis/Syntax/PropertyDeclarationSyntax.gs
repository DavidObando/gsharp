// <copyright file="PropertyDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a `prop Name Type { get; set }` declaration inside a type body (ADR-0051).
@SyntaxChildSourceOrder
partial class PropertyDeclarationSyntax : SyntaxNode {
    // Backing field for the property the parser assigns after construction. Its setter
    // invalidates the node's cached span (issue #1675).
    private var staticModifier SyntaxToken?

    private var abstractModifier SyntaxToken?
    private var explicitInterfaceOpenParenToken SyntaxToken?
    private var explicitInterfaceType TypeClauseSyntax?
    private var explicitInterfaceCloseParenToken SyntaxToken?
    private var returnRefModifier SyntaxToken?
    private var returnReadOnlyModifier SyntaxToken?

    /// Initializes a new instance of the (cref:PropertyDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param openModifier The optional `open` contextual keyword.
    /// @param overrideModifier The optional `override` contextual keyword.
    /// @param propKeyword The identifier token whose text is `prop`.
    /// @param identifier The property name.
    /// @param type The property type.
    /// @param openBraceToken The optional opening brace.
    /// @param accessors The get/set accessor list.
    /// @param closeBraceToken The optional closing brace.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        propKeyword SyntaxToken,
        identifier SyntaxToken,
        type TypeClauseSyntax?,
        openBraceToken SyntaxToken?,
        accessors ImmutableArray[PropertyAccessorSyntax],
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        Annotations = ImmutableArray[AnnotationSyntax].Empty
        Parameters = SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty)
        AccessibilityModifier = accessibilityModifier
        OpenModifier = openModifier
        OverrideModifier = overrideModifier
        PropKeyword = propKeyword
        Identifier = identifier
        Type = type
        OpenBraceToken = openBraceToken
        Accessors = accessors
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.PropertyDeclaration

    /// Gets the Kotlin-style annotations (ADR-0047) attached to this property declaration.
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

    /// Gets or sets the explicit `abstract` property modifier.
    prop AbstractModifier SyntaxToken? {
        get -> abstractModifier
        set {
            abstractModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the `shared` contextual keyword token when this property
    /// is a static-virtual interface member declared inside an interface
    /// `shared { … }` block (ADR-0089 / issue #1019), or
    /// `null` for an ordinary instance property.
    @SyntaxChildIgnore
    prop StaticModifier SyntaxToken? {
        get -> staticModifier
        set {
            staticModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this property carries a `shared` static modifier (ADR-0089 / issue
    /// #1019).
    prop HasStaticModifier bool -> StaticModifier != nil

    /// Gets or sets the optional open parenthesis introducing a dedicated
    /// explicit-interface-implementation qualifier clause, e.g. `prop (IFoo) P T` or
    /// `prop (IFoo) this[...] T` (ADR-0149). Assigned by the parser; `null`
    /// for an ordinary property/indexer.
    prop ExplicitInterfaceOpenParenthesisToken SyntaxToken? {
        get -> explicitInterfaceOpenParenToken
        set {
            explicitInterfaceOpenParenToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the interface type referenced by the explicit-interface qualifier
    /// clause (ADR-0149), e.g. the `IFoo` in `prop (IFoo) P T`. Assigned by the
    /// parser; `null` when no clause is present.
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

    /// Gets the identifier token whose text is `prop`.
    prop PropKeyword SyntaxToken {
        get;
    }

    /// Gets the property name identifier. For an indexer (ADR-0118) this is the `this` contextual keyword
    /// token.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the `this` contextual keyword token when this declaration is an
    /// indexer member (ADR-0118), or `null` for an ordinary property.
    prop ThisKeyword SyntaxToken? {
        get;
        private set;
    }

    /// Gets the optional opening bracket token of an indexer parameter list (ADR-0118).
    prop OpenBracketToken SyntaxToken? {
        get;
        private set;
    }

    /// Gets the indexer parameter list (ADR-0118). Empty for an ordinary property.
    prop Parameters SeparatedSyntaxList[ParameterSyntax] {
        get;
        private set;
    }

    /// Gets the optional closing bracket token of an indexer parameter list (ADR-0118).
    prop CloseBracketToken SyntaxToken? {
        get;
        private set;
    }

    /// Gets a value indicating whether this declaration is an indexer member (ADR-0118).
    prop IsIndexer bool -> ThisKeyword != nil

    /// Gets or sets the optional `ref` contextual modifier preceding the
    /// property's (or indexer's) type clause — `prop P ref int32 { get { … } }`
    /// / `prop this[i int32] ref int32 -> …` (issue #3879, ADR-0060
    /// amendment). When non-null the property's getter returns a managed
    /// pointer, so a CLR consumer sees `T&` and can alias the storage.
    /// Assigned by the parser; `null` otherwise. Mirrors
    /// (cref:FunctionDeclarationSyntax.ReturnRefModifier) exactly, which
    /// is the spelling this one was modelled on.
    prop ReturnRefModifier SyntaxToken? {
        get -> returnRefModifier
        set {
            returnRefModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this property/indexer declares a `ref` return (issue #3879).
    prop IsRefReturn bool -> ReturnRefModifier != nil

    /// Gets or sets the contextual `readonly` token following a return's `ref`.
    prop ReturnReadOnlyModifier SyntaxToken? {
        get -> returnReadOnlyModifier
        set {
            returnReadOnlyModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets the property type.
    prop Type TypeClauseSyntax? {
        get;
    }

    /// Gets the optional opening brace token.
    prop OpenBraceToken SyntaxToken? {
        get;
    }

    /// Gets the get/set accessor list.
    prop Accessors ImmutableArray[PropertyAccessorSyntax] {
        get;
    }

    /// Gets the optional closing brace token.
    prop CloseBraceToken SyntaxToken? {
        get;
    }

    /// Attaches the given annotation list to this property declaration and returns this same instance for
    /// fluent parser use.
    /// @param annotations The annotation list to attach (may be empty).
    /// @returns This same (cref:PropertyDeclarationSyntax), with (cref:Annotations) updated.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) PropertyDeclarationSyntax {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
        InvalidateCachedSpan()
        return this
    }

    /// Issue #3879: attaches the parsed `ref` return modifier (or no-ops when
    /// [`modifier`](paramref) is `null`). Returns this same
    /// instance for fluent parser use.
    /// @param modifier The `ref` token, or `null` when the property returns by value.
    /// @param readOnlyModifier The optional `readonly` token.
    /// @returns This same (cref:PropertyDeclarationSyntax).
    internal func WithReturnRefModifier(
        modifier SyntaxToken?,
        readOnlyModifier SyntaxToken? = nil
    ) PropertyDeclarationSyntax {
        if modifier == nil {
            return this
        }
        ReturnRefModifier = modifier
        ReturnReadOnlyModifier = readOnlyModifier
        return this
    }

    /// ADR-0149: attaches a parsed explicit-interface qualifier clause (or no-ops when
    /// [`type`](paramref) is `null`). Returns this same instance for
    /// fluent parser use.
    /// @param openParen The open parenthesis token, or `null` when no clause is present.
    /// @param type The interface type clause, or `null` when no clause is present.
    /// @param closeParen The close parenthesis token, or `null` when no clause is present.
    /// @returns This same (cref:PropertyDeclarationSyntax).
    internal func WithExplicitInterfaceClause(
        openParen SyntaxToken?,
        type TypeClauseSyntax?,
        closeParen SyntaxToken?
    ) PropertyDeclarationSyntax {
        if type == nil {
            return this
        }
        ExplicitInterfaceOpenParenthesisToken = openParen
        ExplicitInterfaceType = type
        ExplicitInterfaceCloseParenthesisToken = closeParen
        return this
    }

    /// ADR-0118: marks this declaration as an indexer member by attaching the
    /// `this` keyword token, the bracket tokens, and the index parameter
    /// list. Returns this same instance for fluent parser use.
    /// @param thisKeyword The `this` contextual keyword token.
    /// @param openBracketToken The opening bracket token.
    /// @param parameters The index parameter list.
    /// @param closeBracketToken The closing bracket token.
    /// @returns This same (cref:PropertyDeclarationSyntax), marked as an indexer.
    internal func WithIndexer(
        thisKeyword SyntaxToken,
        openBracketToken SyntaxToken,
        parameters SeparatedSyntaxList[ParameterSyntax],
        closeBracketToken SyntaxToken
    ) PropertyDeclarationSyntax {
        ThisKeyword = thisKeyword
        OpenBracketToken = openBracketToken
        Parameters = parameters ?? SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty)
        CloseBracketToken = closeBracketToken
        InvalidateCachedSpan()
        return this
    }
}
