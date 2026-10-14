// <copyright file="ClrTypeInspector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Reflection
import System.Reflection.Emit

/// Provides stable CLR entry points for reflected-type inspection.
shared class ClrTypeInspector {
    /// Compares reflected types across runtime and metadata load contexts.
    /// @param left The first type.
    /// @param right The second type.
    /// @returns Whether the types represent the same CLR type.
    func IsSameAs(left Type, right Type) bool {
        return left.IsSameAs(right)
    }

    /// Finds a method while supporting constructed (cref:TypeBuilder) types.
    /// @param type The type to inspect.
    /// @param name The method name.
    /// @returns The method, or `null` when none matches.
    func GetMethodSafe(type Type, name string) MethodInfo? {
        return type.GetMethodSafe(name)
    }

    /// Finds a method by parameter types while supporting constructed
    /// (cref:TypeBuilder) types.
    /// @param type The type to inspect.
    /// @param name The method name.
    /// @param parameterTypes The required parameter types.
    /// @returns The method, or `null` when none matches.
    func GetMethodSafe(type Type, name string, parameterTypes ...Type) MethodInfo? {
        return type.GetMethodSafe(name, parameterTypes)
    }
}
