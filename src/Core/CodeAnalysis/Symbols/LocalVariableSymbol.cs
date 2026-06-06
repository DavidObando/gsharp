// <copyright file="LocalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
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

    /// <summary>
    /// Gets or sets the ADR-0060 follow-up (issue #491) by-reference aliasing kind of this local.
    /// Defaults to <see cref="Binding.RefKind.None"/>. For a <c>let ref x = lvalue</c> / <c>var ref x = lvalue</c>
    /// declaration this is <see cref="Binding.RefKind.Ref"/>: the local's IL slot stores a managed pointer
    /// (<c>T&amp;</c>) to the aliased storage while the symbol's <see cref="VariableSymbol.Type"/> remains the
    /// pointee type <c>T</c>. Reads/writes are implicitly indirected by the emitter and interpreter.
    /// </summary>
    public virtual RefKind RefKind { get; set; }
}
