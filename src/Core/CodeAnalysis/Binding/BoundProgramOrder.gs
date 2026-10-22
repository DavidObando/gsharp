// <copyright file="BoundProgramOrder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Deterministic views of a (cref:BoundProgram)'s symbol-keyed
/// dictionaries (issue #4663). (cref:BoundProgram.Functions) and
/// (cref:BoundProgram.Initializers) are `ImmutableDictionary`
/// instances keyed by identity-hashed symbols, so enumerating them directly
/// yields an order that changes with unrelated inputs and with the compiler
/// binary itself. A pass that names, numbers or appends anything while
/// walking a program iterates these views instead.
internal shared class BoundProgramOrder {
    /// Gets the program's functions in (cref:SymbolSourceOrderComparer) order.
    /// @param program The program.
    /// @returns The function entries, deterministically ordered.
    func Functions(program BoundProgram) ImmutableArray[KeyValuePair[FunctionSymbol, BoundBlockStatement]] ->
    program.OrderedFunctions

    /// Sorts a function map into (cref:SymbolSourceOrderComparer) order.
    /// (cref:BoundProgram) calls this once and caches the result.
    /// @param functions The function map.
    /// @returns The function entries, deterministically ordered.
    func SortFunctions(functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement]) ImmutableArray[
        KeyValuePair[FunctionSymbol, BoundBlockStatement]
    ] {
        CompilationMeasurements.Count("emit.function-sorts")
        return functions.OrderBy(
            (pair KeyValuePair[FunctionSymbol, BoundBlockStatement]) -> pair.Key,
            SymbolSourceOrderComparer.Instance
        )
            .ToImmutableArray()
    }

    /// Gets a field-initializer map's entries in (cref:SymbolSourceOrderComparer)
    /// order. The maps are identity-keyed `ImmutableDictionary` instances, so a
    /// pass that numbers temporaries while rewriting each initializer must walk
    /// this view instead of the map. These field-initializer temporaries are
    /// defensive ordering, not a Portable PDB determinism claim.
    /// @param initializers A struct's or interface's field-initializer map.
    /// @returns The initializer entries, deterministically ordered by field.
    func FieldInitializers(initializers ImmutableDictionary[FieldSymbol, BoundExpression]) ImmutableArray[
        KeyValuePair[FieldSymbol, BoundExpression]
    ] -> initializers
        .OrderBy((pair KeyValuePair[FieldSymbol, BoundExpression]) -> pair.Key, SymbolSourceOrderComparer.Instance)
        .ToImmutableArray()

    /// Gets the program's initialization plans ordered by owner
    /// ((cref:SymbolSourceOrderComparer)), instance plan before static.
    /// @param program The program.
    /// @returns The initializer entries, deterministically ordered.
    func Initializers(program BoundProgram) ImmutableArray[
        KeyValuePair[(Owner Symbol, Static bool), BoundInitializationPlan]
    ] -> program
        .Initializers
        .OrderBy(
        (pair KeyValuePair[(Owner Symbol, Static bool), BoundInitializationPlan]) -> pair.Key.Owner,
        SymbolSourceOrderComparer.Instance
    )
        .ThenBy((pair KeyValuePair[(Owner Symbol, Static bool), BoundInitializationPlan]) -> pair.Key.Static)
        .ToImmutableArray()
}
