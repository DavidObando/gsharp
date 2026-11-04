// <copyright file="ImportSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable

/// Represents a `type Name = Target` alias symbol in the language (#5333).
class TypeAliasSymbol : Symbol {
    /// Initializes a new instance of the (cref:TypeAliasSymbol) class.
    /// @param name The alias name.
    /// @param target The aliased type symbol.
    /// @param declaration The declaring syntax node, or `null` for synthesized aliases.
    init(name string, target TypeSymbol, declaration TypeAliasDeclarationSyntax? = nil) : base(name) {
        Target = target
        Declaration = declaration
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.TypeAlias

    /// Gets the aliased type symbol.
    prop Target TypeSymbol {
        get;
    }

    /// Gets the declaration of the type alias, or `null` for synthesized aliases.
    prop Declaration TypeAliasDeclarationSyntax? {
        get;
        private set;
    }

    /// Gets or sets the declaring package name.
    internal var PackageName string = string.Empty

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ContainingNamespace string? -> if string.IsNullOrEmpty(PackageName) {
        default(string?)
    } else {
        PackageName
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if Declaration is {} declaration &&
        !declaration
        .Identifier
        .IsMissing {
        ImmutableArray.Create[SyntaxNode](declaration.Identifier)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Re-points this reused type alias at the matching declaration in the edited tree.
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration TypeAliasDeclarationSyntax) {
        Declaration = declaration
    }
}

/// Represents an import symbol in the language.
class ImportSymbol : Symbol {
    /// Initializes a new instance of the (cref:ImportSymbol) class.
    /// @param name The local name used to reference this import (the alias when one is declared, otherwise
    /// the import path).
    /// @param target The fully-qualified target path used for type resolution (e.g. `System` or
    /// `System.IO`).
    /// @param declaration The declaration, or `null` for compiler-synthesized imports (e.g. the implicit
    /// `System` import).
    convenience init(name string, target string, declaration ImportSyntax?) {
        init(name, target, declaration, false)
    }

    /// Initializes a new instance of the (cref:ImportSymbol) class.
    /// @param name The import's name.
    /// @param target The fully-qualified target path.
    /// @param declaration The declaring syntax, or `null` for an implicit import.
    /// @param hoistsStatics See (cref:HoistsStatics).
    init(name string, target string, declaration ImportSyntax?, hoistsStatics bool) : base(name) {
        Target = target
        Declaration = declaration
        HoistsStatics = hoistsStatics
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.Import

    /// Gets a value indicating whether this import brings the target package's
    /// top-level functions into bare-name scope, the way an explicit package
    /// import does (ADR-0134). Implicit imports normally do not — an implicitly
    /// imported namespace should not silently add callable names — but
    /// `Gsharp.Concurrency` does, because ADR-0174 D9's helpers
    /// (`after`, `tick`, `merge`) are meant to read as ordinary
    /// functions and a program that wants the name declares its own, which
    /// wins.
    prop HoistsStatics bool {
        get;
    }

    /// Gets the fully-qualified target path used to resolve types under this import.
    prop Target string {
        get;
    }

    /// Gets a value indicating whether this import was declared with an explicit alias (e.g.
    /// `import sys = System`).
    prop IsAlias bool -> !string.Equals(Name, Target, StringComparison.Ordinal)

    /// Gets a value indicating whether this import was synthesized by the compiler rather than written by
    /// the user.
    prop IsImplicit bool -> Declaration == nil

    /// Gets the declaration of the import, or `null` for compiler-synthesized imports.
    prop Declaration ImportSyntax? {
        get;
        private set;
    }

    /// Re-points this reused import at the matching declaration in the edited tree, preserving per-file visibility.
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration ImportSyntax) {
        Declaration = declaration
    }
}
