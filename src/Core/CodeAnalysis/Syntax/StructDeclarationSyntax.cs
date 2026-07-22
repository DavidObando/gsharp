// <copyright file="StructDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a Go-style <c>struct Name { ... }</c> declaration (Phase 3.B.1).
/// </summary>
public sealed class StructDeclarationSyntax : MemberSyntax
{
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675) so a span computed before the mutation is
    // never served afterwards.
    private SeparatedSyntaxList<TypeClauseSyntax> baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
    private SyntaxToken unsafeModifier;
    private SyntaxToken partialModifier;
    private TypeParameterListSyntax typeParameterList;
    private SyntaxToken refModifier;
    private SharedBlockSyntax sharedBlock;
    private SyntaxToken baseConstructorOpenParenthesisToken;
    private SeparatedSyntaxList<ExpressionSyntax> baseConstructorArguments;
    private SyntaxToken baseConstructorCloseParenthesisToken;
    private SyntaxToken sealedKeyword;
    private ImmutableArray<ConstructorDeclarationSyntax> constructors = ImmutableArray<ConstructorDeclarationSyntax>.Empty;
    private DeinitDeclarationSyntax deinitializer;
    private ImmutableArray<MemberSyntax> nestedTypes = ImmutableArray<MemberSyntax>.Empty;

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The struct identifier.</param>
    /// <param name="structKeyword">The <c>struct</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="fields">The field declarations.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken structKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword: null, inlineKeyword: null, structKeyword, openBraceToken, fields, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The struct identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="structKeyword">The <c>struct</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="fields">The field declarations.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken structKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, inlineKeyword, structKeyword, primaryConstructorOpenParen: null, primaryConstructorParameters: new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty), primaryConstructorCloseParen: null, openBraceToken, fields, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a Kotlin-style primary constructor (classes only).</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list (empty when no primary constructor is declared).</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, inlineKeyword, structKeyword, primaryConstructorOpenParen, primaryConstructorParameters, primaryConstructorCloseParen, openBraceToken, fields, ImmutableArray<FunctionDeclarationSyntax>.Empty, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a Kotlin-style primary constructor (classes only).</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list (empty when no primary constructor is declared).</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="methods">The method declarations in the body (classes only, Phase 3.B.3 sub-step 2b).</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, inlineKeyword, openModifier: null, structKeyword, primaryConstructorOpenParen, primaryConstructorParameters, primaryConstructorCloseParen, baseColonToken: null, baseTypeIdentifier: null, openBraceToken, fields, methods, closeBraceToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword (Phase 3.B.3 sub-step 3 — classes only).</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a Kotlin-style primary constructor (classes only).</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list (empty when no primary constructor is declared).</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="baseColonToken">The optional <c>:</c> token introducing a base class clause (Phase 3.B.3 sub-step 3).</param>
    /// <param name="baseTypeIdentifier">The optional base class identifier; non-null only when <paramref name="baseColonToken"/> is non-null.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="methods">The method declarations in the body (classes only, Phase 3.B.3 sub-step 2b).</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken baseColonToken,
        SyntaxToken baseTypeIdentifier,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, inlineKeyword, openModifier, structKeyword, primaryConstructorOpenParen, primaryConstructorParameters, primaryConstructorCloseParen, baseColonToken, baseTypeIdentifier, ImmutableArray<SyntaxToken>.Empty, openBraceToken, fields, methods, closeBraceToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class (Phase 3.B.4 — multi-identifier base/interface clause).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword (classes only).</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a primary constructor.</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list.</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="baseColonToken">The optional <c>:</c> token introducing a base/interface clause.</param>
    /// <param name="baseTypeIdentifier">The first identifier in the base/interface clause.</param>
    /// <param name="additionalBaseTypeIdentifiers">Subsequent comma-separated identifiers in the base/interface clause (Phase 3.B.4).</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="methods">The method declarations in the body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken baseColonToken,
        SyntaxToken baseTypeIdentifier,
        ImmutableArray<SyntaxToken> additionalBaseTypeIdentifiers,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, dataKeyword, inlineKeyword, openModifier, structKeyword, primaryConstructorOpenParen, primaryConstructorParameters, primaryConstructorCloseParen, baseColonToken, baseTypeIdentifier, additionalBaseTypeIdentifiers, openBraceToken, fields, ImmutableArray<PropertyDeclarationSyntax>.Empty, methods, closeBraceToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class (ADR-0051 — with property declarations).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword (classes only).</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a primary constructor.</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list.</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="baseColonToken">The optional <c>:</c> token introducing a base/interface clause.</param>
    /// <param name="baseTypeIdentifier">The first identifier in the base/interface clause.</param>
    /// <param name="additionalBaseTypeIdentifiers">Subsequent comma-separated identifiers in the base/interface clause (Phase 3.B.4).</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="properties">The property declarations in the body (ADR-0051).</param>
    /// <param name="methods">The method declarations in the body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken baseColonToken,
        SyntaxToken baseTypeIdentifier,
        ImmutableArray<SyntaxToken> additionalBaseTypeIdentifiers,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<PropertyDeclarationSyntax> properties,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(
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
            ImmutableArray<EventDeclarationSyntax>.Empty,
            methods,
            closeBraceToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="StructDeclarationSyntax"/> class (ADR-0052 — with event declarations).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The aggregate identifier.</param>
    /// <param name="dataKeyword">The optional <c>data</c> contextual keyword.</param>
    /// <param name="inlineKeyword">The optional <c>inline</c> contextual keyword.</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword (classes only).</param>
    /// <param name="structKeyword">The <c>struct</c> or <c>class</c> keyword.</param>
    /// <param name="primaryConstructorOpenParen">The optional opening paren of a primary constructor.</param>
    /// <param name="primaryConstructorParameters">The primary constructor parameter list.</param>
    /// <param name="primaryConstructorCloseParen">The optional closing paren of the primary constructor.</param>
    /// <param name="baseColonToken">The optional <c>:</c> token introducing a base/interface clause.</param>
    /// <param name="baseTypeIdentifier">The first identifier in the base/interface clause.</param>
    /// <param name="additionalBaseTypeIdentifiers">Subsequent comma-separated identifiers in the base/interface clause (Phase 3.B.4).</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="fields">The body field declarations.</param>
    /// <param name="properties">The property declarations in the body (ADR-0051).</param>
    /// <param name="events">The event declarations in the body (ADR-0052).</param>
    /// <param name="methods">The method declarations in the body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken structKeyword,
        SyntaxToken primaryConstructorOpenParen,
        SeparatedSyntaxList<ParameterSyntax> primaryConstructorParameters,
        SyntaxToken primaryConstructorCloseParen,
        SyntaxToken baseColonToken,
        SyntaxToken baseTypeIdentifier,
        ImmutableArray<SyntaxToken> additionalBaseTypeIdentifiers,
        SyntaxToken openBraceToken,
        ImmutableArray<FieldDeclarationSyntax> fields,
        ImmutableArray<PropertyDeclarationSyntax> properties,
        ImmutableArray<EventDeclarationSyntax> events,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        DataKeyword = dataKeyword;
        InlineKeyword = inlineKeyword;
        OpenModifier = openModifier;
        StructKeyword = structKeyword;
        PrimaryConstructorOpenParenthesisToken = primaryConstructorOpenParen;
        PrimaryConstructorParameters = primaryConstructorParameters;
        PrimaryConstructorCloseParenthesisToken = primaryConstructorCloseParen;
        BaseColonToken = baseColonToken;
        BaseTypeIdentifier = baseTypeIdentifier;
        AdditionalBaseTypeIdentifiers = additionalBaseTypeIdentifiers;
        OpenBraceToken = openBraceToken;
        Fields = fields;
        Properties = properties;
        Events = events;
        Methods = methods;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StructDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the <c>type</c> keyword.</summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>Gets the struct identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional <c>data</c> contextual keyword. Non-null when this is a <c>data struct</c> (Phase 3.B.2).</summary>
    public SyntaxToken DataKeyword { get; }

    /// <summary>Gets the optional <c>inline</c> contextual keyword. Non-null when this is an <c>inline struct</c> (ADR-0033).</summary>
    public SyntaxToken InlineKeyword { get; }

    /// <summary>Gets the optional <c>open</c> contextual keyword (Phase 3.B.3 sub-step 3 — classes only). Non-null marks the class as inheritable per ADR-0017.</summary>
    public SyntaxToken OpenModifier { get; }

    /// <summary>Gets a value indicating whether this aggregate is declared <c>open</c> (inheritable). Always false for <c>struct</c>.</summary>
    public bool IsOpen => OpenModifier != null;

    /// <summary>Gets the <c>struct</c> or <c>class</c> keyword that marks this aggregate declaration. Inspect <see cref="IsClass"/> to distinguish.</summary>
    public SyntaxToken StructKeyword { get; }

    /// <summary>Gets the optional opening paren of a Kotlin-style primary constructor parameter list (Phase 3.B.3 sub-step 2); null when none was declared.</summary>
    public SyntaxToken PrimaryConstructorOpenParenthesisToken { get; }

    /// <summary>Gets the primary constructor parameter list. Empty when no primary constructor was declared.</summary>
    public SeparatedSyntaxList<ParameterSyntax> PrimaryConstructorParameters { get; }

    /// <summary>Gets the optional closing paren of the primary constructor parameter list; null when none was declared.</summary>
    public SyntaxToken PrimaryConstructorCloseParenthesisToken { get; }

    /// <summary>Gets the optional <c>:</c> token introducing a base class clause (Phase 3.B.3 sub-step 3). Null when this class has no explicit base.</summary>
    public SyntaxToken BaseColonToken { get; }

    /// <summary>Gets the optional identifier of the base class. Non-null only when <see cref="BaseColonToken"/> is non-null.</summary>
    public SyntaxToken BaseTypeIdentifier { get; }

    /// <summary>Gets the additional comma-separated identifiers in the base/interface clause (Phase 3.B.4). Empty when only the first identifier was provided.</summary>
    public ImmutableArray<SyntaxToken> AdditionalBaseTypeIdentifiers { get; }

    /// <summary>
    /// Gets a value indicating whether this declaration carries an explicit base/interface clause.
    /// </summary>
    public bool HasBaseType => BaseColonToken != null;

    /// <summary>
    /// Gets or sets the parsed base/interface type clauses in source order.
    /// Empty/default when no base clause was declared. Assigned by the parser.
    /// </summary>
    public SeparatedSyntaxList<TypeClauseSyntax> BaseTypeClauses
    {
        get => baseTypeClauses;
        set
        {
            baseTypeClauses = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this declaration carries a Kotlin-style primary constructor parameter list.</summary>
    public bool HasPrimaryConstructor => PrimaryConstructorOpenParenthesisToken != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>data</c> contextual keyword.</summary>
    public bool IsData => DataKeyword != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>inline</c> contextual keyword.</summary>
    public bool IsInline => InlineKeyword != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>ref</c> contextual keyword (issue #367 — a by-ref-like / <c>ref struct</c> type emitted with <c>System.Runtime.CompilerServices.IsByRefLikeAttribute</c>). Always false for <c>class</c>.</summary>
    public bool IsRef => RefModifier != null;

    /// <summary>
    /// Gets or sets the optional <c>unsafe</c> contextual modifier (ADR-0122 / issue #1014)
    /// contextual modifier on the aggregate declaration (<c>unsafe class</c> /
    /// <c>unsafe struct</c>). When non-null every member of the type is bound in
    /// an <c>unsafe</c> context, so fields, methods, and properties may use
    /// unmanaged raw pointers (<c>*T</c> → CLR <c>ELEMENT_TYPE_PTR</c>).
    /// Assigned by the parser; <c>null</c> otherwise.
    /// </summary>
    public SyntaxToken UnsafeModifier
    {
        get => unsafeModifier;
        set
        {
            unsafeModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this aggregate was declared <c>unsafe</c> (ADR-0122 / issue #1014).</summary>
    public bool IsUnsafe => UnsafeModifier != null;

    /// <summary>
    /// Gets or sets the optional <c>partial</c> contextual modifier (ADR-0144 /
    /// issue #2201) on the aggregate declaration (<c>partial class</c> /
    /// <c>partial struct</c>). When non-null this declaration is one part of a
    /// type that may be split across multiple declarations in the same package.
    /// Assigned by the parser; <c>null</c> otherwise. Rejected on <c>enum</c>
    /// (GS0484).
    /// </summary>
    public SyntaxToken PartialModifier
    {
        get => partialModifier;
        set
        {
            partialModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this aggregate was declared <c>partial</c> (ADR-0144 / issue #2201).</summary>
    public bool IsPartial => PartialModifier != null;

    /// <summary>
    /// Gets or sets the identifier locations of every part of a merged
    /// <c>partial</c> type (ADR-0144). Populated only on the synthetic node
    /// <c>PartialTypeMerger</c> produces; empty on an ordinary (un-merged)
    /// declaration. Used by the language server so go-to-definition on a partial
    /// type returns all part locations. Its element type (<see cref="Text.TextLocation"/>)
    /// is not a syntax node, so it is intentionally invisible to
    /// <see cref="SyntaxNode.GetChildren"/> and does not affect this node's span.
    /// </summary>
    public ImmutableArray<Text.TextLocation> PartialPartLocations { get; set; } = ImmutableArray<Text.TextLocation>.Empty;

    /// <summary>Gets a value indicating whether this aggregate was declared with the <c>class</c> keyword (Phase 3.B.3) rather than <c>struct</c>.</summary>
    public bool IsClass => StructKeyword?.Kind == SyntaxKind.ClassKeyword;

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the field declarations.</summary>
    public ImmutableArray<FieldDeclarationSyntax> Fields { get; }

    /// <summary>Gets the property declarations in the body (ADR-0051). Empty for types that declare no properties.</summary>
    public ImmutableArray<PropertyDeclarationSyntax> Properties { get; }

    /// <summary>Gets the event declarations in the body (ADR-0052). Empty for types that declare no events.</summary>
    public ImmutableArray<EventDeclarationSyntax> Events { get; }

    /// <summary>Gets the method declarations declared inside the body (Phase 3.B.3 sub-step 2b — classes only). Empty for struct types and for bodyless declarations.</summary>
    public ImmutableArray<FunctionDeclarationSyntax> Methods { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets or sets the optional type-parameter list (Phase 4.3 / ADR-0020), e.g. <c>[T any]</c> in <c>class Box[T any] { ... }</c>. Assigned by the parser when the declaration is generic; <c>null</c> otherwise.</summary>
    public TypeParameterListSyntax TypeParameterList
    {
        get => typeParameterList;
        set
        {
            typeParameterList = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional <c>ref</c> contextual keyword (issue #367). Non-null marks this <c>struct</c> as by-ref-like (<c>ref struct</c>). Assigned by the parser; <c>null</c> otherwise.</summary>
    public SyntaxToken RefModifier
    {
        get => refModifier;
        set
        {
            refModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional <c>shared { … }</c> block (ADR-0053) grouping static member declarations. Null when the type has no shared block.</summary>
    public SharedBlockSyntax SharedBlock
    {
        get => sharedBlock;
        set
        {
            sharedBlock = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional opening paren of a base-constructor argument list (issue #306), e.g. the <c>(</c> in <c>: Exception(message)</c>. Null when the base clause supplies no constructor arguments. Assigned by the parser.</summary>
    public SyntaxToken BaseConstructorOpenParenthesisToken
    {
        get => baseConstructorOpenParenthesisToken;
        set
        {
            baseConstructorOpenParenthesisToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the base-constructor argument expressions (issue #306). Empty/default when no base-constructor argument list was declared.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> BaseConstructorArguments
    {
        get => baseConstructorArguments;
        set
        {
            baseConstructorArguments = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional closing paren of the base-constructor argument list (issue #306). Null when none was declared.</summary>
    public SyntaxToken BaseConstructorCloseParenthesisToken
    {
        get => baseConstructorCloseParenthesisToken;
        set
        {
            baseConstructorCloseParenthesisToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this declaration carries an explicit base-constructor argument list (issue #306).</summary>
    public bool HasBaseConstructorArguments => BaseConstructorOpenParenthesisToken != null;

    /// <summary>Gets or sets the optional <c>sealed</c> contextual keyword (ADR-0078). Non-null marks a class as forming a closed hierarchy (subtypes confined to the same package). Always null for <c>struct</c>; the parser diagnoses <c>sealed struct</c> with GS0310.</summary>
    public SyntaxToken SealedKeyword
    {
        get => sealedKeyword;
        set
        {
            sealedKeyword = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this class was declared <c>sealed</c> (ADR-0078).</summary>
    public bool IsSealed => SealedKeyword != null;

    /// <summary>Gets or sets the optional standalone user-defined constructors (<c>init(...)</c>) declared in this class or plain-struct body (issues #306/#2766). Empty when the aggregate declares none. Assigned by the parser.</summary>
    public System.Collections.Immutable.ImmutableArray<ConstructorDeclarationSyntax> Constructors
    {
        get => constructors;
        set
        {
            constructors = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional user-defined <c>deinit</c> declaration (ADR-0068 / issue #698). Non-null only when the class body declares exactly one <c>deinit</c>; assigned by the parser. The parser reports GS0290 on any subsequent duplicate and stores only the first.</summary>
    public DeinitDeclarationSyntax Deinitializer
    {
        get => deinitializer;
        set
        {
            deinitializer = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the nested type declarations (<c>class</c> / <c>struct</c> / <c>interface</c> / <c>enum</c>) declared inside this aggregate's body (ADR-0110 / issue #910). Empty for types that declare none. Each element is a <see cref="StructDeclarationSyntax"/>, <see cref="InterfaceDeclarationSyntax"/>, or <see cref="EnumDeclarationSyntax"/>. Assigned by the parser.</summary>
    public ImmutableArray<MemberSyntax> NestedTypes
    {
        get => nestedTypes;
        set
        {
            nestedTypes = value;
            InvalidateCachedSpan();
        }
    }
}
