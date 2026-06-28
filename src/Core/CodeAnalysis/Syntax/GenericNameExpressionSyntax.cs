// <copyright file="GenericNameExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1323: a constructed-generic *type* reference used in expression
/// position, e.g. the <c>Box[int32?]</c> receiver in
/// <c>Box[int32?].Make(5)</c>. The parser emits this node (rather than an
/// <see cref="IndexExpressionSyntax"/>) when a bracketed type-argument list is
/// unambiguously a type — it carries one or more <see cref="TypeClauseSyntax"/>
/// arguments that need not be expressible as ordinary index expressions (a
/// nullable <c>T?</c>, an array/slice <c>[]T</c>, or a nested generic
/// <c>List[T]</c>) — and is followed by a member access (<c>.Member</c>). The
/// binder resolves it to the closed construction so static-member access binds
/// against the constructed type.
/// </summary>
public sealed class GenericNameExpressionSyntax : ExpressionSyntax
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GenericNameExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The generic type name.</param>
    /// <param name="typeArgumentList">The bracketed type-argument list.</param>
    public GenericNameExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken identifier,
        TypeArgumentListSyntax typeArgumentList)
        : base(syntaxTree)
    {
        Identifier = identifier;
        TypeArgumentList = typeArgumentList;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.GenericNameExpression;

    /// <summary>Gets the generic type name.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the bracketed type-argument list.</summary>
    public TypeArgumentListSyntax TypeArgumentList { get; }
}
