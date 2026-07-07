// <copyright file="AnonymousClassExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an anonymous-class literal expression (issue #2224):
/// <c>interface { Name = "Foo", Age = 42 }</c>. Analogous to C#'s
/// <c>new { Name = "Foo", Age = 42 }</c> anonymous object creation
/// expression — the compiler synthesizes a structural backing type per
/// distinct member-name/type shape (see <c>AnonymousTypeCache</c>).
/// </summary>
public sealed class AnonymousClassExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AnonymousClassExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="interfaceKeyword">The <c>interface</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="members">The member initializers.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public AnonymousClassExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken interfaceKeyword,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<AnonymousClassMemberInitializerSyntax> members,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        InterfaceKeyword = interfaceKeyword;
        OpenBraceToken = openBraceToken;
        Members = members;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnonymousClassExpression;

    /// <summary>Gets the <c>interface</c> keyword.</summary>
    public SyntaxToken InterfaceKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the member initializers.</summary>
    public SeparatedSyntaxList<AnonymousClassMemberInitializerSyntax> Members { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
