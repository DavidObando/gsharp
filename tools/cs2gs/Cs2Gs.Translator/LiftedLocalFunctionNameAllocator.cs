// <copyright file="LiftedLocalFunctionNameAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Translator;

internal sealed class LiftedLocalFunctionNameAllocator
{
    private readonly object gate = new();
    private readonly Dictionary<IMethodSymbol, string> assigned =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, HashSet<string>> usedByType =
        new(SymbolEqualityComparer.Default);

    public string Allocate(
        IMethodSymbol localFunction,
        IReadOnlyCollection<string> occupied,
        string localName)
    {
        lock (this.gate)
        {
            if (this.assigned.TryGetValue(localFunction, out string assignedName))
            {
                return assignedName;
            }

            ISymbol owner = localFunction.ContainingType ?? (ISymbol)localFunction.ContainingAssembly;
            if (!this.usedByType.TryGetValue(owner, out HashSet<string> used))
            {
                used = new HashSet<string>(StringComparer.Ordinal);
                this.usedByType.Add(owner, used);
            }

            string candidate = localName;
            for (int suffix = 2; occupied.Contains(candidate) || used.Contains(candidate); suffix++)
            {
                candidate = $"{localName}_{suffix}";
            }

            used.Add(candidate);
            this.assigned.Add(localFunction, candidate);
            return candidate;
        }
    }
}
