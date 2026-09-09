// <copyright file="ConstructorDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #306: represents a standalone user-defined constructor declared inside a
/// <c>class</c> body via the <c>init(params) [: base(args)] { ... }</c> form. Unlike
/// the Kotlin-style primary constructor (which only declares same-named fields and
/// implicitly chains to a parameterless base ctor), an <c>init</c> constructor has an
/// explicit body of statements and may chain to a specific base constructor.
/// </summary>
public sealed class ConstructorDeclarationSyntax : MemberSyntax
{
    /// <summary>Initializes a new instance of the <see cref="ConstructorDeclarationSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier (<c>public</c>/<c>internal</c>/<c>private</c>).</param>
    /// <param name="convenienceModifier">The optional ADR-0065 §2 <c>convenience</c> modifier, or <c>null</c>.</param>
    /// <param name="initKeyword">The contextual <c>init</c> keyword that introduces the constructor.</param>
    /// <param name="openParenthesisToken">The opening paren of the parameter list.</param>
    /// <param name="parameters">The constructor parameters.</param>
    /// <param name="closeParenthesisToken">The closing paren of the parameter list.</param>
    /// <param name="baseColonToken">The optional <c>:</c> introducing a base initializer, or <c>null</c>.</param>
    /// <param name="baseKeyword">The optional contextual <c>base</c> keyword, or <c>null</c>.</param>
    /// <param name="baseOpenParenthesisToken">The optional opening paren of the base argument list, or <c>null</c>.</param>
    /// <param name="baseArguments">The base-constructor argument expressions (empty when no base initializer).</param>
    /// <param name="baseCloseParenthesisToken">The optional closing paren of the base argument list, or <c>null</c>.</param>
    /// <param name="body">The constructor body block.</param>
    public ConstructorDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken? accessibilityModifier,
        SyntaxToken? convenienceModifier,
        SyntaxToken initKeyword,
        SyntaxToken openParenthesisToken,
        SeparatedSyntaxList<ParameterSyntax> parameters,
        SyntaxToken closeParenthesisToken,
        SyntaxToken? baseColonToken,
        SyntaxToken? baseKeyword,
        SyntaxToken? baseOpenParenthesisToken,
        SeparatedSyntaxList<ExpressionSyntax> baseArguments,
        SyntaxToken? baseCloseParenthesisToken,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        AccessibilityModifier = accessibilityModifier;
        ConvenienceModifier = convenienceModifier;
        InitKeyword = initKeyword;
        OpenParenthesisToken = openParenthesisToken;
        Parameters = parameters;
        CloseParenthesisToken = closeParenthesisToken;
        BaseColonToken = baseColonToken;
        BaseKeyword = baseKeyword;
        BaseOpenParenthesisToken = baseOpenParenthesisToken;
        BaseArguments = baseArguments;
        BaseCloseParenthesisToken = baseCloseParenthesisToken;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ConstructorDeclaration;

    /// <summary>Gets the optional accessibility modifier.</summary>
    public SyntaxToken? AccessibilityModifier { get; }

    /// <summary>Gets the optional ADR-0065 §2 <c>convenience</c> modifier, or <c>null</c>.</summary>
    public SyntaxToken? ConvenienceModifier { get; }

    /// <summary>Gets a value indicating whether this constructor is declared with the <c>convenience</c> modifier (ADR-0065 §2).</summary>
    public bool IsConvenience => ConvenienceModifier != null;

    /// <summary>Gets the contextual <c>init</c> keyword.</summary>
    public SyntaxToken InitKeyword { get; }

    /// <summary>Gets the opening paren of the parameter list.</summary>
    public SyntaxToken OpenParenthesisToken { get; }

    /// <summary>Gets the constructor parameters.</summary>
    public SeparatedSyntaxList<ParameterSyntax> Parameters { get; }

    /// <summary>Gets the closing paren of the parameter list.</summary>
    public SyntaxToken CloseParenthesisToken { get; }

    /// <summary>Gets the optional <c>:</c> introducing the base initializer.</summary>
    public SyntaxToken? BaseColonToken { get; }

    /// <summary>Gets the optional contextual <c>base</c> keyword.</summary>
    public SyntaxToken? BaseKeyword { get; }

    /// <summary>Gets the optional opening paren of the base argument list.</summary>
    public SyntaxToken? BaseOpenParenthesisToken { get; }

    /// <summary>Gets the base-constructor argument expressions (empty when no base initializer).</summary>
    public SeparatedSyntaxList<ExpressionSyntax> BaseArguments { get; }

    /// <summary>Gets the optional closing paren of the base argument list.</summary>
    public SyntaxToken? BaseCloseParenthesisToken { get; }

    /// <summary>Gets the constructor body block.</summary>
    public BlockStatementSyntax Body { get; }

    /// <summary>Gets a value indicating whether this constructor declares an explicit <c>: base(args)</c> initializer.</summary>
    public bool HasBaseInitializer => BaseKeyword != null;

    /// <inheritdoc/>
    /// <remarks>
    /// The span starts at the ACCESSIBILITY MODIFIER when there is one. It used to
    /// start at <c>convenience</c>/<c>init</c>, which left `private` outside the
    /// declaration it introduces -- and a declaration whose span excludes its own
    /// modifiers is not merely imprecise, it is wrong in two places that both read
    /// `Span.Start` as "where this declaration begins":
    /// <see cref="DocumentationAttacher"/> requires a documented declaration to start
    /// on the line after the `///` block, and the ADR-0179 formatter puts its
    /// member break before that same position. Together those produced
    /// `private` on its own line, a blank line, then `init` -- and GS0227
    /// "documentation comment is not attached to a declaration" on the migrated tree.
    /// </remarks>
    public override TextSpan Span =>
        TextSpan.FromBounds(
            (AccessibilityModifier ?? ConvenienceModifier ?? InitKeyword).Span.Start,
            Body.Span.End);
}
