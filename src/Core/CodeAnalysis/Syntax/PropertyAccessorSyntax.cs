#nullable disable

// <copyright file="PropertyAccessorSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a single <c>get</c>, <c>set</c>, or <c>init</c> accessor inside a property body (ADR-0051, issue #946).
/// </summary>
public sealed class PropertyAccessorSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PropertyAccessorSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessorKeyword">The <c>get</c> or <c>set</c> identifier token.</param>
    /// <param name="openParenToken">The optional open parenthesis (for <c>set(value)</c>).</param>
    /// <param name="parameterIdentifier">The optional parameter identifier (for <c>set(value)</c>).</param>
    /// <param name="closeParenToken">The optional close parenthesis (for <c>set(value)</c>).</param>
    /// <param name="body">The optional block body.</param>
    /// <param name="semicolonToken">The optional semicolon (for shorthand <c>get;</c> / <c>set;</c>).</param>
    public PropertyAccessorSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessorKeyword,
        SyntaxToken openParenToken,
        SyntaxToken parameterIdentifier,
        SyntaxToken closeParenToken,
        BlockStatementSyntax body,
        SyntaxToken semicolonToken)
        : base(syntaxTree)
    {
        AccessorKeyword = accessorKeyword;
        OpenParenToken = openParenToken;
        ParameterIdentifier = parameterIdentifier;
        CloseParenToken = closeParenToken;
        Body = body;
        SemicolonToken = semicolonToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.PropertyAccessor;

    /// <summary>Gets the <c>get</c> or <c>set</c> identifier token.</summary>
    public SyntaxToken AccessorKeyword { get; }

    /// <summary>Gets the optional open parenthesis token (only for <c>set(value)</c>).</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the optional parameter identifier (only for <c>set(value)</c>).</summary>
    public SyntaxToken ParameterIdentifier { get; }

    /// <summary>Gets the optional close parenthesis token (only for <c>set(value)</c>).</summary>
    public SyntaxToken CloseParenToken { get; }

    /// <summary>Gets the optional block body. Null for bare <c>get;</c> or bodyless accessors.</summary>
    public BlockStatementSyntax Body { get; }

    /// <summary>Gets the optional semicolon token (present for <c>get;</c> / <c>set;</c> shorthand).</summary>
    public SyntaxToken SemicolonToken { get; }

    /// <summary>Gets a value indicating whether this accessor is a getter.</summary>
    public bool IsGetter => AccessorKeyword?.Text == "get";

    /// <summary>Gets a value indicating whether this accessor is a setter.</summary>
    public bool IsSetter => AccessorKeyword?.Text == "set";

    /// <summary>
    /// Gets a value indicating whether this accessor is an <c>init</c>-only
    /// setter (issue #946). An <c>init</c> accessor is emitted as a
    /// <c>set_Prop</c> method whose void return carries the
    /// <c>IsExternalInit</c> modreq; assignment is restricted to object
    /// initialization (constructors, object initializers, and other
    /// <c>init</c> accessors).
    /// </summary>
    public bool IsInit => AccessorKeyword?.Text == "init";

    /// <summary>Gets a value indicating whether this accessor writes the property (a <c>set</c> or an <c>init</c> accessor).</summary>
    public bool IsSetterOrInit => IsSetter || IsInit;
}
