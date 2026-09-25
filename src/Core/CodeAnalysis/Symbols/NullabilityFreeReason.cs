// <copyright file="NullabilityFreeReason.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// ADR-0193 §3 (GSA0007): why a call to
/// <see cref="TypeSymbol.FromClrTypeWithoutNullability"/> has no declaration
/// nullability to lose. Every nullability-free conversion states one, so a
/// reviewer (and the analyzer) can see the claim at the call site.
/// </summary>
internal enum NullabilityFreeReason
{
    /// <summary>
    /// The type is a <c>typeof(...)</c> literal in the compiler's own source,
    /// or a runtime-helper type the compiler resolves by its well-known name:
    /// a known type used as itself, not read from a member declaration.
    /// </summary>
    TypeLiteral,

    /// <summary>
    /// The type is named in G# source and was resolved to its CLR type (a
    /// type clause, an import alias, a base-type or interface clause). A type
    /// name states no nullability of its own; a <c>?</c> written beside it is
    /// applied by the binder separately.
    /// </summary>
    ResolvedTypeName,

    /// <summary>
    /// The type is a structural component of a CLR <see cref="System.Type"/>
    /// the caller already holds: a symbol's own <c>ClrType</c>, or its element,
    /// generic argument, generic definition or base type. A
    /// <see cref="System.Type"/> object carries no reference nullability;
    /// that lives on the member declaration that spelled it, which this call
    /// does not have.
    /// </summary>
    TypeStructure,

    /// <summary>
    /// The result only selects IL or a lowering shape (a local, a field of a
    /// synthesized state machine, a <c>castclass</c> target). IL carries no
    /// reference nullability, and the result never reaches a bound node's
    /// type that a nullability check reads.
    /// </summary>
    EmitShape,

    /// <summary>
    /// The result is only compared for type identity or shape (a variance
    /// slot, a well-known type test), where reference-nullability wrappers
    /// would be looked through anyway. This also covers an overload-resolution
    /// applicability callback that receives an erased CLR <see cref="System.Type"/>
    /// and cannot reach the declaration; the winning candidate's argument
    /// conversion re-reads the position through the funnel.
    /// </summary>
    IdentityComparison,

    /// <summary>
    /// The type was produced by the compiler itself (a type being emitted,
    /// a runtime-bound value's <c>GetType()</c>, a script submission's
    /// projected type), not read from imported member metadata.
    /// </summary>
    CompilerProduced,
}
