#nullable disable

// <copyright file="DeinitDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0068 / issue #698: represents a class-body destructor declared with
/// Swift-style syntax — <c>deinit { … }</c>. No name, no parameters, no
/// return type, no accessibility modifier. The emitter lowers each
/// <see cref="DeinitDeclarationSyntax"/> to a CLR <c>Finalize</c> override
/// whose body is wrapped in <c>try { … } finally { base.Finalize(); }</c>.
/// Only valid inside a <c>class</c> body.
/// </summary>
public sealed class DeinitDeclarationSyntax : MemberSyntax
{
    /// <summary>Initializes a new instance of the <see cref="DeinitDeclarationSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="deinitKeyword">The contextual <c>deinit</c> keyword that introduces the destructor.</param>
    /// <param name="body">The destructor body block.</param>
    public DeinitDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken deinitKeyword,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        DeinitKeyword = deinitKeyword;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.DeinitDeclaration;

    /// <summary>Gets the contextual <c>deinit</c> keyword.</summary>
    public SyntaxToken DeinitKeyword { get; }

    /// <summary>Gets the destructor body block.</summary>
    public BlockStatementSyntax Body { get; }

    /// <inheritdoc/>
    public override TextSpan Span => TextSpan.FromBounds(DeinitKeyword.Span.Start, Body.Span.End);
}
