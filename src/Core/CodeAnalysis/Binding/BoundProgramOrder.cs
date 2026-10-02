// <copyright file="BoundProgramOrder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Deterministic views of a <see cref="BoundProgram"/>'s symbol-keyed
/// dictionaries (issue #4663). <see cref="BoundProgram.Functions"/> and
/// <see cref="BoundProgram.Initializers"/> are <c>ImmutableDictionary</c>
/// instances keyed by identity-hashed symbols, so enumerating them directly
/// yields an order that changes with unrelated inputs and with the compiler
/// binary itself. A pass that names, numbers or appends anything while
/// walking a program iterates these views instead.
/// </summary>
internal static class BoundProgramOrder
{
    /// <summary>Gets the program's functions in <see cref="SymbolSourceOrderComparer"/> order.</summary>
    /// <param name="program">The program.</param>
    /// <returns>The function entries, deterministically ordered.</returns>
    public static ImmutableArray<KeyValuePair<FunctionSymbol, BoundBlockStatement>> Functions(BoundProgram program) =>
        program.Functions
            .OrderBy(pair => pair.Key, SymbolSourceOrderComparer.Instance)
            .ToImmutableArray();

    /// <summary>
    /// Gets a field-initializer map's entries in <see cref="SymbolSourceOrderComparer"/>
    /// order. The maps are identity-keyed <c>ImmutableDictionary</c> instances, so a
    /// pass that numbers temporaries while rewriting each initializer (the
    /// <c>&lt;&gt;interpN</c> / <c>&lt;&gt;holeN</c> locals land in the Portable PDB)
    /// must walk this view instead of the map.
    /// </summary>
    /// <param name="initializers">A struct's or interface's field-initializer map.</param>
    /// <returns>The initializer entries, deterministically ordered by field.</returns>
    public static ImmutableArray<KeyValuePair<FieldSymbol, BoundExpression>> FieldInitializers(
        ImmutableDictionary<FieldSymbol, BoundExpression> initializers) =>
        initializers
            .OrderBy(pair => pair.Key, SymbolSourceOrderComparer.Instance)
            .ToImmutableArray();

    /// <summary>
    /// Gets the program's initialization plans ordered by owner
    /// (<see cref="SymbolSourceOrderComparer"/>), instance plan before static.
    /// </summary>
    /// <param name="program">The program.</param>
    /// <returns>The initializer entries, deterministically ordered.</returns>
    public static ImmutableArray<KeyValuePair<(Symbol Owner, bool Static), BoundInitializationPlan>> Initializers(
        BoundProgram program) =>
        program.Initializers
            .OrderBy(pair => pair.Key.Owner, SymbolSourceOrderComparer.Instance)
            .ThenBy(pair => pair.Key.Static)
            .ToImmutableArray();
}
