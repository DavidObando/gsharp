// <copyright file="MissingTypeSymbol.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// The type that a type reference names when no assembly of the reference set supplies it.
/// @remarks A (cref:ReferenceImageSet) interns one symbol for each pair of assembly identity and full name.
/// A missing type is equal to itself and to no other symbol (ADR-0209 section 6).
internal class MissingTypeSymbol : TypeSymbol {
    internal init(assemblyIdentity AssemblyIdentity?, fullName string) : base(fullName) {
        AssemblyIdentity = assemblyIdentity
        FullName = fullName
    }

    /// Gets the identity of the assembly that the reference names, or `null` when the reference names none.
    internal prop AssemblyIdentity AssemblyIdentity?

    /// Gets the full name in the spelling of reflection, with `+` between a type and its nested type.
    internal prop FullName string
}
