// <copyright file="PartialTypeMerger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1512 // Single-line comments should not be followed by blank line

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0144 / issue #2201: pre-pass that merges multiple <c>partial</c>
/// declarations of the same type (same package + name) into ONE synthetic
/// declaration node before the two-phase shell/body binder runs. Grouping,
/// deterministic part ordering (ADR-0066), and head-consistency validation
/// (GS0475-GS0483) all happen here; the existing
/// <c>DeclareStructShell</c>/<c>BindStructDeclarationBody</c> (and interface
/// equivalents) then run once per merged node, exactly as they do for a lone
/// declaration. This keeps the body binder, installers, symbols, and emitter
/// untouched: one merged node yields one shell, one symbol, and one TypeDef.
/// </summary>
internal static class PartialTypeMerger
{
    /// <summary>
    /// Merges the <c>partial</c> struct/class declarations of
    /// <paramref name="declarations"/> that share a <c>(package, name)</c> key,
    /// leaving lone declarations (and non-partial duplicate groups) untouched.
    /// </summary>
    /// <param name="declarations">The top-level struct/class declarations across every tree.</param>
    /// <param name="packageByTree">Maps each syntax tree to its owning package (for the grouping key).</param>
    /// <param name="diagnostics">The bag that receives GS0475-GS0483.</param>
    /// <returns>One declaration per group: the merged node for multi-part partial groups, otherwise the original declarations.</returns>
    public static IReadOnlyList<StructDeclarationSyntax> MergeStructs(
        IEnumerable<StructDeclarationSyntax> declarations,
        IReadOnlyDictionary<SyntaxTree, PackageSymbol> packageByTree,
        DiagnosticBag diagnostics)
    {
        var result = new List<StructDeclarationSyntax>();
        foreach (var group in GroupByKey(declarations, packageByTree))
        {
            if (group.Count == 1)
            {
                // A lone declaration is not merged, but it may still contain
                // `partial` NESTED types that must be merged among themselves.
                result.Add(NormalizeNestedTypes(group[0], diagnostics));
                continue;
            }

            var anyPartial = group.Any(d => d.IsPartial);
            if (!anyPartial)
            {
                // No part carries `partial` → today's duplicate-name GS0102 in
                // DeclareStructShell fires for the second and later parts. Do
                // not merge or suppress it (but still normalize each one's
                // nested types).
                result.AddRange(group.Select(g => NormalizeNestedTypes(g, diagnostics)));
                continue;
            }

            result.Add(MergeStructGroup(group, diagnostics));
        }

        return result;
    }

    /// <summary>
    /// Merges the <c>partial</c> interface declarations of
    /// <paramref name="declarations"/> that share a <c>(package, name)</c> key,
    /// leaving lone declarations (and non-partial duplicate groups) untouched.
    /// </summary>
    /// <param name="declarations">The top-level interface declarations across every tree.</param>
    /// <param name="packageByTree">Maps each syntax tree to its owning package (for the grouping key).</param>
    /// <param name="diagnostics">The bag that receives GS0475-GS0483.</param>
    /// <returns>One declaration per group: the merged node for multi-part partial groups, otherwise the original declarations.</returns>
    public static IReadOnlyList<InterfaceDeclarationSyntax> MergeInterfaces(
        IEnumerable<InterfaceDeclarationSyntax> declarations,
        IReadOnlyDictionary<SyntaxTree, PackageSymbol> packageByTree,
        DiagnosticBag diagnostics)
    {
        var result = new List<InterfaceDeclarationSyntax>();
        foreach (var group in GroupByKey(declarations, packageByTree))
        {
            if (group.Count == 1)
            {
                result.Add(group[0]);
                continue;
            }

            var anyPartial = group.Any(d => d.IsPartial);
            if (!anyPartial)
            {
                result.AddRange(group);
                continue;
            }

            result.Add(MergeInterfaceGroup(group, diagnostics));
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Grouping / ordering
    // ─────────────────────────────────────────────────────────────────────────

    private static List<List<T>> GroupByKey<T>(
        IEnumerable<T> declarations,
        IReadOnlyDictionary<SyntaxTree, PackageSymbol> packageByTree)
        where T : MemberSyntax
    {
        // Preserve first-appearance order of the groups for determinism of the
        // returned list.
        var order = new List<(string Package, string Name)>();
        var groups = new Dictionary<(string Package, string Name), List<T>>();

        foreach (var decl in declarations)
        {
            var packageName = packageByTree.TryGetValue(decl.SyntaxTree, out var pkg) ? pkg.Name : string.Empty;
            var name = GetIdentifier(decl)?.Text ?? string.Empty;
            var key = (packageName, name);
            if (!groups.TryGetValue(key, out var list))
            {
                list = new List<T>();
                groups[key] = list;
                order.Add(key);
            }

            list.Add(decl);
        }

        var ordered = new List<List<T>>();
        foreach (var key in order)
        {
            var parts = groups[key];

            // Deterministic part order (ADR-0066): (file path, span start).
            parts.Sort((a, b) =>
            {
                var fileA = a.SyntaxTree.Text?.FileName ?? string.Empty;
                var fileB = b.SyntaxTree.Text?.FileName ?? string.Empty;
                var byFile = string.CompareOrdinal(fileA, fileB);
                if (byFile != 0)
                {
                    return byFile;
                }

                return a.Span.Start.CompareTo(b.Span.Start);
            });

            ordered.Add(parts);
        }

        return ordered;
    }

    private static SyntaxToken GetIdentifier(MemberSyntax decl) => decl switch
    {
        StructDeclarationSyntax s => s.Identifier,
        InterfaceDeclarationSyntax i => i.Identifier,
        _ => null,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Struct/class merge
    // ─────────────────────────────────────────────────────────────────────────

    private static StructDeclarationSyntax MergeStructGroup(List<StructDeclarationSyntax> parts, DiagnosticBag diagnostics)
    {
        var primary = parts[0];
        var name = primary.Identifier?.Text ?? string.Empty;

        // GS0475: some — but not all — parts carry `partial`. Report each
        // non-partial part, then merge everything (best effort — avoids a
        // GS0102 cascade on the parts that ARE partial).
        if (!parts.All(p => p.IsPartial))
        {
            foreach (var part in parts.Where(p => !p.IsPartial))
            {
                diagnostics.ReportPartialModifierMissing(part.Identifier.Location, name);
            }
        }

        // GS0476: aggregate kind (class vs struct) must agree.
        foreach (var part in parts.Skip(1).Where(p => p.IsClass != primary.IsClass))
        {
            diagnostics.ReportPartialKindMismatch(part.Identifier.Location, name);
        }

        var accessibilityModifier = ResolveAccessibility(parts, name, diagnostics);
        ValidateOpenSealed(parts, name, diagnostics);
        var openModifier = parts.Select(p => p.OpenModifier).FirstOrDefault(t => t != null);
        var sealedKeyword = parts.Select(p => p.SealedKeyword).FirstOrDefault(t => t != null);

        // GS0479: data / inline / ref must appear on every part or none.
        RequireOnEveryPart(parts, p => p.DataKeyword != null, "data", name, diagnostics);
        RequireOnEveryPart(parts, p => p.InlineKeyword != null, "inline", name, diagnostics);
        RequireOnEveryPart(parts, p => p.RefModifier != null, "ref", name, diagnostics);

        // GS0480: identical type-parameter lists (names + arity + constraints).
        var primaryTypeParams = NormalizeNodeText(primary.TypeParameterList);
        foreach (var part in parts.Skip(1).Where(p => NormalizeNodeText(p.TypeParameterList) != primaryTypeParams))
        {
            diagnostics.ReportPartialTypeParameterMismatch(part.Identifier.Location, name);
        }

        // Primary constructor: at most one part may declare one (GS0482).
        StructDeclarationSyntax primaryCtorPart = null;
        foreach (var part in parts.Where(p => p.HasPrimaryConstructor || p.PrimaryConstructorParameters.Count > 0))
        {
            if (primaryCtorPart == null)
            {
                primaryCtorPart = part;
            }
            else
            {
                diagnostics.ReportPartialMultiplePrimaryConstructors(part.Identifier.Location, name);
            }
        }

        // deinit: at most one across all parts (GS0483).
        DeinitDeclarationSyntax deinit = null;
        foreach (var part in parts.Where(p => p.Deinitializer != null))
        {
            if (deinit == null)
            {
                deinit = part.Deinitializer;
            }
            else
            {
                diagnostics.ReportPartialMultipleDeinit(part.Deinitializer.Location, name);
            }
        }

        // Base clause (GS0481) + union.
        var baseInfo = ResolveStructBaseClause(parts, primary, name, diagnostics);

        var mergedShared = MergeSharedBlocks(primary.SyntaxTree, parts.Select(p => p.SharedBlock));

        var merged = new StructDeclarationSyntax(
            primary.SyntaxTree,
            accessibilityModifier,
            primary.TypeKeyword,
            primary.Identifier,
            primary.DataKeyword,
            primary.InlineKeyword,
            openModifier,
            primary.StructKeyword,
            primaryCtorPart?.PrimaryConstructorOpenParenthesisToken,
            primaryCtorPart?.PrimaryConstructorParameters ?? new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty),
            primaryCtorPart?.PrimaryConstructorCloseParenthesisToken,
            baseInfo.BaseColonToken,
            baseInfo.BaseTypeIdentifier,
            baseInfo.AdditionalBaseTypeIdentifiers,
            primary.OpenBraceToken,
            Concat(parts, p => p.Fields),
            Concat(parts, p => p.Properties),
            Concat(parts, p => p.Events),
            Concat(parts, p => p.Methods),
            primary.CloseBraceToken)
        {
            BaseTypeClauses = baseInfo.BaseTypeClauses,
            SharedBlock = mergedShared,
            BaseConstructorOpenParenthesisToken = baseInfo.BaseConstructorOpenParenthesisToken,
            BaseConstructorArguments = baseInfo.BaseConstructorArguments,
            BaseConstructorCloseParenthesisToken = baseInfo.BaseConstructorCloseParenthesisToken,
            Constructors = Concat(parts, p => p.Constructors),
            Deinitializer = deinit,
            NestedTypes = MergePartialNestedTypes(Concat(parts, p => p.NestedTypes), diagnostics),
            TypeParameterList = primary.TypeParameterList,
            RefModifier = parts.Select(p => p.RefModifier).FirstOrDefault(t => t != null),
            UnsafeModifier = parts.Select(p => p.UnsafeModifier).FirstOrDefault(t => t != null),
            PartialModifier = parts.Select(p => p.PartialModifier).FirstOrDefault(t => t != null),
            SealedKeyword = sealedKeyword,
            PartialPartLocations = parts.Select(p => p.Identifier.Location).ToImmutableArray(),
        };

        merged.WithAnnotations(UnionAnnotations(parts));
        return merged;
    }

    private readonly struct BaseClauseInfo
    {
        public BaseClauseInfo(
            SyntaxToken baseColonToken,
            SyntaxToken baseTypeIdentifier,
            ImmutableArray<SyntaxToken> additionalBaseTypeIdentifiers,
            SeparatedSyntaxList<TypeClauseSyntax> baseTypeClauses,
            SyntaxToken baseConstructorOpenParenthesisToken,
            SeparatedSyntaxList<ExpressionSyntax> baseConstructorArguments,
            SyntaxToken baseConstructorCloseParenthesisToken)
        {
            BaseColonToken = baseColonToken;
            BaseTypeIdentifier = baseTypeIdentifier;
            AdditionalBaseTypeIdentifiers = additionalBaseTypeIdentifiers;
            BaseTypeClauses = baseTypeClauses;
            BaseConstructorOpenParenthesisToken = baseConstructorOpenParenthesisToken;
            BaseConstructorArguments = baseConstructorArguments;
            BaseConstructorCloseParenthesisToken = baseConstructorCloseParenthesisToken;
        }

        public SyntaxToken BaseColonToken { get; }

        public SyntaxToken BaseTypeIdentifier { get; }

        public ImmutableArray<SyntaxToken> AdditionalBaseTypeIdentifiers { get; }

        public SeparatedSyntaxList<TypeClauseSyntax> BaseTypeClauses { get; }

        public SyntaxToken BaseConstructorOpenParenthesisToken { get; }

        public SeparatedSyntaxList<ExpressionSyntax> BaseConstructorArguments { get; }

        public SyntaxToken BaseConstructorCloseParenthesisToken { get; }
    }

    private static BaseClauseInfo ResolveStructBaseClause(
        List<StructDeclarationSyntax> parts,
        StructDeclarationSyntax primary,
        string name,
        DiagnosticBag diagnostics)
    {
        var basedParts = parts.Where(p => p.HasBaseType).ToList();

        // Common case: at most one part supplies a base clause — copy it
        // verbatim so binding is byte-for-byte identical to the un-merged part.
        if (basedParts.Count <= 1)
        {
            var bp = basedParts.FirstOrDefault();
            return new BaseClauseInfo(
                bp?.BaseColonToken,
                bp?.BaseTypeIdentifier,
                bp?.AdditionalBaseTypeIdentifiers ?? ImmutableArray<SyntaxToken>.Empty,
                bp?.BaseTypeClauses ?? new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty),
                bp?.BaseConstructorOpenParenthesisToken,
                bp?.BaseConstructorArguments ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
                bp?.BaseConstructorCloseParenthesisToken);
        }

        // GS0481: base-constructor arguments may appear on at most one part.
        StructDeclarationSyntax ctorArgPart = null;
        foreach (var part in basedParts.Where(p => p.HasBaseConstructorArguments))
        {
            if (ctorArgPart == null)
            {
                ctorArgPart = part;
            }
            else
            {
                diagnostics.ReportPartialBaseClauseConflict(part.Identifier.Location, name);
            }
        }

        // GS0481: for classes, a differing FIRST base entry names a different
        // base class. (Structs cannot have a base class, so their first entry is
        // always an interface — union handles those with no conflict.)
        if (primary.IsClass)
        {
            string firstBase = null;
            foreach (var part in basedParts.Where(p => p.BaseTypeClauses.Count > 0))
            {
                var entry = part.BaseTypeClauses[0].DottedName;
                if (firstBase == null)
                {
                    firstBase = entry;
                }
                else if (!string.Equals(firstBase, entry, System.StringComparison.Ordinal))
                {
                    diagnostics.ReportPartialBaseClauseConflict(part.Identifier.Location, name);
                }
            }
        }

        // Union the base type clauses, de-duplicating by textual (dotted) name.
        var seen = new HashSet<string>(System.StringComparer.Ordinal);
        var uniqueClauses = new List<TypeClauseSyntax>();
        foreach (var part in basedParts)
        {
            foreach (var clause in part.BaseTypeClauses)
            {
                if (seen.Add(clause.DottedName))
                {
                    uniqueClauses.Add(clause);
                }
            }
        }

        var mergedClauses = BuildSeparatedList(primary.SyntaxTree, uniqueClauses);

        return new BaseClauseInfo(
            basedParts[0].BaseColonToken,
            baseTypeIdentifier: null,
            ImmutableArray<SyntaxToken>.Empty,
            mergedClauses,
            ctorArgPart?.BaseConstructorOpenParenthesisToken,
            ctorArgPart?.BaseConstructorArguments ?? new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty),
            ctorArgPart?.BaseConstructorCloseParenthesisToken);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Interface merge
    // ─────────────────────────────────────────────────────────────────────────

    private static InterfaceDeclarationSyntax MergeInterfaceGroup(List<InterfaceDeclarationSyntax> parts, DiagnosticBag diagnostics)
    {
        var primary = parts[0];
        var name = primary.Identifier?.Text ?? string.Empty;

        if (!parts.All(p => p.IsPartial))
        {
            foreach (var part in parts.Where(p => !p.IsPartial))
            {
                diagnostics.ReportPartialModifierMissing(part.Identifier.Location, name);
            }
        }

        var accessibilityModifier = ResolveInterfaceAccessibility(parts, name, diagnostics);
        var sealedKeyword = parts.Select(p => p.SealedKeyword).FirstOrDefault(t => t != null);

        // GS0480: identical type-parameter lists.
        var primaryTypeParams = NormalizeNodeText(primary.TypeParameterList);
        foreach (var part in parts.Skip(1).Where(p => NormalizeNodeText(p.TypeParameterList) != primaryTypeParams))
        {
            diagnostics.ReportPartialTypeParameterMismatch(part.Identifier.Location, name);
        }

        // Base interfaces: union across parts, de-duplicating by textual name.
        var basedParts = parts.Where(p => p.HasBaseInterfaces).ToList();
        SyntaxToken baseColon = basedParts.FirstOrDefault()?.BaseColonToken;
        SeparatedSyntaxList<TypeClauseSyntax> mergedBaseInterfaces;
        if (basedParts.Count <= 1)
        {
            mergedBaseInterfaces = basedParts.FirstOrDefault()?.BaseTypeClauses
                ?? new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
        }
        else
        {
            var seen = new HashSet<string>(System.StringComparer.Ordinal);
            var unique = new List<TypeClauseSyntax>();
            foreach (var part in basedParts)
            {
                foreach (var clause in part.BaseTypeClauses)
                {
                    if (seen.Add(clause.DottedName))
                    {
                        unique.Add(clause);
                    }
                }
            }

            mergedBaseInterfaces = BuildSeparatedList(primary.SyntaxTree, unique);
        }

        var merged = new InterfaceDeclarationSyntax(
            primary.SyntaxTree,
            accessibilityModifier,
            primary.TypeKeyword,
            primary.Identifier,
            primary.TypeParameterList,
            sealedKeyword,
            primary.InterfaceKeyword,
            primary.OpenBraceToken,
            Concat(parts, p => p.Properties),
            Concat(parts, p => p.Events),
            Concat(parts, p => p.Methods),
            primary.CloseBraceToken)
        {
            BaseColonToken = baseColon,
            BaseTypeClauses = mergedBaseInterfaces,
            StaticFields = Concat(parts, p => p.StaticFields),
            PartialModifier = parts.Select(p => p.PartialModifier).FirstOrDefault(t => t != null),
            PartialPartLocations = parts.Select(p => p.Identifier.Location).ToImmutableArray(),
        };

        merged.WithAnnotations(UnionAnnotations(parts));
        return merged;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared helpers
    // ─────────────────────────────────────────────────────────────────────────

    private static SyntaxToken ResolveAccessibility(List<StructDeclarationSyntax> parts, string name, DiagnosticBag diagnostics)
    {
        SyntaxToken stated = null;
        foreach (var part in parts.Where(p => p.AccessibilityModifier != null))
        {
            if (stated == null)
            {
                stated = part.AccessibilityModifier;
            }
            else if (!string.Equals(stated.Text, part.AccessibilityModifier.Text, System.StringComparison.Ordinal))
            {
                diagnostics.ReportPartialAccessibilityConflict(part.AccessibilityModifier.Location, name);
            }
        }

        return stated;
    }

    private static SyntaxToken ResolveInterfaceAccessibility(List<InterfaceDeclarationSyntax> parts, string name, DiagnosticBag diagnostics)
    {
        SyntaxToken stated = null;
        foreach (var part in parts.Where(p => p.AccessibilityModifier != null))
        {
            if (stated == null)
            {
                stated = part.AccessibilityModifier;
            }
            else if (!string.Equals(stated.Text, part.AccessibilityModifier.Text, System.StringComparison.Ordinal))
            {
                diagnostics.ReportPartialAccessibilityConflict(part.AccessibilityModifier.Location, name);
            }
        }

        return stated;
    }

    private static void ValidateOpenSealed(List<StructDeclarationSyntax> parts, string name, DiagnosticBag diagnostics)
    {
        var openPart = parts.FirstOrDefault(p => p.OpenModifier != null);
        var sealedPart = parts.FirstOrDefault(p => p.SealedKeyword != null);
        if (openPart != null && sealedPart != null)
        {
            // Report on the second-appearing offender in part order.
            var offender = parts.IndexOf(openPart) > parts.IndexOf(sealedPart) ? openPart : sealedPart;
            diagnostics.ReportPartialOpenSealedConflict(offender.Identifier.Location, name);
        }
    }

    private static void RequireOnEveryPart(
        List<StructDeclarationSyntax> parts,
        System.Func<StructDeclarationSyntax, bool> hasModifier,
        string modifier,
        string name,
        DiagnosticBag diagnostics)
    {
        var withCount = parts.Count(hasModifier);
        if (withCount == 0 || withCount == parts.Count)
        {
            return;
        }

        // Inconsistent: report each part that lacks the modifier.
        foreach (var part in parts.Where(p => !hasModifier(p)))
        {
            diagnostics.ReportPartialModifierMustMatchAllParts(part.Identifier.Location, modifier, name);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Nested partial types
    // ─────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns <paramref name="node"/> with its nested types normalized so that
    /// any <c>partial</c> nested struct/interface split into several parts is
    /// merged into one. The same node instance is returned when nothing changed
    /// (the common case), so a lone declaration without nested partials is passed
    /// through untouched.
    /// </summary>
    private static StructDeclarationSyntax NormalizeNestedTypes(StructDeclarationSyntax node, DiagnosticBag diagnostics)
    {
        if (node.NestedTypes.IsDefaultOrEmpty)
        {
            return node;
        }

        var merged = MergePartialNestedTypes(node.NestedTypes, diagnostics);

        // ImmutableArray<T>.Equals compares the backing-array reference, so this
        // is true only when MergePartialNestedTypes returned the same instance
        // (nothing merged) — assign (and invalidate the cached span) only on a
        // real change.
        if (!merged.Equals(node.NestedTypes))
        {
            node.NestedTypes = merged;
        }

        return node;
    }

    /// <summary>
    /// Merges the <c>partial</c> nested struct/interface declarations within a
    /// container's <c>NestedTypes</c> list, recursively (nested-in-nested).
    /// Non-partial members, enums, and singleton types are preserved in place and
    /// in first-appearance order; when no nested partial group exists the input
    /// array is returned unchanged (reference-equal) so callers can skip mutation.
    /// </summary>
    private static ImmutableArray<MemberSyntax> MergePartialNestedTypes(
        ImmutableArray<MemberSyntax> nested,
        DiagnosticBag diagnostics)
    {
        if (nested.IsDefaultOrEmpty)
        {
            return nested;
        }

        // Group the nested structs and interfaces by name (order-preserving).
        var structGroups = GroupByKey(nested.OfType<StructDeclarationSyntax>(), EmptyPackages);
        var interfaceGroups = GroupByKey(nested.OfType<InterfaceDeclarationSyntax>(), EmptyPackages);

        var mergedStructByName = new Dictionary<string, StructDeclarationSyntax>(System.StringComparer.Ordinal);
        var mergedInterfaceByName = new Dictionary<string, InterfaceDeclarationSyntax>(System.StringComparer.Ordinal);
        foreach (var g in structGroups.Where(g => g.Count > 1 && g.Any(d => d.IsPartial)))
        {
            mergedStructByName[g[0].Identifier?.Text ?? string.Empty] = MergeStructGroup(g, diagnostics);
        }

        foreach (var g in interfaceGroups.Where(g => g.Count > 1 && g.Any(d => d.IsPartial)))
        {
            mergedInterfaceByName[g[0].Identifier?.Text ?? string.Empty] = MergeInterfaceGroup(g, diagnostics);
        }

        // No nested partial group to merge at this level — but a lone nested
        // struct may still contain its OWN nested partials, so recurse into every
        // nested struct (NormalizeNestedTypes mutates it in place) and return the
        // same array instance so the caller skips rebuilding.
        if (mergedStructByName.Count == 0 && mergedInterfaceByName.Count == 0)
        {
            foreach (var s in nested.OfType<StructDeclarationSyntax>())
            {
                NormalizeNestedTypes(s, diagnostics);
            }

            return nested;
        }

        var emittedStruct = new HashSet<string>(System.StringComparer.Ordinal);
        var emittedInterface = new HashSet<string>(System.StringComparer.Ordinal);
        var result = ImmutableArray.CreateBuilder<MemberSyntax>();
        foreach (var member in nested)
        {
            switch (member)
            {
                case StructDeclarationSyntax s:
                    var sName = s.Identifier?.Text ?? string.Empty;
                    if (mergedStructByName.TryGetValue(sName, out var mergedStruct))
                    {
                        if (emittedStruct.Add(sName))
                        {
                            result.Add(mergedStruct);
                        }

                        // Later parts of the same group are dropped (already merged).
                    }
                    else
                    {
                        result.Add(NormalizeNestedTypes(s, diagnostics));
                    }

                    break;

                case InterfaceDeclarationSyntax iface:
                    var iName = iface.Identifier?.Text ?? string.Empty;
                    if (mergedInterfaceByName.TryGetValue(iName, out var mergedIface))
                    {
                        if (emittedInterface.Add(iName))
                        {
                            result.Add(mergedIface);
                        }
                    }
                    else
                    {
                        result.Add(iface);
                    }

                    break;

                default:
                    result.Add(member);
                    break;
            }
        }

        return result.ToImmutable();
    }

    private static readonly IReadOnlyDictionary<SyntaxTree, PackageSymbol> EmptyPackages =
        new Dictionary<SyntaxTree, PackageSymbol>();

    private static SharedBlockSyntax MergeSharedBlocks(SyntaxTree tree, IEnumerable<SharedBlockSyntax> blocks)
    {
        var present = blocks.Where(b => b != null).ToList();
        if (present.Count == 0)
        {
            return null;
        }

        if (present.Count == 1)
        {
            return present[0];
        }

        var first = present[0];
        return new SharedBlockSyntax(
            tree,
            first.SharedKeyword,
            first.OpenBraceToken,
            Concat(present, b => b.Fields),
            Concat(present, b => b.Properties),
            Concat(present, b => b.Events),
            Concat(present, b => b.Methods),
            Concat(present, b => b.InitBlocks),
            first.CloseBraceToken);
    }

    private static ImmutableArray<AnnotationSyntax> UnionAnnotations<T>(List<T> parts)
        where T : MemberSyntax
    {
        var builder = ImmutableArray.CreateBuilder<AnnotationSyntax>();
        foreach (var part in parts)
        {
            if (!part.Annotations.IsDefaultOrEmpty)
            {
                builder.AddRange(part.Annotations);
            }
        }

        return builder.ToImmutable();
    }

    private static ImmutableArray<TItem> Concat<TPart, TItem>(
        IEnumerable<TPart> parts,
        System.Func<TPart, ImmutableArray<TItem>> selector)
    {
        var builder = ImmutableArray.CreateBuilder<TItem>();
        foreach (var part in parts)
        {
            var items = selector(part);
            if (!items.IsDefaultOrEmpty)
            {
                builder.AddRange(items);
            }
        }

        return builder.ToImmutable();
    }

    private static SeparatedSyntaxList<TypeClauseSyntax> BuildSeparatedList(SyntaxTree tree, List<TypeClauseSyntax> nodes)
    {
        var withSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        for (var i = 0; i < nodes.Count; i++)
        {
            withSeparators.Add(nodes[i]);
            if (i < nodes.Count - 1)
            {
                withSeparators.Add(new SyntaxToken(tree, SyntaxKind.CommaToken, 0, ",", null));
            }
        }

        return new SeparatedSyntaxList<TypeClauseSyntax>(withSeparators.ToImmutable());
    }

    private static string NormalizeNodeText(SyntaxNode node)
    {
        if (node?.SyntaxTree?.Text == null)
        {
            return string.Empty;
        }

        var text = node.SyntaxTree.Text.ToString(node.Span);
        return new string(text.Where(c => !char.IsWhiteSpace(c)).ToArray());
    }
}
