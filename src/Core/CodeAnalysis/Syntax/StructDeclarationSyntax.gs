// <copyright file="StructDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable

/// Represents a Go-style `struct Name { ... }` declaration (Phase 3.B.1).
partial class StructDeclarationSyntax : MemberSyntax {
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675) so a span computed before the mutation is
    // never served afterwards.
    private var baseTypeClauses SeparatedSyntaxList[TypeClauseSyntax] = SeparatedSyntaxList[TypeClauseSyntax](
        ImmutableArray[SyntaxNode].Empty
    )

    private var unsafeModifier SyntaxToken?
    private var partialModifier SyntaxToken?
    private var typeParameterList TypeParameterListSyntax?
    private var refModifier SyntaxToken?
    private var abstractModifier SyntaxToken?
    private var sharedModifier SyntaxToken?
    private var sharedInitializers ImmutableArray[StaticInitializerBlockSyntax] = ImmutableArray[
        StaticInitializerBlockSyntax
    ].Empty
    private var sharedBlock SharedBlockSyntax?
    private var baseConstructorOpenParenthesisToken SyntaxToken?
    private var baseConstructorArguments SeparatedSyntaxList[ExpressionSyntax]?
    private var baseConstructorCloseParenthesisToken SyntaxToken?
    private var sealedKeyword SyntaxToken?
    private var constructors ImmutableArray[ConstructorDeclarationSyntax] = ImmutableArray[
        ConstructorDeclarationSyntax
    ].Empty
    private var deinitializer DeinitDeclarationSyntax?
    private var nestedTypes ImmutableArray[MemberSyntax] = ImmutableArray[MemberSyntax].Empty

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The struct identifier.
    /// @param structKeyword The `struct` keyword.
    /// @param openBraceToken The opening brace.
    /// @param fields The field declarations.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        structKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            nil,
            nil,
            structKeyword,
            openBraceToken,
            fields,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The struct identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param structKeyword The `struct` keyword.
    /// @param openBraceToken The opening brace.
    /// @param fields The field declarations.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        structKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            structKeyword,
            nil,
            SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty),
            nil,
            openBraceToken,
            fields,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The aggregate identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param structKeyword The `struct` or `class` keyword.
    /// @param primaryConstructorOpenParen The optional opening paren of a Kotlin-style primary constructor
    /// (classes only).
    /// @param primaryConstructorParameters The primary constructor parameter list (empty when no primary
    /// constructor is declared).
    /// @param primaryConstructorCloseParen The optional closing paren of the primary constructor.
    /// @param openBraceToken The opening brace of the body.
    /// @param fields The body field declarations.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        structKeyword SyntaxToken,
        primaryConstructorOpenParen SyntaxToken?,
        primaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]?,
        primaryConstructorCloseParen SyntaxToken?,
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            structKeyword,
            primaryConstructorOpenParen,
            primaryConstructorParameters,
            primaryConstructorCloseParen,
            openBraceToken,
            fields,
            ImmutableArray[FunctionDeclarationSyntax].Empty,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The aggregate identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param structKeyword The `struct` or `class` keyword.
    /// @param primaryConstructorOpenParen The optional opening paren of a Kotlin-style primary constructor
    /// (classes only).
    /// @param primaryConstructorParameters The primary constructor parameter list (empty when no primary
    /// constructor is declared).
    /// @param primaryConstructorCloseParen The optional closing paren of the primary constructor.
    /// @param openBraceToken The opening brace of the body.
    /// @param fields The body field declarations.
    /// @param methods The method declarations in the body (classes only, Phase 3.B.3 sub-step 2b).
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        structKeyword SyntaxToken,
        primaryConstructorOpenParen SyntaxToken?,
        primaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]?,
        primaryConstructorCloseParen SyntaxToken?,
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            nil,
            structKeyword,
            primaryConstructorOpenParen,
            primaryConstructorParameters,
            primaryConstructorCloseParen,
            nil,
            nil,
            openBraceToken,
            fields,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The aggregate identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param openModifier The optional `open` contextual keyword (Phase 3.B.3 sub-step 3 — classes only).
    /// @param structKeyword The `struct` or `class` keyword.
    /// @param primaryConstructorOpenParen The optional opening paren of a Kotlin-style primary constructor
    /// (classes only).
    /// @param primaryConstructorParameters The primary constructor parameter list (empty when no primary
    /// constructor is declared).
    /// @param primaryConstructorCloseParen The optional closing paren of the primary constructor.
    /// @param baseColonToken The optional `:` token introducing a base class clause (Phase 3.B.3 sub-step
    /// 3).
    /// @param baseTypeIdentifier The optional base class identifier; non-null only when
    /// [`baseColonToken`](paramref) is non-null.
    /// @param openBraceToken The opening brace of the body.
    /// @param fields The body field declarations.
    /// @param methods The method declarations in the body (classes only, Phase 3.B.3 sub-step 2b).
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        openModifier SyntaxToken?,
        structKeyword SyntaxToken,
        primaryConstructorOpenParen SyntaxToken?,
        primaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]?,
        primaryConstructorCloseParen SyntaxToken?,
        baseColonToken SyntaxToken?,
        baseTypeIdentifier SyntaxToken?,
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            structKeyword,
            primaryConstructorOpenParen,
            primaryConstructorParameters,
            primaryConstructorCloseParen,
            baseColonToken,
            baseTypeIdentifier,
            ImmutableArray[SyntaxToken?].Empty,
            openBraceToken,
            fields,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class (Phase 3.B.4 —
    /// multi-identifier base/interface clause).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The aggregate identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param openModifier The optional `open` contextual keyword (classes only).
    /// @param structKeyword The `struct` or `class` keyword.
    /// @param primaryConstructorOpenParen The optional opening paren of a primary constructor.
    /// @param primaryConstructorParameters The primary constructor parameter list.
    /// @param primaryConstructorCloseParen The optional closing paren of the primary constructor.
    /// @param baseColonToken The optional `:` token introducing a base/interface clause.
    /// @param baseTypeIdentifier The first identifier in the base/interface clause.
    /// @param additionalBaseTypeIdentifiers Subsequent comma-separated identifiers in the base/interface
    /// clause (Phase 3.B.4).
    /// @param openBraceToken The opening brace of the body.
    /// @param fields The body field declarations.
    /// @param methods The method declarations in the body.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        openModifier SyntaxToken?,
        structKeyword SyntaxToken,
        primaryConstructorOpenParen SyntaxToken?,
        primaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]?,
        primaryConstructorCloseParen SyntaxToken?,
        baseColonToken SyntaxToken?,
        baseTypeIdentifier SyntaxToken?,
        additionalBaseTypeIdentifiers ImmutableArray[SyntaxToken?],
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            structKeyword,
            primaryConstructorOpenParen,
            primaryConstructorParameters,
            primaryConstructorCloseParen,
            baseColonToken,
            baseTypeIdentifier,
            additionalBaseTypeIdentifiers,
            openBraceToken,
            fields,
            ImmutableArray[PropertyDeclarationSyntax].Empty,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class (ADR-0051 — with property
    /// declarations).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The aggregate identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param openModifier The optional `open` contextual keyword (classes only).
    /// @param structKeyword The `struct` or `class` keyword.
    /// @param primaryConstructorOpenParen The optional opening paren of a primary constructor.
    /// @param primaryConstructorParameters The primary constructor parameter list.
    /// @param primaryConstructorCloseParen The optional closing paren of the primary constructor.
    /// @param baseColonToken The optional `:` token introducing a base/interface clause.
    /// @param baseTypeIdentifier The first identifier in the base/interface clause.
    /// @param additionalBaseTypeIdentifiers Subsequent comma-separated identifiers in the base/interface
    /// clause (Phase 3.B.4).
    /// @param openBraceToken The opening brace of the body.
    /// @param fields The body field declarations.
    /// @param properties The property declarations in the body (ADR-0051).
    /// @param methods The method declarations in the body.
    /// @param closeBraceToken The closing brace.
    convenience init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        openModifier SyntaxToken?,
        structKeyword SyntaxToken,
        primaryConstructorOpenParen SyntaxToken?,
        primaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]?,
        primaryConstructorCloseParen SyntaxToken?,
        baseColonToken SyntaxToken?,
        baseTypeIdentifier SyntaxToken?,
        additionalBaseTypeIdentifiers ImmutableArray[SyntaxToken?],
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        properties ImmutableArray[PropertyDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) {
        init(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            structKeyword,
            primaryConstructorOpenParen,
            primaryConstructorParameters,
            primaryConstructorCloseParen,
            baseColonToken,
            baseTypeIdentifier,
            additionalBaseTypeIdentifiers,
            openBraceToken,
            fields,
            properties,
            ImmutableArray[EventDeclarationSyntax].Empty,
            methods,
            closeBraceToken
        )
    }

    /// Initializes a new instance of the (cref:StructDeclarationSyntax) class (ADR-0052 — with event
    /// declarations).
    /// @param syntaxTree The parent syntax tree.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @param typeKeyword The `type` keyword.
    /// @param identifier The aggregate identifier.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param inlineKeyword The optional `inline` contextual keyword.
    /// @param openModifier The optional `open` contextual keyword (classes only).
    /// @param structKeyword The `struct` or `class` keyword.
    /// @param primaryConstructorOpenParen The optional opening paren of a primary constructor.
    /// @param primaryConstructorParameters The primary constructor parameter list.
    /// @param primaryConstructorCloseParen The optional closing paren of the primary constructor.
    /// @param baseColonToken The optional `:` token introducing a base/interface clause.
    /// @param baseTypeIdentifier The first identifier in the base/interface clause.
    /// @param additionalBaseTypeIdentifiers Subsequent comma-separated identifiers in the base/interface
    /// clause (Phase 3.B.4).
    /// @param openBraceToken The opening brace of the body.
    /// @param fields The body field declarations.
    /// @param properties The property declarations in the body (ADR-0051).
    /// @param events The event declarations in the body (ADR-0052).
    /// @param methods The method declarations in the body.
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        openModifier SyntaxToken?,
        structKeyword SyntaxToken,
        primaryConstructorOpenParen SyntaxToken?,
        primaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]?,
        primaryConstructorCloseParen SyntaxToken?,
        baseColonToken SyntaxToken?,
        baseTypeIdentifier SyntaxToken?,
        additionalBaseTypeIdentifiers ImmutableArray[SyntaxToken?],
        openBraceToken SyntaxToken,
        fields ImmutableArray[FieldDeclarationSyntax],
        properties ImmutableArray[PropertyDeclarationSyntax],
        events ImmutableArray[EventDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        AccessibilityModifier = accessibilityModifier
        TypeKeyword = typeKeyword
        Identifier = identifier
        DataKeyword = dataKeyword
        InlineKeyword = inlineKeyword
        OpenModifier = openModifier
        StructKeyword = structKeyword
        PrimaryConstructorOpenParenthesisToken = primaryConstructorOpenParen
        PrimaryConstructorParameters = primaryConstructorParameters
        PrimaryConstructorCloseParenthesisToken = primaryConstructorCloseParen
        BaseColonToken = baseColonToken
        BaseTypeIdentifier = baseTypeIdentifier
        AdditionalBaseTypeIdentifiers = additionalBaseTypeIdentifiers
        OpenBraceToken = openBraceToken
        Fields = fields
        Properties = properties
        Events = events
        Methods = methods
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.StructDeclaration

    /// Gets the optional accessibility modifier token.
    prop AccessibilityModifier SyntaxToken? {
        get;
    }

    /// Gets the `type` keyword.
    prop TypeKeyword SyntaxToken? {
        get;
    }

    /// Gets the struct identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the optional `data` contextual keyword. Non-null when this is a `data struct` (Phase 3.B.2).
    prop DataKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional `inline` contextual keyword. Non-null when this is an `inline struct` (ADR-0033).
    prop InlineKeyword SyntaxToken? {
        get;
    }

    /// Gets the optional `open` contextual keyword (Phase 3.B.3 sub-step 3 — classes only). Non-null marks
    /// the class as inheritable per ADR-0017.
    prop OpenModifier SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether this aggregate is declared `open` (inheritable). Always false for
    /// `struct`.
    prop IsOpen bool -> OpenModifier != nil

    /// Gets the `struct` or `class` keyword that marks this aggregate declaration. Inspect (cref:IsClass)
    /// to distinguish.
    prop StructKeyword SyntaxToken {
        get;
    }

    /// Gets the optional opening paren of a Kotlin-style primary constructor parameter list (Phase 3.B.3
    /// sub-step 2); null when none was declared.
    prop PrimaryConstructorOpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the primary constructor parameter list. Empty when no primary constructor was declared.
    prop PrimaryConstructorParameters SeparatedSyntaxList[ParameterSyntax]? {
        get;
    }

    /// Gets the optional closing paren of the primary constructor parameter list; null when none was
    /// declared.
    prop PrimaryConstructorCloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the optional `:` token introducing a base class clause (Phase 3.B.3 sub-step 3). Null when this
    /// class has no explicit base.
    prop BaseColonToken SyntaxToken? {
        get;
    }

    /// Gets the optional identifier of the base class. Non-null only when (cref:BaseColonToken) is
    /// non-null.
    prop BaseTypeIdentifier SyntaxToken? {
        get;
    }

    /// Gets the additional comma-separated identifiers in the base/interface clause (Phase 3.B.4). Empty
    /// when only the first identifier was provided.
    prop AdditionalBaseTypeIdentifiers ImmutableArray[SyntaxToken?] {
        get;
    }

    /// Gets a value indicating whether this declaration carries an explicit base/interface clause.
    prop HasBaseType bool -> BaseColonToken != nil

    /// Gets or sets the parsed base/interface type clauses in source order.
    /// Empty/default when no base clause was declared. Assigned by the parser.
    prop BaseTypeClauses SeparatedSyntaxList[TypeClauseSyntax] {
        get -> baseTypeClauses
        set {
            baseTypeClauses = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries a Kotlin-style primary constructor
    /// parameter list.
    prop HasPrimaryConstructor bool -> PrimaryConstructorOpenParenthesisToken != nil

    /// Gets a value indicating whether this struct was declared with the `data` contextual keyword.
    prop IsData bool -> DataKeyword != nil

    /// Gets a value indicating whether this struct was declared with the `inline` contextual keyword.
    prop IsInline bool -> InlineKeyword != nil

    /// Gets a value indicating whether this struct was declared with the `ref` contextual keyword (issue
    /// #367 — a by-ref-like / `ref struct` type emitted with
    /// `System.Runtime.CompilerServices.IsByRefLikeAttribute`). Always false for `class`.
    prop IsRef bool -> RefModifier != nil

    /// Gets a value indicating whether this class was declared with the `abstract` contextual keyword
    /// (ADR-0195 / issue #4674 — a class that cannot be instantiated even when it declares no abstract
    /// member).
    prop IsAbstract bool -> AbstractModifier != nil

    /// Gets a value indicating whether this class was declared with the `shared` contextual modifier
    /// (ADR-0195 / issue #4674 — a class emitted `abstract sealed` whose members are all shared and sit
    /// directly in its body).
    prop IsShared bool -> SharedModifier != nil

    /// Gets or sets the optional `unsafe` contextual modifier (ADR-0122 / issue #1014)
    /// contextual modifier on the aggregate declaration (`unsafe class` /
    /// `unsafe struct`). When non-null every member of the type is bound in
    /// an `unsafe` context, so fields, methods, and properties may use
    /// unmanaged raw pointers (`*T` → CLR `ELEMENT_TYPE_PTR`).
    /// Assigned by the parser; `null` otherwise.
    prop UnsafeModifier SyntaxToken? {
        get -> unsafeModifier
        set {
            unsafeModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this aggregate was declared `unsafe` (ADR-0122 / issue #1014).
    prop IsUnsafe bool -> UnsafeModifier != nil

    /// Gets or sets the optional `partial` contextual modifier (ADR-0144 /
    /// issue #2201) on the aggregate declaration (`partial class` /
    /// `partial struct`). When non-null this declaration is one part of a
    /// type that may be split across multiple declarations in the same package.
    /// Assigned by the parser; `null` otherwise. Rejected on `enum`
    /// (GS0484).
    prop PartialModifier SyntaxToken? {
        get -> partialModifier
        set {
            partialModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this aggregate was declared `partial` (ADR-0144 / issue #2201).
    prop IsPartial bool -> PartialModifier != nil

    /// Gets or sets the identifier locations of every part of a merged
    /// `partial` type (ADR-0144). Populated only on the synthetic node
    /// `PartialTypeMerger` produces; empty on an ordinary (un-merged)
    /// declaration. Used by the language server so go-to-definition on a partial
    /// type returns all part locations. Its element type ((cref:Text.TextLocation))
    /// is not a syntax node, so it is intentionally invisible to
    /// (cref:SyntaxNode.GetChildren) and does not affect this node's span.
    private var _partialPartLocations ImmutableArray[TextLocation] = ImmutableArray[TextLocation].Empty

    prop PartialPartLocations ImmutableArray[TextLocation] {
        get {
            return _partialPartLocations
        }
        set {
            _partialPartLocations = value
        }
    }

    /// Gets a value indicating whether this aggregate was declared with the `class` keyword (Phase 3.B.3)
    /// rather than `struct`.
    prop IsClass bool -> StructKeyword?.Kind == SyntaxKind.ClassKeyword

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the field declarations.
    prop Fields ImmutableArray[FieldDeclarationSyntax] {
        get;
    }

    /// Gets the property declarations in the body (ADR-0051). Empty for types that declare no properties.
    prop Properties ImmutableArray[PropertyDeclarationSyntax] {
        get;
    }

    /// Gets the event declarations in the body (ADR-0052). Empty for types that declare no events.
    prop Events ImmutableArray[EventDeclarationSyntax] {
        get;
    }

    /// Gets the method declarations declared inside the body (Phase 3.B.3 sub-step 2b). Both classes and
    /// structs may declare methods; empty only when the type declares none, or has no body.
    prop Methods ImmutableArray[FunctionDeclarationSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets or sets the optional type-parameter list (Phase 4.3 / ADR-0020), e.g. `[T any]` in
    /// `class Box[T any] { ... }`. Assigned by the parser when the declaration is generic; `null`
    /// otherwise.
    prop TypeParameterList TypeParameterListSyntax? {
        get -> typeParameterList
        set {
            typeParameterList = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional `ref` contextual keyword (issue #367). Non-null marks this `struct` as
    /// by-ref-like (`ref struct`). Assigned by the parser; `null` otherwise.
    prop RefModifier SyntaxToken? {
        get -> refModifier
        set {
            refModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional `abstract` contextual keyword (ADR-0195 / issue #4674). Non-null marks
    /// this `class` abstract: it is inheritable like an `open class` and cannot be instantiated. Assigned
    /// by the parser; `null` otherwise.
    prop AbstractModifier SyntaxToken? {
        get -> abstractModifier
        set {
            abstractModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional `shared` contextual modifier on a class head (ADR-0195 / issue #4674).
    /// Non-null marks this `class` shared: emitted `abstract sealed` with no instance constructor, every
    /// member declared directly in the body is a shared (static) member, and a `shared { }` block inside it
    /// is rejected. Assigned by the parser; `null` otherwise.
    prop SharedModifier SyntaxToken? {
        get -> sharedModifier
        set {
            sharedModifier = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the static-initializer blocks (`init { … }`, ADR-0140) declared directly in the body of
    /// a `shared` class. Empty for any other aggregate (there they sit in the `shared { }` block). Assigned
    /// by the parser.
    prop SharedInitializers ImmutableArray[StaticInitializerBlockSyntax] {
        get -> sharedInitializers
        set {
            sharedInitializers = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional `shared { … }` block (ADR-0053) grouping static member declarations. Null
    /// when the type has no shared block.
    prop SharedBlock SharedBlockSyntax? {
        get -> sharedBlock
        set {
            sharedBlock = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional opening paren of a base-constructor argument list (issue #306), e.g. the
    /// `(` in `: Exception(message)`. Null when the base clause supplies no constructor arguments. Assigned
    /// by the parser.
    prop BaseConstructorOpenParenthesisToken SyntaxToken? {
        get -> baseConstructorOpenParenthesisToken
        set {
            baseConstructorOpenParenthesisToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the base-constructor argument expressions (issue #306). Empty/default when no
    /// base-constructor argument list was declared.
    prop BaseConstructorArguments SeparatedSyntaxList[ExpressionSyntax]? {
        get -> baseConstructorArguments
        set {
            baseConstructorArguments = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional closing paren of the base-constructor argument list (issue #306). Null
    /// when none was declared.
    prop BaseConstructorCloseParenthesisToken SyntaxToken? {
        get -> baseConstructorCloseParenthesisToken
        set {
            baseConstructorCloseParenthesisToken = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this declaration carries an explicit base-constructor argument list
    /// (issue #306).
    prop HasBaseConstructorArguments bool -> BaseConstructorOpenParenthesisToken != nil

    /// Gets or sets the optional `sealed` contextual keyword (ADR-0078). Non-null marks a class as forming
    /// a closed hierarchy (subtypes confined to the same package). Always null for `struct`; the parser
    /// diagnoses `sealed struct` with GS0310.
    prop SealedKeyword SyntaxToken? {
        get -> sealedKeyword
        set {
            sealedKeyword = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this class was declared `sealed` (ADR-0078).
    prop IsSealed bool -> SealedKeyword != nil

    /// Gets or sets the optional standalone user-defined constructors (`init(...)`) declared in this class
    /// or plain-struct body (issues #306/#2766). Empty when the aggregate declares none. Assigned by the
    /// parser.
    prop Constructors ImmutableArray[ConstructorDeclarationSyntax] {
        get -> constructors
        set {
            constructors = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the optional user-defined `deinit` declaration (ADR-0068 / issue #698). Non-null only
    /// when the class body declares exactly one `deinit`; assigned by the parser. The parser reports GS0290
    /// on any subsequent duplicate and stores only the first.
    prop Deinitializer DeinitDeclarationSyntax? {
        get -> deinitializer
        set {
            deinitializer = value
            InvalidateCachedSpan()
        }
    }

    /// Gets or sets the nested type declarations (`class` / `struct` / `interface` / `enum`) declared
    /// inside this aggregate's body (ADR-0110 / issue #910). Empty for types that declare none. Each
    /// element is a (cref:StructDeclarationSyntax), (cref:InterfaceDeclarationSyntax), or
    /// (cref:EnumDeclarationSyntax). Assigned by the parser.
    prop NestedTypes ImmutableArray[MemberSyntax] {
        get -> nestedTypes
        set {
            nestedTypes = value
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

    /// Gets or sets a value indicating whether this declaration is the
    /// compiler-generated class behind a rich anonymous-object literal.
    internal prop IsSynthesizedRichAnonymousObject bool

    /// Gets or sets the number of lexical generic parameters predeclared on a rich-anonymous shell.
    internal prop RichAnonymousShellTypeParameterCount int32

    /// Gets the parsed declaration this node is a (cref:WithMemberLists)
    /// copy of, or `null` for a declaration straight from the
    /// parser. `///` comments are indexed by node reference, so the
    /// binder looks up a copy's type documentation through this (ADR-0192).
    internal prop DocumentationSource StructDeclarationSyntax? {
        get;
        private set;
    }

    /// ADR-0192: returns a copy of this declaration with the given method list,
    /// shared block, and nested types, and every other constructor argument and
    /// settable property carried over unchanged. `PartialMethodMerger`
    /// uses it to hand the binder a normalized declaration without mutating
    /// the parsed tree, which the language server reuses across compilations.
    /// Keep it in sync with this class's settable properties: one left out here
    /// is silently dropped for every type that declares a partial method.
    /// @param methods The method list for the copy.
    /// @param sharedBlock The shared block for the copy.
    /// @param nestedTypes The nested types for the copy.
    /// @returns The copy.
    internal func WithMemberLists(
        methods ImmutableArray[FunctionDeclarationSyntax],
        sharedBlock SharedBlockSyntax?,
        nestedTypes ImmutableArray[MemberSyntax]
    ) StructDeclarationSyntax -> CopyWith(
        Fields,
        Properties,
        Events,
        methods,
        sharedBlock,
        nestedTypes,
        SharedInitializers
    )

    /// ADR-0195 / issue #4674: returns the form of a `shared` class the binder
    /// consumes. The parsed tree keeps the members the author wrote directly in
    /// the body (so the language server, formatter and analyzers see the source
    /// as written); the binder, which has one path for a type's shared members,
    /// gets a copy whose body fields, properties, events, methods and
    /// static initializers sit in [`sharedBlock`](paramref) and whose
    /// instance member lists are empty. Never mutates this node.
    /// @param sharedBlock The block holding the class's members.
    /// @param nestedTypes The nested types for the copy.
    /// @returns The copy.
    internal func WithMembersInSharedBlock(
        sharedBlock SharedBlockSyntax,
        nestedTypes ImmutableArray[MemberSyntax]
    ) StructDeclarationSyntax -> CopyWith(
        ImmutableArray[FieldDeclarationSyntax].Empty,
        ImmutableArray[PropertyDeclarationSyntax].Empty,
        ImmutableArray[EventDeclarationSyntax].Empty,
        ImmutableArray[FunctionDeclarationSyntax].Empty,
        sharedBlock,
        nestedTypes,
        ImmutableArray[StaticInitializerBlockSyntax].Empty
    )

    private func CopyWith(
        fields ImmutableArray[FieldDeclarationSyntax],
        properties ImmutableArray[PropertyDeclarationSyntax],
        events ImmutableArray[EventDeclarationSyntax],
        methods ImmutableArray[FunctionDeclarationSyntax],
        sharedBlock SharedBlockSyntax?,
        nestedTypes ImmutableArray[MemberSyntax],
        sharedInitializers ImmutableArray[StaticInitializerBlockSyntax]
    ) StructDeclarationSyntax {
        let copy = StructDeclarationSyntax(
            SyntaxTree,
            AccessibilityModifier,
            TypeKeyword,
            Identifier,
            DataKeyword,
            InlineKeyword,
            OpenModifier,
            StructKeyword,
            PrimaryConstructorOpenParenthesisToken,
            PrimaryConstructorParameters,
            PrimaryConstructorCloseParenthesisToken,
            BaseColonToken,
            BaseTypeIdentifier,
            AdditionalBaseTypeIdentifiers,
            OpenBraceToken,
            fields,
            properties,
            events,
            methods,
            CloseBraceToken
        ){
            BaseTypeClauses = BaseTypeClauses,
            UnsafeModifier = UnsafeModifier,
            PartialModifier = PartialModifier,
            PartialPartLocations = PartialPartLocations,
            TypeParameterList = TypeParameterList,
            RefModifier = RefModifier,
            AbstractModifier = AbstractModifier,
            SharedModifier = SharedModifier,
            SharedInitializers = sharedInitializers,
            SharedBlock = sharedBlock,
            BaseConstructorOpenParenthesisToken = BaseConstructorOpenParenthesisToken,
            BaseConstructorArguments = BaseConstructorArguments,
            BaseConstructorCloseParenthesisToken = BaseConstructorCloseParenthesisToken,
            SealedKeyword = SealedKeyword,
            Constructors = Constructors,
            Deinitializer = Deinitializer,
            NestedTypes = nestedTypes,
            PartialTypeParameterLists = PartialTypeParameterLists,
            PartialPartExtents = PartialPartExtents,
            IsSynthesizedRichAnonymousObject = IsSynthesizedRichAnonymousObject,
            RichAnonymousShellTypeParameterCount = RichAnonymousShellTypeParameterCount,
            DocumentationSource = DocumentationSource ?? this
        }
        copy.WithAnnotations(Annotations)
        return copy
    }
}
