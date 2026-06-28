#nullable disable

// <copyright file="ObjectCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #522: a constructor invocation with a trailing C#-style object
/// initializer, e.g. <c>WithInit(args) { Asin = "X", Title = "T" }</c> or
/// <c>List[int](){ Capacity = 16 }</c>. The <see cref="Target"/> is the
/// already-parsed call expression (positional + named ctor args); each
/// element in <see cref="Initializers"/> assigns a property/field on the
/// constructed instance. The binder lowers this to a
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundBlockExpression"/> that
/// constructs into a synthetic local, performs the assignments, and yields
/// the local — so init-only setters are legal here even though they would be
/// disallowed at a free-standing assignment site.
/// </summary>
public sealed class ObjectCreationExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ObjectCreationExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="target">The underlying constructor call expression.</param>
    /// <param name="openBraceToken">The '{' opening the initializer list.</param>
    /// <param name="initializers">The property initializers.</param>
    /// <param name="closeBraceToken">The matching '}'.</param>
    public ObjectCreationExpressionSyntax(
        SyntaxTree syntaxTree,
        ExpressionSyntax target,
        SyntaxToken openBraceToken,
        SeparatedSyntaxList<PropertyInitializerSyntax> initializers,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        Target = target;
        OpenBraceToken = openBraceToken;
        Initializers = initializers;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.ObjectCreationExpression;

    /// <summary>Gets the underlying constructor call expression (a <see cref="CallExpressionSyntax"/>).</summary>
    public ExpressionSyntax Target { get; }

    /// <summary>Gets the '{' opening the initializer list.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the property initializers (zero or more).</summary>
    public SeparatedSyntaxList<PropertyInitializerSyntax> Initializers { get; }

    /// <summary>Gets the '}' closing the initializer list.</summary>
    public SyntaxToken CloseBraceToken { get; }
}
