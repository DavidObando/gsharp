// <copyright file="NullabilityFreeReason.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// ADR-0193 §3 (GSA0007): why a call to
/// (cref:TypeSymbol.FromClrTypeWithoutNullability) has no declaration
/// nullability to lose. Every nullability-free conversion states one, so a
/// reviewer (and the analyzer) can see the claim at the call site.
internal enum NullabilityFreeReason {
    TypeLiteral,
    ResolvedTypeName,
    TypeStructure,
    EmitShape,
    IdentityComparison,
    CompilerProduced
}
