// <copyright file="ClrNullabilityState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// ADR-0186 §2: what one C# nullable-metadata byte actually says about a
/// reference position — the three-state successor to ADR-0136's two-valued
/// `IsFlagNonNull`.
///
/// The names are C#'s own, deliberately: these are <em>readings of metadata</em>,
/// not G# types. The mapping from a state to a G# type is a separate decision
/// and lives in exactly one place
/// ((cref:ClrNullability.SymbolForState)), which is what lets
/// ADR-0186's pivot change one cell of ADR-0136's table without touching the
/// readers.
///
/// ADR-0186 spells this `NullabilityState`. It is named
/// `ClrNullabilityState` here because `System.Reflection` already
/// declares a `NullabilityState` — the BCL's own reading of the same
/// metadata, which this repository's emit tests use heavily via
/// `NullabilityInfoContext`. Under the ADR's spelling, every file that
/// imports both `System.Reflection` and this namespace stops compiling
/// with CS0104, and several already do.
internal enum ClrNullabilityState {
    Oblivious,
    NotAnnotated,
    Annotated
}
