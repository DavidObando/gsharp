// <copyright file="BoundStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Statement binding.
/// </summary>
public abstract class BoundStatement : BoundNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    protected BoundStatement(SyntaxNode syntax)
        : base(syntax)
    {
    }
}
