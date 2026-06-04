// <copyright file="LocalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a local variable symbol in the language.
/// </summary>
public class LocalVariableSymbol : VariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LocalVariableSymbol"/> class.
    /// </summary>
    /// <param name="name">The local variable's name.</param>
    /// <param name="isReadOnly">Whether the local variable is read-only or not.</param>
    /// <param name="type">The local variable's type.</param>
    /// <param name="declaringSyntax">
    /// The originating declaration syntax (may be <see langword="null"/> for
    /// compiler-synthesised locals — async/iterator state-machine slots,
    /// lowering temporaries, awaiter cache slots, etc.). Used by the Portable
    /// PDB emitter to map IL local slots back to source per ADR-0027 §7.7a.
    /// </param>
    public LocalVariableSymbol(string name, bool isReadOnly, TypeSymbol type, SyntaxNode declaringSyntax = null)
        : base(name, isReadOnly, type, declaringSyntax)
    {
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.LocalVariable;

    /// <summary>
    /// Gets or sets a value indicating whether this local carries the <c>scoped</c> modifier
    /// (ADR-0058 / issue #376) or has inherited function-local escape scope from its initializer.
    /// When <see langword="true"/>, returning this variable's value from a ref-struct-returning
    /// function is rejected.
    /// </summary>
    public virtual bool IsScoped { get; set; }
}
