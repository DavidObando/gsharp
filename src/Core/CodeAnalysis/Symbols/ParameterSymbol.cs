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
    /// <param name="isScoped">
    /// Whether the parameter carries the <c>scoped</c> modifier (ADR-0058 / issue #376).
    /// When <see langword="true"/>, the parameter's safe-to-escape scope is restricted to the
    /// current function body and returning its value is rejected.
    /// </param>
    public ParameterSymbol(string name, TypeSymbol type, bool isVariadic = false, SyntaxNode declaringSyntax = null, bool isScoped = false)
        : base(name, isReadOnly: true, type, declaringSyntax)
    {
        IsVariadic = isVariadic;
        IsScoped = isScoped;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Parameter;

    /// <summary>Gets a value indicating whether this parameter is variadic (Phase 4.8).</summary>
    public bool IsVariadic { get; }

    /// <summary>
    /// Gets a value indicating whether this parameter carries the <c>scoped</c> modifier (ADR-0058 / issue #376).
    /// When <see langword="true"/>, the parameter's safe-to-escape scope is restricted to the
    /// current function body and it may not be directly returned from a ref-struct-returning function.
    /// </summary>
    public bool IsScoped { get; }
}
