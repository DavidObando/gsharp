// <copyright file="PackageSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax

/// Represents a package symbol in the language.
class PackageSymbol : Symbol {
    /// Initializes a new instance of the (cref:PackageSymbol) class.
    /// @param name The name of the package.
    /// @param declaration The declaration, or `null` for synthesized package symbols.
    init(name string, declaration PackageSyntax?) : base(name) {
        Declaration = declaration
        IsExplicitlyDeclared = declaration != nil
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.Package

    /// Gets the declaration of the package, or `null` for synthesized package symbols.
    prop Declaration PackageSyntax? {
        get;
    }

    /// Gets a value indicating whether any syntax tree explicitly declared this
    /// package name.
    internal prop IsExplicitlyDeclared bool {
        get;
        private set;
    }

    /// Records that a later syntax tree explicitly declared this package.
    internal func MarkExplicitlyDeclared() -> IsExplicitlyDeclared = true
}
