// <copyright file="PatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>Base type for switch case patterns.</summary>
public abstract class PatternSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="PatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    protected PatternSyntax(SyntaxTree syntaxTree)
        : base(syntaxTree)
    {
    }
}
