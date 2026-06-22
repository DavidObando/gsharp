// <copyright file="CollectionInitializerExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #479 / ADR-0117: a collection initializer applied to a generic
/// collection construction. Examples:
/// <c>List[int32]{1, 2, 3}</c>, <c>HashSet[int32](){1, 2}</c>,
/// <c>Dictionary[string, int32]{"a": 1}</c>, and
/// <c>Dictionary[K, V](comparer){ ["k"] = v }</c>.
/// <para>
/// The <see cref="Target"/> is the constructor call expression (a
/// <see cref="CallExpressionSyntax"/> carrying the type-argument list and any
/// explicit constructor arguments). For the no-parentheses spelling
/// (<c>List[int32]{…}</c>) the parser synthesizes an empty-argument
/// constructor call as the target. Each element in <see cref="Elements"/> is
/// one of the three <see cref="CollectionElementSyntax"/> shapes. The binder
/// lowers this to a <see cref="GSharp.Core.CodeAnalysis.Binding.BoundBlockExpression"/>
/// that constructs into a synthetic local, calls <c>Add(...)</c> / sets the
/// indexer for each element, and yields the local.
/// </para>
/// </summary>
public sealed class CollectionInitializerExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CollectionInitializerExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The underlying constructor call expression.</param>
    /// <param name="openBraceToken">The '{' opening the initializer list.</param>
    /// <param name="elements">The collection elements.</param>
    /// <param name="closeBraceToken">The matching '}'.</param>
    public CollectionInitializerExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax target,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<CollectionElementSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        Target = target;
        OpenBraceToken = openBraceToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.CollectionInitializerExpression;

    /// <summary>Gets the underlying constructor call expression (a <see cref="CallExpressionSyntax"/>).</summary>
    public ExpressionSyntax Target { get; }

    /// <summary>Gets the '{' opening the initializer list.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the collection elements (zero or more).</summary>
    public SeparatedSyntaxList<CollectionElementSyntax> Elements { get; }

    /// <summary>Gets the '}' closing the initializer list.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
