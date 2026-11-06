// <copyright file="StubPartialDefinition.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Cs2Gs.Translator
import GSharp.Core.CodeAnalysis.Syntax
import System.Globalization

/// ADR-0192 follow-on 2: a lone G# declaring part the stub offered to
/// generators as a C# partial method definition, with the type and
/// package that own it.
class StubPartialDefinition {
    /// Initializes a new instance of the (cref:StubPartialDefinition) class.
    /// @param packageName The owning type's package, or `null` for none.
    /// @param typeName The owning type's name.
    /// @param typeArity The owning type's number of type parameters (`P` and `P[T]` are different types).
    /// @param declaration The declaring part's syntax, in the user's file.
    /// @param typeKey The owning type's `SemanticAbstractTypeKey` (enclosing-to-nested chain), or `null` to
    /// derive a top-level key from [`packageName`](paramref), [`typeName`](paramref) and [`typeArity`](paramref).
    init(
        packageName string,
        typeName string,
        typeArity int32,
        declaration FunctionDeclarationSyntax,
        typeKey string? = nil
    ) {
        PackageName = packageName
        TypeName = typeName
        TypeArity = typeArity
        Declaration = declaration
        let metadataName = if typeArity > 0 {
            typeName + "`" + typeArity.ToString(CultureInfo.InvariantCulture)
        } else {
            typeName
        }
        TypeKey = typeKey ?? SemanticAbstractTypeKey.Format(packageName, []string{metadataName})
    }

    /// Gets the owning type's package, or `null` for none.
    prop PackageName string {
        get;
    }

    /// Gets the owning type's name.
    prop TypeName string {
        get;
    }

    /// Gets the owning type's number of type parameters.
    prop TypeArity int32 {
        get;
    }

    /// Gets the owning type's `SemanticAbstractTypeKey` (package plus outermost-to-innermost metadata names).
    prop TypeKey string {
        get;
    }

    /// Gets the declaring part's syntax, in the user's file.
    prop Declaration FunctionDeclarationSyntax {
        get;
    }
}
