// <copyright file="BoundDiscardPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Bound discard pattern.</summary>
public sealed class BoundDiscardPattern : BoundPattern
{
    /// <summary>Initializes a new instance of the <see cref="BoundDiscardPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    public BoundDiscardPattern(SyntaxNode? syntax, TypeSymbol type)
        : this(syntax, type, variable: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundDiscardPattern"/> class with an optional static-type binding.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    /// <param name="variable">The variable introduced by <c>var name</c>, or <see langword="null"/> for a discard.</param>
    public BoundDiscardPattern(SyntaxNode? syntax, TypeSymbol type, LocalVariableSymbol? variable)
        : base(syntax, type)
    {
        Variable = variable;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.DiscardPattern;

    /// <summary>Gets the variable introduced by a total <c>var name</c> pattern.</summary>
    public LocalVariableSymbol? Variable { get; }
}
