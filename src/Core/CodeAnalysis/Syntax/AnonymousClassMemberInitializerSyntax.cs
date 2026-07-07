// <copyright file="AnonymousClassMemberInitializerSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single <c>Name = value</c> element inside an anonymous-class
/// literal (issue #2224), e.g. the <c>Name = "Foo"</c> in
/// <c>interface { Name = "Foo" }</c>.
/// </summary>
public sealed class AnonymousClassMemberInitializerSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AnonymousClassMemberInitializerSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The member name.</param>
    /// <param name="equalsToken">The member/value separator.</param>
    /// <param name="value">The value expression.</param>
    public AnonymousClassMemberInitializerSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken identifier,
        SyntaxToken equalsToken,
        ExpressionSyntax value)
        : base(syntaxTree)
    {
        Identifier = identifier;
        EqualsToken = equalsToken;
        Value = value;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.AnonymousClassMemberInitializer;

    /// <summary>Gets the member identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the member/value separator token.</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the value expression.</summary>
    public ExpressionSyntax Value { get; }
}
