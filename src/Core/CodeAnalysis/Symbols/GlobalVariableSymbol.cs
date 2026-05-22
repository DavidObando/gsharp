// <copyright file="GlobalVariableSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a global variable symbol in the language.
/// </summary>
public sealed class GlobalVariableSymbol : VariableSymbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="GlobalVariableSymbol"/> class.
    /// </summary>
    /// <param name="name">The variable name.</param>
    /// <param name="isReadOnly">Whether it's read-only or not.</param>
    /// <param name="type">The type of the variable.</param>
    /// <param name="accessibility">The CLR visibility level (defaults to <see cref="Accessibility.Public"/>).</param>
    public GlobalVariableSymbol(string name, bool isReadOnly, TypeSymbol type, Accessibility accessibility = Accessibility.Public)
        : base(name, isReadOnly, type)
    {
        Accessibility = accessibility;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.GlobalVariable;

    /// <summary>
    /// Gets the CLR visibility level for this global variable.
    /// </summary>
    public Accessibility Accessibility { get; }
}
