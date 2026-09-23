// <copyright file="PartialMethodPairReconciler.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;

namespace Cs2Gs.Translator;

/// <summary>
/// ADR-0143 2026-09-23 amendment / ADR-0192: decides which G# partial method
/// pairs a project's translation keeps.
/// <para>
/// With <c>emitPartialMethodPairs</c> on, the translator emits a hand-authored
/// implemented C# partial method as a declaring part plus an implementing part,
/// each spelled in its own G# file and both tagged with the same
/// <see cref="MethodDeclaration.PartialPairKey"/>. gsc requires the two
/// signatures to be textually identical (GS0611), but each G# file's imports
/// and type aliases are built while THAT file is translated (including a
/// whole-file pre-scan of qualified references), so no check made while
/// translating one file can predict the other file's spelling. The pairs are
/// therefore tentative until <see cref="TranslateUntilStable"/> has compared
/// them across every unit of the project.
/// </para>
/// </summary>
public static class PartialMethodPairReconciler
{
    /// <summary>
    /// The most re-translation rounds <see cref="TranslateUntilStable"/> runs
    /// before it suppresses every remaining pair. Each round suppresses at
    /// least one more pair key or ends, so the real bound is the number of
    /// pairs; this is a guard, not an expected limit.
    /// </summary>
    public const int MaxRounds = 32;

    /// <summary>
    /// Translates every unit of one project, then repeatedly: finds each pair
    /// whose parts do not have exactly one declaring and one implementing part
    /// printing the same signature (<see cref="FindMismatchedPairKeys"/>), adds
    /// its key to the suppressed set, and re-translates every unit holding a
    /// part of a newly suppressed pair — until no pair mismatches. A
    /// suppressed pair translates exactly as with pairs off, so its output is
    /// the pre-ADR-0192 output. Re-translation (rather than editing the
    /// printed tree) also discards any import or alias the dropped declaring
    /// part had recorded, and re-checks the other pairs of the same file,
    /// whose spelling that can change.
    /// </summary>
    /// <param name="unitCount">The number of units in the project.</param>
    /// <param name="translateUnit">
    /// Translates unit <c>i</c> with the given suppressed pair keys. It is
    /// called once per unit and again for each re-translated unit, and must
    /// use a fresh translation context each time and the same translator
    /// instance for the same unit.
    /// </param>
    /// <returns>The final units, in order.</returns>
    public static IReadOnlyList<CompilationUnit> TranslateUntilStable(
        int unitCount,
        Func<int, IReadOnlyCollection<string>, CompilationUnit> translateUnit)
    {
        if (translateUnit == null)
        {
            throw new ArgumentNullException(nameof(translateUnit));
        }

        var suppressed = new HashSet<string>(StringComparer.Ordinal);
        var units = new List<CompilationUnit>(unitCount);
        for (int i = 0; i < unitCount; i++)
        {
            units.Add(translateUnit(i, suppressed.ToList()));
        }

        for (int round = 0; ; round++)
        {
            IReadOnlyCollection<string> mismatched = FindMismatchedPairKeys(units);
            if (mismatched.Count == 0)
            {
                return units;
            }

            // Guard: stop iterating and suppress EVERY pair in the project, so
            // no tentative pair can survive unchecked.
            IEnumerable<string> newlySuppressed = round < MaxRounds
                ? mismatched
                : units.SelectMany(CollectPairKeys);
            var added = new HashSet<string>(StringComparer.Ordinal);
            foreach (string key in newlySuppressed)
            {
                if (suppressed.Add(key))
                {
                    added.Add(key);
                }
            }

            if (added.Count == 0)
            {
                // Cannot happen: a suppressed key is never emitted again.
                throw new InvalidOperationException(
                    "Partial method pair reconciliation made no progress: " + string.Join(", ", mismatched));
            }

            IReadOnlyCollection<string> snapshot = suppressed.ToList();
            for (int i = 0; i < units.Count; i++)
            {
                if (CollectPairKeys(units[i]).Any(added.Contains))
                {
                    units[i] = translateUnit(i, snapshot);
                }
            }
        }
    }

    /// <summary>
    /// Finds the pair keys across <paramref name="units"/> whose parts do not
    /// form exactly one declaring and one implementing part printing the same
    /// signature (<see cref="GSharpPrinter.RenderMethodSignature"/>: no body,
    /// no method-level attributes — gsc unions those — with parameter
    /// annotations and defaults, which gsc compares).
    /// </summary>
    /// <param name="units">Every unit translated from one project.</param>
    /// <returns>The mismatched pair keys.</returns>
    public static IReadOnlyCollection<string> FindMismatchedPairKeys(IReadOnlyList<CompilationUnit> units)
    {
        if (units == null)
        {
            throw new ArgumentNullException(nameof(units));
        }

        var partsByKey = new Dictionary<string, List<MethodDeclaration>>(StringComparer.Ordinal);
        foreach (CompilationUnit unit in units)
        {
            foreach (MethodDeclaration part in CollectParts(unit))
            {
                if (!partsByKey.TryGetValue(part.PartialPairKey, out List<MethodDeclaration> parts))
                {
                    parts = new List<MethodDeclaration>();
                    partsByKey.Add(part.PartialPairKey, parts);
                }

                parts.Add(part);
            }
        }

        var mismatched = new List<string>();
        foreach (KeyValuePair<string, List<MethodDeclaration>> pair in partsByKey)
        {
            List<MethodDeclaration> declaring = pair.Value.Where(IsDeclaringPart).ToList();
            List<MethodDeclaration> implementing = pair.Value.Where(part => !IsDeclaringPart(part)).ToList();
            bool matches = declaring.Count == 1
                && implementing.Count == 1
                && string.Equals(
                    GSharpPrinter.RenderMethodSignature(declaring[0]),
                    GSharpPrinter.RenderMethodSignature(implementing[0]),
                    StringComparison.Ordinal);
            if (!matches)
            {
                mismatched.Add(pair.Key);
            }
        }

        return mismatched;
    }

    private static bool IsDeclaringPart(MethodDeclaration method) =>
        method.Body == null && method.ExpressionBody == null;

    private static IEnumerable<string> CollectPairKeys(CompilationUnit unit) =>
        CollectParts(unit).Select(part => part.PartialPairKey);

    private static IEnumerable<MethodDeclaration> CollectParts(CompilationUnit unit)
    {
        var parts = new List<MethodDeclaration>();
        foreach (GNode member in unit.Members)
        {
            CollectParts(member, parts);
        }

        return parts;
    }

    private static void CollectParts(GNode node, List<MethodDeclaration> parts)
    {
        switch (node)
        {
            case MethodDeclaration { IsPartial: true, PartialPairKey: not null } method:
                parts.Add(method);
                break;
            case TypeDeclaration type:
                foreach (GMember member in type.Members)
                {
                    CollectParts(member, parts);
                }

                break;
            case SharedBlock shared:
                foreach (GMember member in shared.Members)
                {
                    CollectParts(member, parts);
                }

                break;
        }
    }
}
