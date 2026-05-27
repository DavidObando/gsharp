// <copyright file="VariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a variable symbol in the language.
/// </summary>
public abstract class VariableSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="VariableSymbol"/> class.
    /// </summary>
    /// <param name="name">The variable's name.</param>
    /// <param name="isReadOnly">Whether it's read-only or not.</param>
    /// <param name="type">The variable's type.</param>
    /// <param name="declaringSyntax">
    /// The originating declaration syntax (may be <see langword="null"/> for
    /// compiler-synthesised variables — async/iterator state-machine slots,
    /// lowering temporaries, etc.). Used by the Portable PDB emitter to map
    /// IL local slots back to source for stepping and locals display per
    /// ADR-0027 §7.7a.
    /// </param>
    public VariableSymbol(string name, bool isReadOnly, TypeSymbol type, SyntaxNode declaringSyntax = null)
        : base(name)
    {
        IsReadOnly = isReadOnly;
        Type = type;
        DeclaringSyntax = declaringSyntax;
    }

    /// <summary>
    /// Gets a value indicating whether it's read-only or not.
    /// </summary>
    public bool IsReadOnly { get; }

    /// <summary>
    /// Gets the variable's type.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Gets the originating declaration syntax for this variable, or
    /// <see langword="null"/> when the variable is compiler-synthesised and
    /// has no source-level declaration. Consumed by the Portable PDB emitter
    /// to anchor <c>LocalVariable</c> rows and (for hoisted async/iterator
    /// state-machine locals) the hoisted-local-scope <c>CustomDebugInformation</c>.
    /// </summary>
    public SyntaxNode DeclaringSyntax { get; }
}
