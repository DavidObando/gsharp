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
    private readonly Dictionary<ISymbol, string> assigned =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, HashSet<string>> usedByType =
        new(SymbolEqualityComparer.Default);

    private readonly HashSet<string> helperNames = new(StringComparer.Ordinal);

    public bool IsAllocatedHelperName(string name)
    {
        lock (this.gate)
        {
            return this.helperNames.Contains(name);
        }
    }

    public string Allocate(
        IMethodSymbol localFunction,
        INamedTypeSymbol emittedOwner,
        ISet<string> occupied,
        string localName,
        Func<string, bool> unavailable)
    {
        // Memo keys are normalized to definitions so one helper reached
        // through different symbol instances gets one name and one registry.
        ISymbol key = localFunction.OriginalDefinition;
        ISymbol owner = (ISymbol)(emittedOwner ?? localFunction.ContainingType)?.OriginalDefinition
            ?? localFunction.ContainingAssembly;
        lock (this.gate)
        {
            if (this.assigned.TryGetValue(key, out string assignedName))
            {
                return assignedName;
            }

            if (!this.usedByType.TryGetValue(owner, out HashSet<string> used))
            {
                used = new HashSet<string>(StringComparer.Ordinal);
                this.usedByType.Add(owner, used);
            }

            string candidate = localName;
            for (int suffix = 2;
                occupied.Contains(candidate) || used.Contains(candidate) || unavailable(candidate);
                suffix++)
            {
                candidate = $"{localName}_{suffix}";
            }

            used.Add(candidate);
            this.helperNames.Add(candidate);
            this.assigned.Add(key, candidate);
            return candidate;
        }
    }

    public string AllocateBackingField(
        IPropertySymbol property,
        ISet<string> occupied,
        string baseName)
    {
        ISymbol key = property.OriginalDefinition;
        ISymbol owner = (ISymbol)property.ContainingType?.OriginalDefinition ?? property.ContainingAssembly;
        lock (this.gate)
        {
            if (this.assigned.TryGetValue(key, out string assignedName))
            {
                return assignedName;
            }

            if (!this.usedByType.TryGetValue(owner, out HashSet<string> used))
            {
                used = new HashSet<string>(StringComparer.Ordinal);
                this.usedByType.Add(owner, used);
            }

            string candidate = baseName;
            for (int suffix = 2;
                occupied.Contains(candidate) || used.Contains(candidate);
                suffix++)
            {
                candidate = baseName + suffix;
            }

            used.Add(candidate);
            this.assigned.Add(key, candidate);
            return candidate;
        }
    }
}
