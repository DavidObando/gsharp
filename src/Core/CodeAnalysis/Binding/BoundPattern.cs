// <copyright file="BoundPattern.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Base class for bound switch patterns.</summary>
public abstract class BoundPattern : BoundNode
{
    /// <summary>Initializes a new instance of the <see cref="BoundPattern"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="type">The discriminant type.</param>
    protected BoundPattern(SyntaxNode syntax, TypeSymbol type)
        : base(syntax)
    {
        Type = type;
    }

    /// <summary>Gets the discriminant type the pattern was bound against.</summary>
    public TypeSymbol Type { get; }
}
