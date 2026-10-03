// <copyright file="LiftedLocalFunctionNameAllocator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;

namespace Cs2Gs.Translator;

internal sealed class LiftedLocalFunctionNameAllocator
{
    private static readonly ConditionalWeakTable<Compilation, LiftedLocalFunctionNameAllocator> ByCompilation = new();

    private readonly object gate = new();
    private readonly Dictionary<ISymbol, string> assigned =
        new(SymbolEqualityComparer.Default);

    private readonly Dictionary<ISymbol, HashSet<string>> usedByType =
        new(SymbolEqualityComparer.Default);

    // Issue #4302: helper members from one partial document and file-scope
    // import aliases from another meet in the same emitted type. gsc resolves
    // an invocation to the member before the alias, so neither may take the
    // other's name, whichever document is translated first.
    private readonly HashSet<string> helperNames = new(StringComparer.Ordinal);
    private readonly HashSet<string> aliasNames = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> aliasesByTarget =
        new(StringComparer.Ordinal);

    // Issue #4302: synthesized locals can print beside bare helper references
    // in the same emitted type, so the two reserve against each other
    // whichever is allocated first.
    private readonly Dictionary<ISymbol, HashSet<string>> localNamesByType =
        new(SymbolEqualityComparer.Default);

    public static LiftedLocalFunctionNameAllocator For(Compilation compilation) =>
        ByCompilation.GetValue(compilation, static _ => new LiftedLocalFunctionNameAllocator());

    public string ClaimDesignator(INamedTypeSymbol emittedOwner, string stem, Func<string, bool> reserved)
    {
        lock (this.gate)
        {
            ISymbol owner = emittedOwner?.OriginalDefinition;
            HashSet<string> helpers = owner != null && this.usedByType.TryGetValue(owner, out HashSet<string> used)
                ? used
                : null;
            string designator = stem;
            for (int suffix = 2; reserved(designator) || helpers?.Contains(designator) == true; suffix++)
            {
                designator = $"{stem}_{suffix}";
            }

            if (owner != null)
            {
                if (!this.localNamesByType.TryGetValue(owner, out HashSet<string> localNames))
                {
                    localNames = new HashSet<string>(StringComparer.Ordinal);
                    this.localNamesByType.Add(owner, localNames);
                }

                localNames.Add(designator);
            }

            return designator;
        }
    }

    public bool TryClaimLocalName(INamedTypeSymbol emittedOwner, string name)
    {
        lock (this.gate)
        {
            ISymbol owner = emittedOwner?.OriginalDefinition;
            if (owner == null)
            {
                return true;
            }

            if (this.usedByType.TryGetValue(owner, out HashSet<string> helpers)
                && helpers.Contains(name))
            {
                return false;
            }

            if (!this.localNamesByType.TryGetValue(owner, out HashSet<string> localNames))
            {
                localNames = new HashSet<string>(StringComparer.Ordinal);
                this.localNamesByType.Add(owner, localNames);
            }

            return localNames.Add(name);
        }
    }

    public bool ReserveLocalName(INamedTypeSymbol emittedOwner, string name)
    {
        lock (this.gate)
        {
            ISymbol owner = emittedOwner?.OriginalDefinition;
            if (owner == null)
            {
                return true;
            }

            if (this.usedByType.TryGetValue(owner, out HashSet<string> helpers)
                && helpers.Contains(name))
            {
                return false;
            }

            if (!this.localNamesByType.TryGetValue(owner, out HashSet<string> localNames))
            {
                localNames = new HashSet<string>(StringComparer.Ordinal);
                this.localNamesByType.Add(owner, localNames);
            }

            localNames.Add(name);
            return true;
        }
    }

    public string ClaimAlias(string target, string baseAlias, Func<string, bool> reserved)
    {
        lock (this.gate)
        {
            if (this.aliasesByTarget.TryGetValue(target, out List<string> existing))
            {
                foreach (string existingAlias in existing)
                {
                    if (!reserved(existingAlias))
                    {
                        return existingAlias;
                    }
                }
            }

            string alias = baseAlias;
            for (int suffix = 2;
                reserved(alias)
                    || this.helperNames.Contains(alias)
                    || this.aliasNames.Contains(alias);
                suffix++)
            {
                alias = $"{baseAlias}_{suffix}";
            }

            this.aliasNames.Add(alias);
            if (existing == null)
            {
                existing = new List<string>();
                this.aliasesByTarget.Add(target, existing);
            }

            existing.Add(alias);
            return alias;
        }
    }

    public string ClaimAlias(string baseAlias, Func<string, bool> reserved)
    {
        lock (this.gate)
        {
            string alias = baseAlias;
            for (int suffix = 2;
                reserved(alias)
                    || this.helperNames.Contains(alias)
                    || this.aliasNames.Contains(alias);
                suffix++)
            {
                alias = $"{baseAlias}_{suffix}";
            }

            this.aliasNames.Add(alias);
            return alias;
        }
    }

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

            this.localNamesByType.TryGetValue(owner, out HashSet<string> localNames);
            string candidate = localName;
            for (int suffix = 2;
                occupied.Contains(candidate)
                    || used.Contains(candidate)
                    || this.aliasNames.Contains(candidate)
                    || localNames?.Contains(candidate) == true
                    || unavailable(candidate);
                suffix++)
            {
                candidate = $"{localName}_{suffix}";
            }

            used.Add(candidate);
            this.helperNames.Add(candidate);
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
