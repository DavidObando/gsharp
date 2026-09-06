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
    /// <param name="declaration">The declaration, or <see langword="null"/> for synthesized package symbols.</param>
    public PackageSymbol(string name, PackageSyntax? declaration)
        : base(name)
    {
        Declaration = declaration;
        IsExplicitlyDeclared = declaration != null;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Package;

    /// <summary>
    /// Gets the declaration of the package, or <see langword="null"/> for synthesized package symbols.
    /// </summary>
    public PackageSyntax? Declaration { get; }

    /// <summary>
    /// Gets a value indicating whether any syntax tree explicitly declared this
    /// package name.
    /// </summary>
    internal bool IsExplicitlyDeclared { get; private set; }

    /// <summary>
    /// Records that a later syntax tree explicitly declared this package.
    /// </summary>
    internal void MarkExplicitlyDeclared() => IsExplicitlyDeclared = true;
}
