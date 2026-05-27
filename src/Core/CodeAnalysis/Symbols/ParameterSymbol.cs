// <copyright file="ParameterSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a function declaration parameter symbol in the language.
/// </summary>
public sealed class ParameterSymbol : LocalVariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSymbol"/> class.
    /// </summary>
    /// <param name="name">The parameter name.</param>
    /// <param name="type">The parameter type (already wrapped in <c>SliceTypeSymbol</c> if variadic).</param>
    /// <param name="isVariadic">Whether the parameter is variadic (Phase 4.8).</param>
    /// <param name="declaringSyntax">
    /// The originating parameter-declaration syntax (may be <see langword="null"/>
    /// for compiler-synthesised parameters — async kickoff <c>&lt;&gt;sm_this</c>,
    /// state-machine builder receivers, etc.). Consumed by the PDB emitter for
    /// arg-display in debuggers.
    /// </param>
    public ParameterSymbol(string name, TypeSymbol type, bool isVariadic = false, SyntaxNode declaringSyntax = null)
        : base(name, isReadOnly: true, type, declaringSyntax)
    {
        IsVariadic = isVariadic;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Parameter;

    /// <summary>Gets a value indicating whether this parameter is variadic (Phase 4.8).</summary>
    public bool IsVariadic { get; }
}
