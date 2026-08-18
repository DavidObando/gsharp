// <copyright file="VarPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a total <c>var name</c> pattern. The pattern always matches and
/// binds the input at its static type; <c>var _</c> binds nothing.
/// </summary>
public sealed class VarPatternSyntax : PatternSyntax
{
    /// <summary>Initializes a new instance of the <see cref="VarPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="varKeyword">The <c>var</c> keyword.</param>
    /// <param name="designation">The binding identifier or discard.</param>
    public VarPatternSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken varKeyword,
        SyntaxToken designation)
        : base(syntaxTree)
    {
        VarKeyword = varKeyword;
        Designation = designation;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.VarPattern;

    /// <summary>Gets the <c>var</c> keyword.</summary>
    public SyntaxToken VarKeyword { get; }

    /// <summary>Gets the binding identifier or discard.</summary>
    public SyntaxToken Designation { get; }
}
