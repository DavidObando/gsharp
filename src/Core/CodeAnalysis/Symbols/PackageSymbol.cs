// <copyright file="PackageSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a package symbol in the language.
/// </summary>
public sealed class PackageSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PackageSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the package.</param>
    /// <param name="declaration">The declaration.</param>
    public PackageSymbol(string name, PackageSyntax declaration)
        : base(name)
    {
        Declaration = declaration;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Package;

    /// <summary>
    /// Gets the declaration of the package.
    /// </summary>
    public PackageSyntax Declaration { get; }
}
