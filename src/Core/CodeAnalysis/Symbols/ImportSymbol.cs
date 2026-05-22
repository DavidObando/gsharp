// <copyright file="ImportSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an import symbol in the language.
/// </summary>
public sealed class ImportSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImportSymbol"/> class.
    /// </summary>
    /// <param name="name">The local name used to reference this import (the alias when one is declared, otherwise the import path).</param>
    /// <param name="target">The fully-qualified target path used for type resolution (e.g. <c>System</c> or <c>System.IO</c>).</param>
    /// <param name="declaration">The declaration.</param>
    public ImportSymbol(string name, string target, ImportSyntax declaration)
        : base(name)
    {
        Target = target;
        Declaration = declaration;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Import;

    /// <summary>
    /// Gets the fully-qualified target path used to resolve types under this import.
    /// </summary>
    public string Target { get; }

    /// <summary>
    /// Gets a value indicating whether this import was declared with an explicit alias (e.g. <c>import sys = System</c>).
    /// </summary>
    public bool IsAlias => !string.Equals(Name, Target, System.StringComparison.Ordinal);

    /// <summary>
    /// Gets the declaration of the import.
    /// </summary>
    public ImportSyntax Declaration { get; }
}
