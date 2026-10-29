// <copyright file="SemanticAbstractTypeKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq

/// Issue #5252 / #5253: the identity under which gsgen's stub renderer and
/// the translator agree on one type. The renderer knows a type is abstract
/// only semantically (it inherits an unimplemented abstract member; the user
/// never wrote `abstract`) and the translator decides what each generated
/// part of that type prints, so the two name the type by this key: the package
/// (namespace), then the enclosing-to-nested chain of metadata names
/// (`Name` or `Name`N`` with N type parameters).
shared class SemanticAbstractTypeKey {
    /// Formats a key.
    /// @param packageName The type's package (namespace), or `null` for none.
    /// @param metadataNames The metadata names of the type and its enclosing types, outermost first.
    /// @returns The key.
    func Format(packageName string?, metadataNames IEnumerable[string]) string -> (packageName ?? string.Empty) +
        "|" +
        string.Join("+", metadataNames)

    /// Gets the key of a C# type symbol.
    /// @param type The type.
    /// @returns The key of the type's original definition.
    func Of(type INamedTypeSymbol) string {
        let names = List[string]()
        var current INamedTypeSymbol? = type.OriginalDefinition
        while current != nil {
            names.Add(current.MetadataName)
            current = current.ContainingType
        }
        names.Reverse()
        let package_ = if type.ContainingNamespace == nil || type.ContainingNamespace.IsGlobalNamespace {
            string.Empty
        } else {
            type.ContainingNamespace.ToDisplayString()
        }
        return Format(package_, names)
    }
}
