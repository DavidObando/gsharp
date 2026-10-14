// <copyright file="StubPartialDefinition.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import GSharp.Core.CodeAnalysis.Syntax

/// ADR-0192 follow-on 2: a lone G# declaring part the stub offered to
/// generators as a C# partial method definition, with the top-level type and
/// package that own it.
class StubPartialDefinition {
    /// Initializes a new instance of the (cref:StubPartialDefinition) class.
    /// @param packageName The owning type's package, or `null` for none.
    /// @param typeName The owning top-level type's name.
    /// @param typeArity The owning type's number of type parameters (`P` and `P[T]` are different types).
    /// @param declaration The declaring part's syntax, in the user's file.
    init(packageName string, typeName string, typeArity int32, declaration FunctionDeclarationSyntax) {
        PackageName = packageName
        TypeName = typeName
        TypeArity = typeArity
        Declaration = declaration
    }

    /// Gets the owning type's package, or `null` for none.
    prop PackageName string {
        get;
    }

    /// Gets the owning top-level type's name.
    prop TypeName string {
        get;
    }

    /// Gets the owning type's number of type parameters.
    prop TypeArity int32 {
        get;
    }

    /// Gets the declaring part's syntax, in the user's file.
    prop Declaration FunctionDeclarationSyntax {
        get;
    }
}
