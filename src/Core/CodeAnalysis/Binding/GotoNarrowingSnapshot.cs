// <copyright file="GotoNarrowingSnapshot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed class GotoNarrowingSnapshot
{
    public GotoNarrowingSnapshot(
        Dictionary<VariableSymbol, TypeSymbol> narrowedVariables,
        ImmutableArray<FinallyClauseSyntax> activeFinallyClauses)
    {
        NarrowedVariables = narrowedVariables;
        ActiveFinallyClauses = activeFinallyClauses;
    }

    public Dictionary<VariableSymbol, TypeSymbol> NarrowedVariables { get; }

    public ImmutableArray<FinallyClauseSyntax> ActiveFinallyClauses { get; }
}
