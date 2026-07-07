// <copyright file="AnonymousClassExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an anonymous-class literal expression (issue #2224):
/// <c>object { let Name string = "Foo", let Age int32 = 42 }</c>. Analogous
/// to C#'s <c>new { Name = "Foo", Age = 42 }</c> anonymous object creation
/// expression — the compiler synthesizes a structural backing type per
/// distinct member-name/type shape (see <c>AnonymousTypeCache</c>). Unlike
/// C#, each member's type must be written explicitly (there is no
/// initializer-expression type inference at this syntax position).
/// </summary>
public sealed class AnonymousClassExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AnonymousClassExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="objectKeyword">The <c>object</c> keyword.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="members">The member initializers.</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public AnonymousClassExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken objectKeyword,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<AnonymousClassMemberInitializerSyntax> members,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        ObjectKeyword = objectKeyword;
        OpenBraceToken = openBraceToken;
        Members = members;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnonymousClassExpression;

    /// <summary>Gets the <c>object</c> keyword.</summary>
    public SyntaxToken ObjectKeyword { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the member initializers.</summary>
    public SeparatedSyntaxList<AnonymousClassMemberInitializerSyntax> Members { get; }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
