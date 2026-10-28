// <copyright file="InterfaceDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// Represents a `interface Name { ... }` declaration (Phase 3.B.4).
/// Per ADR-0018, interfaces in Phase 3 carry method signatures only — bodies,
/// default methods, and static members are diagnosed by the parser.
partial class InterfaceDeclarationSyntax : MemberSyntax {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private var baseColonToken SyntaxToken?

    private var baseTypeClauses SeparatedSyntaxList[TypeClauseSyntax] = SeparatedSyntaxList[TypeClauseSyntax](
        ImmutableArray[SyntaxNode].Empty
    )
    private var staticFields ImmutableArray[FieldDeclarationSyntax] = ImmutableArray[FieldDeclarationSyntax].Empty
    private var partialModifier SyntaxToken?

    /// Initializes a new instance of the (cref:InterfaceDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The interface identifier.
    /// @param typeParameterList The optional type-parameter list (Phase 4.3c / ADR-0020).
    /// @param sealedKeyword The optional `sealed` contextual keyword (Phase 3.B.5). Non-null restricts
    /// implementors to the same package.
    /// @param interfaceKeyword The `interface` keyword.
    /// @param openBraceToken The opening brace of the body.
    /// @param methods The method signatures declared inside the interface body.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        sealedKeyword SyntaxToken?,
        interfaceKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            typeParameterList,
            sealedKeyword,
            interfaceKeyword,
            openBraceToken,
            ImmutableArray[PropertyDeclarationSyntax].Empty,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:InterfaceDeclarationSyntax) class with property declarations
    /// (ADR-0051).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The interface identifier.
    /// @param typeParameterList The optional type-parameter list (Phase 4.3c / ADR-0020).
    /// @param sealedKeyword The optional `sealed` contextual keyword (Phase 3.B.5).
    /// @param interfaceKeyword The `interface` keyword.
    /// @param openBraceToken The opening brace of the body.
    /// @param properties The property declarations inside the interface body (ADR-0051).
    /// @param methods The method signatures declared inside the interface body.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        sealedKeyword SyntaxToken?,
        interfaceKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        properties ImmutableArray[PropertyDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            typeParameterList,
            sealedKeyword,
            interfaceKeyword,
            openBraceToken,
            properties,
            ImmutableArray[EventDeclarationSyntax].Empty,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:InterfaceDeclarationSyntax) class with property and event
    /// declarations (ADR-0051 / ADR-0052).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The interface identifier.
    /// @param typeParameterList The optional type-parameter list (Phase 4.3c / ADR-0020).
    /// @param sealedKeyword The optional `sealed` contextual keyword (Phase 3.B.5).
    /// @param interfaceKeyword The `interface` keyword.
    /// @param openBraceToken The opening brace of the body.
    /// @param properties The property declarations inside the interface body (ADR-0051).
    /// @param events The event declarations inside the interface body (ADR-0052).
    /// @param methods The method signatures declared inside the interface body.
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        sealedKeyword SyntaxToken?,
        interfaceKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        properties ImmutableArray[PropertyDeclarationSyntax],
        events ImmutableArray[EventDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        TypeKeyword = typeKeyword
        Identifier = identifier
        TypeParameterList = typeParameterList
        SealedKeyword = sealedKeyword
        InterfaceKeyword = interfaceKeyword
        OpenBraceToken = openBraceToken
        Properties = properties
        Events = events
        Methods = methods
        CloseBraceToken = closeBraceToken
    }

    /// Initializes a new instance of the (cref:InterfaceDeclarationSyntax) class without a type-parameter
    /// list (Phase 3 / 4.3c back-compat overload).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The interface identifier.
    /// @param sealedKeyword The optional `sealed` contextual keyword (Phase 3.B.5).
    /// @param interfaceKeyword The `interface` keyword.
    /// @param openBraceToken The opening brace of the body.
    /// @param methods The method signatures declared inside the interface body.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        sealedKeyword SyntaxToken?,
        interfaceKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            nil,
            sealedKeyword,
            interfaceKeyword,
            openBraceToken,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:InterfaceDeclarationSyntax) class without a sealed modifier
    /// (back-compat overload).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The interface identifier.
    /// @param interfaceKeyword The `interface` keyword.
    /// @param openBraceToken The opening brace of the body.
    /// @param methods The method signatures declared inside the interface body.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        interfaceKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            nil,
            interfaceKeyword,
            openBraceToken,
            methods,
            closeBraceToken
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.InterfaceDeclaration

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the `type` keyword.
    prop TypeKeyword SyntaxToken? {
        get;
    }

    /// Gets the interface identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional type-parameter list for generic interfaces (Phase 4.3c / ADR-0020).
    prop TypeParameterList TypeParameterListSyntax? {
        get;
    }

    /// Gets the optional `sealed` contextual keyword (Phase 3.B.5). Non-null marks this as a closed
    /// hierarchy whose implementors must live in the same package.
    prop SealedKeyword SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this interface was declared `sealed` (Phase 3.B.5).
    prop IsSealed bool -> SealedKeyword != nil

    /// Gets the `interface` keyword.
    prop InterfaceKeyword SyntaxToken {
        get;
    }

    internal prop IsProtocol bool -> InterfaceKeyword.Kind == SyntaxKind.IdentifierToken &&
        InterfaceKeyword.ValueText == "protocol"

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the property declarations inside the interface body (ADR-0051). Empty when no properties are
    /// declared.
    prop Properties ImmutableArray[PropertyDeclarationSyntax] {
        get;
    }

    /// Gets the event declarations inside the interface body (ADR-0052). Empty when no events are declared.
    prop Events ImmutableArray[EventDeclarationSyntax] {
        get;
    }

    /// Gets the method signatures (Body is always null on these, per ADR-0018).
    prop Methods ImmutableArray[FunctionDeclarationSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets or sets the optional base-interface clause colon token (issue #1006).
    /// Non-null when the interface declares one or more base interfaces, e.g.
    /// `interface B : A`. Mirrors (cref:StructDeclarationSyntax.BaseColonToken).
    prop BaseColonToken SyntaxToken? {
        get -> baseColonToken
        set {
            baseColonToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the comma-separated base-interface type clauses (issue #1006).
    /// Empty when the interface declares no base interfaces. Each clause must
    /// resolve to an interface; the binder rejects class/struct bases.
    prop BaseTypeClauses SeparatedSyntaxList[TypeClauseSyntax] {
        get -> baseTypeClauses
        set {
            baseTypeClauses = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this interface declares one or more base interfaces (issue #1006).
    prop HasBaseInterfaces bool -> BaseColonToken != nil

    /// Gets or sets the optional `partial` contextual modifier (ADR-0144 /
    /// issue #2201) on the interface declaration (`partial interface`).
    /// When non-null this declaration is one part of an interface that may be
    /// split across multiple declarations in the same package. Assigned by the
    /// parser; `null` otherwise.
    prop PartialModifier SyntaxToken? {
        get -> partialModifier
        set {
            partialModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this interface was declared `partial` (ADR-0144 / issue #2201).
    prop IsPartial bool -> PartialModifier != nil

    /// Gets or sets the identifier locations of every part of a merged
    /// `partial` interface (ADR-0144). Populated only on the synthetic node
    /// `PartialTypeMerger` produces; empty on an ordinary declaration. Drives
    /// go-to-definition returning all part locations. Its element type
    /// ((cref:Text.TextLocation)) is not a syntax node, so it is invisible
    /// to (cref:SyntaxNode.GetChildren) and does not affect this node's span.
    private var _partialPartLocations ImmutableArray[TextLocation] = ImmutableArray[TextLocation].Empty

    prop PartialPartLocations ImmutableArray[TextLocation] {
        get {
            return _partialPartLocations
        }
        set {
            _partialPartLocations = value
        }
    }

    /// Gets or sets the static field declarations (`var` / `let` /
    /// `const`) declared inside the interface `shared { … }` block
    /// (ADR-0089 / issue #1030). Empty when none. These bind to CLR static
    /// fields on the interface TypeDef. Populated post-construction by the
    /// parser (mirrors (cref:BaseTypeClauses)).
    prop StaticFields ImmutableArray[FieldDeclarationSyntax] {
        get -> staticFields
        set {
            staticFields = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets matching type-parameter lists retained from merged partial
    /// declarations so constraint binding can use each list's syntax-tree provenance.
    /// Empty for ordinary declarations and GS0480-mismatched partial groups.
    private var _partialTypeParameterLists ImmutableArray[TypeParameterListSyntax] = ImmutableArray[
        TypeParameterListSyntax
    ].Empty

    internal prop PartialTypeParameterLists ImmutableArray[TypeParameterListSyntax] {
        get {
            return _partialTypeParameterLists
        }
        set {
            _partialTypeParameterLists = value
        }
    }

    /// Gets or sets the whole-node location of every part of a merged `partial`
    /// type, in part order. The merged node spans only the first part's braces, so
    /// a position in a later part (an empty one has no member to lead to it) is
    /// resolved through these. Empty on an ordinary declaration. Internal: the
    /// semantic model is the only reader.
    private var _partialPartExtents ImmutableArray[TextLocation] = ImmutableArray[TextLocation].Empty

    internal prop PartialPartExtents ImmutableArray[TextLocation] {
        get {
            return _partialPartExtents
        }
        set {
            _partialPartExtents = value
        }
    }
}
