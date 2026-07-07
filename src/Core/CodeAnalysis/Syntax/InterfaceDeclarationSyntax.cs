// <copyright file="InterfaceDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>interface Name { ... }</c> declaration (Phase 3.B.4).
/// Per ADR-0018, interfaces in Phase 3 carry method signatures only — bodies,
/// default methods, and static members are diagnosed by the parser.
/// </summary>
public sealed class InterfaceDeclarationSyntax : MemberSyntax
{
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private SyntaxToken baseColonToken;
    private SeparatedSyntaxList<TypeClauseSyntax> baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
    private ImmutableArray<FieldDeclarationSyntax> staticFields = ImmutableArray<FieldDeclarationSyntax>.Empty;
    private SyntaxToken partialModifier;

    /// <summary>Initializes a new instance of the <see cref="InterfaceDeclarationSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The interface identifier.</param>
    /// <param name="typeParameterList">The optional type-parameter list (Phase 4.3c / ADR-0020).</param>
    /// <param name="sealedKeyword">The optional <c>sealed</c> contextual keyword (Phase 3.B.5). Non-null restricts implementors to the same package.</param>
    /// <param name="interfaceKeyword">The <c>interface</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="methods">The method signatures declared inside the interface body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public InterfaceDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken sealedKeyword,
        SyntaxToken interfaceKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, typeParameterList, sealedKeyword, interfaceKeyword, openBraceToken, ImmutableArray<PropertyDeclarationSyntax>.Empty, methods, closeBraceToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="InterfaceDeclarationSyntax"/> class with property declarations (ADR-0051).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The interface identifier.</param>
    /// <param name="typeParameterList">The optional type-parameter list (Phase 4.3c / ADR-0020).</param>
    /// <param name="sealedKeyword">The optional <c>sealed</c> contextual keyword (Phase 3.B.5).</param>
    /// <param name="interfaceKeyword">The <c>interface</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="properties">The property declarations inside the interface body (ADR-0051).</param>
    /// <param name="methods">The method signatures declared inside the interface body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public InterfaceDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken sealedKeyword,
        SyntaxToken interfaceKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<PropertyDeclarationSyntax> properties,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, typeParameterList, sealedKeyword, interfaceKeyword, openBraceToken, properties, ImmutableArray<EventDeclarationSyntax>.Empty, methods, closeBraceToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="InterfaceDeclarationSyntax"/> class with property and event declarations (ADR-0051 / ADR-0052).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The interface identifier.</param>
    /// <param name="typeParameterList">The optional type-parameter list (Phase 4.3c / ADR-0020).</param>
    /// <param name="sealedKeyword">The optional <c>sealed</c> contextual keyword (Phase 3.B.5).</param>
    /// <param name="interfaceKeyword">The <c>interface</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="properties">The property declarations inside the interface body (ADR-0051).</param>
    /// <param name="events">The event declarations inside the interface body (ADR-0052).</param>
    /// <param name="methods">The method signatures declared inside the interface body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public InterfaceDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken sealedKeyword,
        SyntaxToken interfaceKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<PropertyDeclarationSyntax> properties,
        ImmutableArray<EventDeclarationSyntax> events,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        TypeParameterList = typeParameterList;
        SealedKeyword = sealedKeyword;
        InterfaceKeyword = interfaceKeyword;
        OpenBraceToken = openBraceToken;
        Properties = properties;
        Events = events;
        Methods = methods;
        CloseBraceToken = closeBraceToken;
    }

    /// <summary>Initializes a new instance of the <see cref="InterfaceDeclarationSyntax"/> class without a type-parameter list (Phase 3 / 4.3c back-compat overload).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The interface identifier.</param>
    /// <param name="sealedKeyword">The optional <c>sealed</c> contextual keyword (Phase 3.B.5).</param>
    /// <param name="interfaceKeyword">The <c>interface</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="methods">The method signatures declared inside the interface body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public InterfaceDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken sealedKeyword,
        SyntaxToken interfaceKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, typeParameterList: null, sealedKeyword, interfaceKeyword, openBraceToken, methods, closeBraceToken)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="InterfaceDeclarationSyntax"/> class without a sealed modifier (back-compat overload).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="typeKeyword">The <c>type</c> keyword.</param>
    /// <param name="identifier">The interface identifier.</param>
    /// <param name="interfaceKeyword">The <c>interface</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace of the body.</param>
    /// <param name="methods">The method signatures declared inside the interface body.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public InterfaceDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken interfaceKeyword,
        SyntaxToken openBraceToken,
        ImmutableArray<FunctionDeclarationSyntax> methods,
        SyntaxToken closeBraceToken)
        : this(syntaxTree, accessibilityModifier, typeKeyword, identifier, sealedKeyword: null, interfaceKeyword, openBraceToken, methods, closeBraceToken)
    {
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.InterfaceDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the <c>type</c> keyword.</summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>Gets the interface identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional type-parameter list for generic interfaces (Phase 4.3c / ADR-0020).</summary>
    public TypeParameterListSyntax TypeParameterList { get; }

    /// <summary>Gets the optional <c>sealed</c> contextual keyword (Phase 3.B.5). Non-null marks this as a closed hierarchy whose implementors must live in the same package.</summary>
    public SyntaxToken SealedKeyword { get; }

    /// <summary>Gets a value indicating whether this interface was declared <c>sealed</c> (Phase 3.B.5).</summary>
    public bool IsSealed => SealedKeyword != null;

    /// <summary>Gets the <c>interface</c> keyword.</summary>
    public SyntaxToken InterfaceKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the property declarations inside the interface body (ADR-0051). Empty when no properties are declared.</summary>
    public ImmutableArray<PropertyDeclarationSyntax> Properties { get; }

    /// <summary>Gets the event declarations inside the interface body (ADR-0052). Empty when no events are declared.</summary>
    public ImmutableArray<EventDeclarationSyntax> Events { get; }

    /// <summary>Gets the method signatures (Body is always null on these, per ADR-0018).</summary>
    public ImmutableArray<FunctionDeclarationSyntax> Methods { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>
    /// Gets or sets the optional base-interface clause colon token (issue #1006).
    /// Non-null when the interface declares one or more base interfaces, e.g.
    /// <c>interface B : A</c>. Mirrors <see cref="StructDeclarationSyntax.BaseColonToken"/>.
    /// </summary>
    public SyntaxToken BaseColonToken
    {
        get => baseColonToken;
        set
        {
            baseColonToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets or sets the comma-separated base-interface type clauses (issue #1006).
    /// Empty when the interface declares no base interfaces. Each clause must
    /// resolve to an interface; the binder rejects class/struct bases.
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

    /// <summary>Gets a value indicating whether this interface declares one or more base interfaces (issue #1006).</summary>
    public bool HasBaseInterfaces => BaseColonToken != null;

    /// <summary>
    /// Gets or sets the optional <c>partial</c> contextual modifier (ADR-0144 /
    /// issue #2201) on the interface declaration (<c>partial interface</c>).
    /// When non-null this declaration is one part of an interface that may be
    /// split across multiple declarations in the same package. Assigned by the
    /// parser; <c>null</c> otherwise.
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

    /// <summary>Gets a value indicating whether this interface was declared <c>partial</c> (ADR-0144 / issue #2201).</summary>
    public bool IsPartial => PartialModifier != null;

    /// <summary>
    /// Gets or sets the identifier locations of every part of a merged
    /// <c>partial</c> interface (ADR-0144). Populated only on the synthetic node
    /// <c>PartialTypeMerger</c> produces; empty on an ordinary declaration. Drives
    /// go-to-definition returning all part locations. Its element type
    /// (<see cref="Text.TextLocation"/>) is not a syntax node, so it is invisible
    /// to <see cref="SyntaxNode.GetChildren"/> and does not affect this node's span.
    /// </summary>
    public ImmutableArray<Text.TextLocation> PartialPartLocations { get; set; } = ImmutableArray<Text.TextLocation>.Empty;

    /// <summary>
    /// Gets or sets the static field declarations (<c>var</c> / <c>let</c> /
    /// <c>const</c>) declared inside the interface <c>shared { … }</c> block
    /// (ADR-0089 / issue #1030). Empty when none. These bind to CLR static
    /// fields on the interface TypeDef. Populated post-construction by the
    /// parser (mirrors <see cref="BaseTypeClauses"/>).
    /// </summary>
    public ImmutableArray<FieldDeclarationSyntax> StaticFields
    {
        get => staticFields;
        set
        {
            staticFields = value;
            InvalidateCachedSpan();
        }
    }
}
