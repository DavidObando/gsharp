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

    public string Allocate(
        IMethodSymbol localFunction,
        INamedTypeSymbol emittedOwner,
        ISet<string> occupied,
        string localName,
        Func<string, bool> unavailable)
    {
        lock (this.gate)
        {
            IMethodSymbol functionKey = localFunction.OriginalDefinition;
            if (this.assigned.TryGetValue(functionKey, out string assignedName))
            {
                return assignedName;
            }

            ISymbol owner = (ISymbol)emittedOwner?.OriginalDefinition
                ?? (ISymbol)localFunction.ContainingType?.OriginalDefinition
                ?? localFunction.ContainingAssembly;
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
            this.assigned.Add(functionKey, candidate);
            return candidate;
        }
    }

    public string AllocateBackingField(
        IPropertySymbol property,
        ISet<string> occupied,
        string baseName)
    {
        lock (this.gate)
        {
            IPropertySymbol propertyKey = property.OriginalDefinition;
            if (this.assigned.TryGetValue(propertyKey, out string assignedName))
            {
                return assignedName;
            }

            ISymbol owner = (ISymbol)property.ContainingType?.OriginalDefinition
                ?? property.ContainingAssembly;
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
            this.assigned.Add(propertyKey, candidate);
            return candidate;
        }
    }
}
