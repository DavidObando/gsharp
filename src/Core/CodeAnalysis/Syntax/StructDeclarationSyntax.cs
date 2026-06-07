// <copyright file="StructDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a Go-style <c>type Name struct { ... }</c> declaration (Phase 3.B.1).
/// </summary>
public sealed class StructDeclarationSyntax : MemberSyntax
{
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
    public SeparatedSyntaxList<TypeClauseSyntax> BaseTypeClauses { get; set; }
        = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);

    /// <summary>Gets a value indicating whether this declaration carries a Kotlin-style primary constructor parameter list.</summary>
    public bool HasPrimaryConstructor => PrimaryConstructorOpenParenthesisToken != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>data</c> contextual keyword.</summary>
    public bool IsData => DataKeyword != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>inline</c> contextual keyword.</summary>
    public bool IsInline => InlineKeyword != null;

    /// <summary>Gets a value indicating whether this struct was declared with the <c>ref</c> contextual keyword (issue #367 — a by-ref-like / <c>ref struct</c> type emitted with <c>System.Runtime.CompilerServices.IsByRefLikeAttribute</c>). Always false for <c>class</c>.</summary>
    public bool IsRef => RefModifier != null;

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

    /// <summary>Gets or sets the optional type-parameter list (Phase 4.3 / ADR-0020), e.g. <c>[T any]</c> in <c>type Box[T any] class { ... }</c>. Assigned by the parser when the declaration is generic; <c>null</c> otherwise.</summary>
    public TypeParameterListSyntax TypeParameterList { get; set; }

    /// <summary>Gets or sets the optional <c>ref</c> contextual keyword (issue #367). Non-null marks this <c>struct</c> as by-ref-like (<c>ref struct</c>). Assigned by the parser; <c>null</c> otherwise.</summary>
    public SyntaxToken RefModifier { get; set; }

    /// <summary>Gets or sets the optional <c>shared { … }</c> block (ADR-0053) grouping static member declarations. Null when the type has no shared block.</summary>
    public SharedBlockSyntax SharedBlock { get; set; }

    /// <summary>Gets or sets the optional opening paren of a base-constructor argument list (issue #306), e.g. the <c>(</c> in <c>: Exception(message)</c>. Null when the base clause supplies no constructor arguments. Assigned by the parser.</summary>
    public SyntaxToken BaseConstructorOpenParenthesisToken { get; set; }

    /// <summary>Gets or sets the base-constructor argument expressions (issue #306). Empty/default when no base-constructor argument list was declared.</summary>
    public SeparatedSyntaxList<ExpressionSyntax> BaseConstructorArguments { get; set; }

    /// <summary>Gets or sets the optional closing paren of the base-constructor argument list (issue #306). Null when none was declared.</summary>
    public SyntaxToken BaseConstructorCloseParenthesisToken { get; set; }

    /// <summary>Gets a value indicating whether this declaration carries an explicit base-constructor argument list (issue #306).</summary>
    public bool HasBaseConstructorArguments => BaseConstructorOpenParenthesisToken != null;

    /// <summary>Gets or sets the standalone user-defined constructors (<c>init(...)</c>) declared in this class body (issue #306). Empty when the class declares none. Assigned by the parser.</summary>
    public System.Collections.Immutable.ImmutableArray<ConstructorDeclarationSyntax> Constructors { get; set; }
        = System.Collections.Immutable.ImmutableArray<ConstructorDeclarationSyntax>.Empty;
}
