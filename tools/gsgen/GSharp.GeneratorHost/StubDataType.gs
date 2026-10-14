// <copyright file="StubDataType.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import GSharp.Core.CodeAnalysis.Text

/// ADR-0192 amendment (partial data types): a top-level G# `data class` or
/// `data struct` the stub rendered. A generated part of it must be a
/// `data` part too (gsc requires `data` on every part, GS0479),
/// whatever C# keyword the stub gave it, so the back-translation takes the
/// part's kind from here rather than from the generated C#.
class StubDataType {
    /// Initializes a new instance of the (cref:StubDataType) class.
    /// @param packageName The type's package, or `null` for none.
    /// @param typeName The type's name.
    /// @param typeArity The type's number of type parameters.
    /// @param isClass `true` for a `data class`, `false` for a `data struct`.
    /// @param positionalList The location of the user's positional parameter list, or `null` when no part
    /// states one.
    init(packageName string, typeName string, typeArity int32, isClass bool, positionalList TextLocation? = nil) {
        PositionalList = positionalList
        PackageName = packageName
        TypeName = typeName
        TypeArity = typeArity
        IsClass = isClass
    }

    /// Gets the type's package, or `null` for none.
    prop PackageName string {
        get;
    }

    /// Gets the type's name.
    prop TypeName string {
        get;
    }

    /// Gets the type's number of type parameters.
    prop TypeArity int32 {
        get;
    }

    /// Gets a value indicating whether the type is a `data class` (otherwise a `data struct`).
    prop IsClass bool {
        get;
    }

    /// Gets the location of the user's positional parameter list, or
    /// `null` when no user part states one (a generated part
    /// may then supply it).
    prop PositionalList TextLocation? {
        get;
    }
}
