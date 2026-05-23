// <copyright file="InterfaceDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a <c>type Name interface { ... }</c> declaration (Phase 3.B.4).
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
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        TypeKeyword = typeKeyword;
        Identifier = identifier;
        InterfaceKeyword = interfaceKeyword;
        OpenBraceToken = openBraceToken;
        Methods = methods;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.InterfaceDeclaration;

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the <c>type</c> keyword.</summary>
    public SyntaxToken TypeKeyword { get; }

    /// <summary>Gets the interface identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the <c>interface</c> keyword.</summary>
    public SyntaxToken InterfaceKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the method signatures (Body is always null on these, per ADR-0018).</summary>
    public ImmutableArray<FunctionDeclarationSyntax> Methods { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
