// <copyright file="AsyncLetVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// The binding introduced by <c>async let name = expr</c> (ADR-0174 D15). Its
/// type is the child's logical result <c>R</c>, not a task — the binding is not
/// a value, which is what keeps a spawn from outliving the <c>scope</c> that
/// owns it.
/// </summary>
/// <remarks>
/// Every read is spelled <c>await name</c>, and the compiler turns that into a
/// read of <see cref="Cell"/>. Any other mention of the name is GS0569: the
/// value may not have arrived, and D4's discipline is that suspension is
/// visible at the point it happens.
/// </remarks>
public sealed class AsyncLetVariableSymbol : LocalVariableSymbol
{
    /// <summary>Initializes a new instance of the <see cref="AsyncLetVariableSymbol"/> class.</summary>
    /// <param name="name">The binding's name.</param>
    /// <param name="type">The child's result type.</param>
    /// <param name="cell">The synthesized <c>AsyncLetCell[R]</c> local the child deposits into.</param>
    /// <param name="declaringSyntax">The identifier that declared it.</param>
    public AsyncLetVariableSymbol(string name, TypeSymbol type, VariableSymbol cell, SyntaxNode? declaringSyntax = null)
        : base(name, isReadOnly: true, type, declaringSyntax)
    {
        Cell = cell;
    }

    /// <summary>Gets the cell the child deposits its value into.</summary>
    public VariableSymbol Cell { get; }

    /// <summary>Gets or sets a value indicating whether the binding was read with <c>await</c> at least once. GS0559 warns when it never is.</summary>
    public bool WasAwaited { get; set; }
}
