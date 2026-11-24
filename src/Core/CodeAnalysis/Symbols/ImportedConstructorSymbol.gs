// <copyright file="ImportedConstructorSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Documentation
import System.Reflection

/// The constructor of an imported type that a construction calls (`StringBuilder(16)`). The semantic
/// model answers it for the call, as it answers the chosen `init` of a source type (#6177). Its name is
/// `.ctor`, as for a constructor in metadata.
class ImportedConstructorSymbol : Symbol {
    internal init(constructor ConstructorInfo, type TypeSymbol) : base(".ctor") {
        Constructor = constructor
        Type = type
    }

    override prop Kind SymbolKind -> SymbolKind.ImportedConstructor

    /// Gets the constructor in metadata.
    prop Constructor ConstructorInfo {
        get;
    }

    /// Gets the type that the construction makes, with its type arguments.
    prop Type TypeSymbol {
        get;
    }

    internal override func DefaultContainingType() TypeSymbol? -> Type
}
