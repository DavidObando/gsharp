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
/// ADR-0143 2026-09-23 amendment / ADR-0192: the post-translation pass that
/// decides which tentative G# partial method pairs survive.
/// <para>
/// With <c>emitPartialMethodPairs</c> on, the translator emits a hand-authored
/// implemented C# partial method as a declaring part plus an implementing part,
/// each spelled in its own G# file and both tagged with the same
/// <see cref="MethodDeclaration.PartialPairKey"/>. gsc requires the two
/// signatures to be textually identical (GS0611), but each G# file's imports
/// and type aliases are built while THAT file is translated (including a
/// whole-file pre-scan of qualified references), so no check made while
/// translating one file can predict the other file's spelling. This pass runs
/// once every unit of the project is translated and before anything is
/// printed: a pair survives only when it has exactly one declaring and one
/// implementing part and both print the same signature
/// (<see cref="GSharpPrinter.RenderMethodSignature"/>: no body, no
/// method-level attributes, parameter annotations and defaults kept). Anything
/// else is demoted to the pre-ADR-0192 shape — the declaring part is removed
/// and the implementing part becomes an ordinary method.
/// </para>
/// </summary>
public static class PartialMethodPairReconciler
{
    /// <summary>
    /// Reconciles the tentative partial method pairs across
    /// <paramref name="units"/>, which must be every unit translated from one
    /// project.
    /// </summary>
    /// <param name="units">The translated compilation units.</param>
    /// <returns>
    /// The units, in the same order; a unit containing a demoted part is a
    /// rebuilt copy (the code model is immutable), every other unit is the same
    /// instance.
    /// </returns>
    public static IReadOnlyList<CompilationUnit> Reconcile(IReadOnlyList<CompilationUnit> units)
    {
        if (units == null)
        {
            throw new ArgumentNullException(nameof(units));
        }

        var partsByKey = new Dictionary<string, List<MethodDeclaration>>(StringComparer.Ordinal);
        foreach (CompilationUnit unit in units)
        {
            foreach (GNode member in unit.Members)
            {
                CollectParts(member, partsByKey);
            }
        }

        if (partsByKey.Count == 0)
        {
            return units;
        }

        var demoted = new HashSet<string>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, List<MethodDeclaration>> pair in partsByKey)
        {
            List<MethodDeclaration> declaring = pair.Value.Where(IsDeclaringPart).ToList();
            List<MethodDeclaration> implementing = pair.Value.Where(part => !IsDeclaringPart(part)).ToList();
            bool keep = declaring.Count == 1
                && implementing.Count == 1
                && string.Equals(
                    GSharpPrinter.RenderMethodSignature(declaring[0]),
                    GSharpPrinter.RenderMethodSignature(implementing[0]),
                    StringComparison.Ordinal);
            if (!keep)
            {
                demoted.Add(pair.Key);
            }
        }

        if (demoted.Count == 0)
        {
            return units;
        }

        return units
            .Select(unit =>
            {
                List<GNode> members = RewriteMembers(unit.Members, demoted, out bool changed);
                return changed ? unit.WithMembers(members) : unit;
            })
            .ToList();
    }

    private static bool IsDeclaringPart(MethodDeclaration method) =>
        method.Body == null && method.ExpressionBody == null;

    private static void CollectParts(GNode node, Dictionary<string, List<MethodDeclaration>> partsByKey)
    {
        switch (node)
        {
            case MethodDeclaration { IsPartial: true, PartialPairKey: not null } method:
                if (!partsByKey.TryGetValue(method.PartialPairKey, out List<MethodDeclaration> parts))
                {
                    parts = new List<MethodDeclaration>();
                    partsByKey.Add(method.PartialPairKey, parts);
                }

                parts.Add(method);
                break;
            case TypeDeclaration type:
                foreach (GMember member in type.Members)
                {
                    CollectParts(member, partsByKey);
                }

                break;
            case SharedBlock shared:
                foreach (GMember member in shared.Members)
                {
                    CollectParts(member, partsByKey);
                }

                break;
        }
    }

    private static List<T> RewriteMembers<T>(IReadOnlyList<T> members, HashSet<string> demoted, out bool changed)
        where T : GNode
    {
        changed = false;
        var result = new List<T>(members.Count);
        foreach (T member in members)
        {
            GNode rewritten = Rewrite(member, demoted);
            if (!ReferenceEquals(rewritten, member))
            {
                changed = true;
            }

            if (rewritten != null)
            {
                result.Add((T)rewritten);
            }
        }

        return result;
    }

    // Returns the node itself when nothing under it changed, null when it is a
    // demoted declaring part (removed), or a rebuilt copy.
    private static GNode Rewrite(GNode node, HashSet<string> demoted)
    {
        switch (node)
        {
            case MethodDeclaration { IsPartial: true, PartialPairKey: not null } method
                when demoted.Contains(method.PartialPairKey):
                return IsDeclaringPart(method)
                    ? null
                    : method.With(
                        method.Body,
                        method.ExpressionBody,
                        method.Attributes,
                        isPartial: false,
                        partialPairKey: null);
            case TypeDeclaration type:
            {
                List<GMember> members = RewriteMembers(type.Members, demoted, out bool changed);
                return changed ? type.WithMembers(members) : type;
            }

            case SharedBlock shared:
            {
                // The translator never emits an empty `shared { }` block, so
                // one emptied by a removed declaring part goes too.
                List<GMember> members = RewriteMembers(shared.Members, demoted, out bool changed);
                return !changed ? shared
                    : members.Count == 0 ? null
                    : shared.WithMembers(members);
            }

            default:
                return node;
        }
    }
}
