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
}
