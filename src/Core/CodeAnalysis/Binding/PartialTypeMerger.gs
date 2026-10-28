// <copyright file="PartialTypeMerger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import System.Text

/// ADR-0144 / issue #2201: pre-pass that merges multiple `partial`
/// declarations of the same type (same package + name) into ONE synthetic
/// declaration node before the two-phase shell/body binder runs. Grouping,
/// deterministic part ordering (ADR-0066), and head-consistency validation
/// (GS0475-GS0483) all happen here; the existing
/// `DeclareStructShell`/`BindStructDeclarationBody` (and interface
/// equivalents) then run once per merged node, exactly as they do for a lone
/// declaration. This keeps the body binder, installers, symbols, and emitter
/// untouched: one merged node yields one shell, one symbol, and one TypeDef.
internal shared class PartialTypeMerger {
    private struct BaseClauseInfo {
        init(
            baseColonToken SyntaxToken?,
            baseTypeIdentifier SyntaxToken?,
            additionalBaseTypeIdentifiers ImmutableArray[SyntaxToken?],
            baseTypeClauses GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[TypeClauseSyntax],
            baseConstructorOpenParenthesisToken SyntaxToken?,
            baseConstructorArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
            baseConstructorCloseParenthesisToken SyntaxToken?
        ) {
            BaseColonToken = baseColonToken
            BaseTypeIdentifier = baseTypeIdentifier
            AdditionalBaseTypeIdentifiers = additionalBaseTypeIdentifiers
            BaseTypeClauses = baseTypeClauses
            BaseConstructorOpenParenthesisToken = baseConstructorOpenParenthesisToken
            BaseConstructorArguments = baseConstructorArguments
            BaseConstructorCloseParenthesisToken = baseConstructorCloseParenthesisToken
        }

        prop BaseColonToken SyntaxToken? {
            get;
        }

        prop BaseTypeIdentifier SyntaxToken? {
            get;
        }

        prop AdditionalBaseTypeIdentifiers ImmutableArray[SyntaxToken?] {
            get;
        }

        prop BaseTypeClauses GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[TypeClauseSyntax] {
            get;
        }

        prop BaseConstructorOpenParenthesisToken SyntaxToken? {
            get;
        }

        prop BaseConstructorArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax] {
            get;
        }

        prop BaseConstructorCloseParenthesisToken SyntaxToken? {
            get;
        }
    }

    /// Merges the `partial` struct/class declarations of
    /// [`declarations`](paramref) that share a
    /// `(package, name, arity)` key, leaving lone declarations (and
    /// non-partial duplicate groups) untouched.
    /// @param declarations The top-level struct/class declarations across every tree.
    /// @param packageByTree Maps each syntax tree to its owning package (for the grouping key).
    /// @param diagnostics The bag that receives GS0475-GS0483.
    /// @returns One declaration per group: the merged node for multi-part partial groups, otherwise the
    /// original declarations.
    func MergeStructs(
        declarations IEnumerable[StructDeclarationSyntax],
        packageByTree IReadOnlyDictionary[SyntaxTree, PackageSymbol],
        diagnostics DiagnosticBag
    ) IReadOnlyList[StructDeclarationSyntax] {
        let result = List[StructDeclarationSyntax]()
        for group in GroupByKey(declarations, packageByTree) {
            if group.Count == 1 {
                // A lone declaration is not merged, but it may still contain
                // `partial` NESTED types that must be merged among themselves.
                result.Add(NormalizeNestedTypes(group[0], diagnostics))
                continue
            }
            let anyPartial = group.Any((d StructDeclarationSyntax) -> d.IsPartial)
            if !anyPartial {
                // No part carries `partial` → today's duplicate-name GS0102 in
                // DeclareStructShell fires for the second and later parts. Do
                // not merge or suppress it (but still normalize each one's
                // nested types).
                result.AddRange(group.Select((g StructDeclarationSyntax) -> NormalizeNestedTypes(g, diagnostics)))
                continue
            }
            result.Add(MergeStructGroup(group, diagnostics))
        }
        // ADR-0192 / issue #4301: with every type's parts now concatenated into
        // one declaration, the declaring and implementing parts of each
        // `partial func` are two entries in the same member list — collapse
        // them into one. Runs over EVERY declaration, not just merged ones: a
        // lone `partial class` may carry both parts of a method itself, and a
        // NON-partial type carrying a `partial func` is the GS0608 case the
        // parser cannot detect (the aggregate's own `partial` token is attached
        // only after its member list has been parsed).
        //
        // Normalize never mutates its input; it returns a copy when anything
        // merged, so the parsed tree (reused across compilations) keeps the
        // original parts.
        for var i = 0; i < result.Count; i++ {
            result[i] = PartialMethodMerger.Normalize(result[i], diagnostics)
            // ADR-0195: then put every `shared class` in the shape the binder reads.
            result[i] = SharedClassNormalizer.Normalize(result[i], diagnostics)
        }
        return result
    }

    /// Merges the `partial` interface declarations of
    /// [`declarations`](paramref) that share a
    /// `(package, name, arity)` key, leaving lone declarations (and
    /// non-partial duplicate groups) untouched.
    /// @param declarations The top-level interface declarations across every tree.
    /// @param packageByTree Maps each syntax tree to its owning package (for the grouping key).
    /// @param diagnostics The bag that receives GS0475-GS0483.
    /// @returns One declaration per group: the merged node for multi-part partial groups, otherwise the
    /// original declarations.
    func MergeInterfaces(
        declarations IEnumerable[InterfaceDeclarationSyntax],
        packageByTree IReadOnlyDictionary[SyntaxTree, PackageSymbol],
        diagnostics DiagnosticBag
    ) IReadOnlyList[InterfaceDeclarationSyntax] {
        let result = List[InterfaceDeclarationSyntax]()
        for group in GroupByKey(declarations, packageByTree) {
            if group.Count == 1 {
                result.Add(group[0])
                continue
            }
            let anyPartial = group.Any((d InterfaceDeclarationSyntax) -> d.IsPartial)
            if !anyPartial {
                result.AddRange(group)
                continue
            }
            result.Add(MergeInterfaceGroup(group, diagnostics))
        }
        return result
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Grouping / ordering
    // ─────────────────────────────────────────────────────────────────────────
    private func GroupByKey[T MemberSyntax](
        declarations IEnumerable[T],
        packageByTree IReadOnlyDictionary[SyntaxTree, PackageSymbol]
    ) List[List[T]] {
        // Preserve first-appearance order of the groups for determinism of the
        // returned list.
        //
        // Issue #3907: arity is part of the key. A type is identified by name
        // AND type-parameter count, so `Chan` and `Chan[T]` are two types, not
        // two parts of one — which is what ADR-0174 D12 declares (a non-generic
        // factory host beside the generic channel). Grouping on the name alone
        // merged them, then reported GS0475/GS0480 against a mismatch it had
        // manufactured, and the poisoned type parameter list turned into 172
        // "Type 'T' doesn't exist" downstream. The non-partial path already
        // distinguished the two, so this only brings the partial path in line.
        let order = List[(Package string, Name string, Arity int32)]()
        let groups = Dictionary[(Package string, Name string, Arity int32), List[T]]()
        for decl in declarations {
            let packageName = if packageByTree.TryGetValue(decl.SyntaxTree, out var pkg) {
                pkg.Name
            } else {
                string.Empty
            }
            let name = GetIdentifier(decl)?.Text ?? string.Empty
            let key = (packageName, name, GetArity(decl))
            if !groups.TryGetValue(key, out var list) {
                list = List[T]()
                groups[key] = list
                order.Add(key)
            }
            list.Add(decl)
        }
        let ordered = List[List[T]]()
        for key in order {
            let parts = groups[key]
            // Deterministic part order (ADR-0066): (file path, span start).
            parts.Sort(
                (a T, b T) -> {
                    let fileA = a.SyntaxTree.Text?.FileName ?? string.Empty
                    let fileB = b.SyntaxTree.Text?.FileName ?? string.Empty
                    let byFile = string.CompareOrdinal(fileA, fileB)
                    if byFile != 0 {
                        return byFile
                    }
                    return a.Span.Start.CompareTo(b.Span.Start)
                }
            )
            ordered.Add(parts)
        }
        return ordered
    }

    private func GetIdentifier(decl MemberSyntax) SyntaxToken? -> switch decl {
        case s is StructDeclarationSyntax: s.Identifier
        case i is InterfaceDeclarationSyntax: i.Identifier
        default: default(SyntaxToken?)
    }

    /// The declaration's type-parameter count, which together with the name
    /// identifies the type (issue #3907). A missing list is arity zero.
    /// @param decl The declaration.
    /// @returns The type-parameter count.
    private func GetArity(decl MemberSyntax) int32 -> switch decl {
        case s is StructDeclarationSyntax: s.TypeParameterList?.Parameters.Count ?? 0
        case i is InterfaceDeclarationSyntax: i.TypeParameterList?.Parameters.Count ?? 0
        default: 0
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Struct/class merge
    // ─────────────────────────────────────────────────────────────────────────
    private func MergeStructGroup(
        parts List[StructDeclarationSyntax],
        diagnostics DiagnosticBag
    ) StructDeclarationSyntax {
        let primary = parts[0]
        let name = primary.Identifier?.Text ?? string.Empty
        // GS0475: some — but not all — parts carry `partial`. Report each
        // non-partial part, then merge everything (best effort — avoids a
        // GS0102 cascade on the parts that ARE partial).
        if !parts.All((p StructDeclarationSyntax) -> p.IsPartial) {
            for part in parts.Where((p StructDeclarationSyntax) -> !p.IsPartial) {
                diagnostics.ReportPartialModifierMissing(part.Identifier?.Location ?? default(TextLocation), name)
            }
        }
        // GS0476: aggregate kind (class vs struct) must agree.
        for part in parts.Skip(1).Where((p StructDeclarationSyntax) -> p.IsClass != primary.IsClass) {
            diagnostics.ReportPartialKindMismatch(part.Identifier?.Location ?? default(TextLocation), name)
        }
        let accessibilityModifier = ResolveAccessibility(parts, name, diagnostics)
        ValidateOpenSealed(parts, name, diagnostics)
        let openModifier = parts.Select((p StructDeclarationSyntax) -> p.OpenModifier).FirstOrDefault(
            (t SyntaxToken?) -> t != nil
        )
        let sealedKeyword = parts.Select((p StructDeclarationSyntax) -> p.SealedKeyword).FirstOrDefault(
            (t SyntaxToken?) -> t != nil
        )
        // GS0479: data / inline / ref must appear on every part or none.
        let hasData(StructDeclarationSyntax) -> bool = (part StructDeclarationSyntax) -> part.DataKeyword != nil
        let hasInline(StructDeclarationSyntax) -> bool = (part StructDeclarationSyntax) -> part.InlineKeyword != nil
        let hasRef(StructDeclarationSyntax) -> bool = (part StructDeclarationSyntax) -> part.RefModifier != nil
        RequireOnEveryPart(parts, hasData, "data", name, diagnostics)
        RequireOnEveryPart(parts, hasInline, "inline", name, diagnostics)
        RequireOnEveryPart(parts, hasRef, "ref", name, diagnostics)
        // ADR-0195 / issue #4674: `abstract`, unlike `data`/`inline`/`ref`, needs to
        // appear on only ONE part, as in C# (a modifier on any part applies to the
        // whole type). `shared` is different: it decides what each part's own body
        // MEANS (a `func` in a shared class is a shared member, in any other class
        // an instance member), so every part must say it. GS0479 otherwise.
        let hasShared(StructDeclarationSyntax) -> bool = (part StructDeclarationSyntax) -> part.SharedModifier != nil
        RequireOnEveryPart(parts, hasShared, "shared", name, diagnostics)
        // GS0618 across parts: the parser reports `shared` combined with `open`,
        // `sealed`, `abstract` or `data` on ONE head, but `shared partial class C` in
        // one file and `abstract partial class C` in another would merge into a node
        // with both. Report the conflicting modifier of every part that sits beside
        // a `shared` part (a part carrying both is the parser's).
        if parts.Any((part StructDeclarationSyntax) -> part.SharedModifier != nil) {
            for part in parts.Where((part StructDeclarationSyntax) -> part.SharedModifier == nil) {
                for conflicting in[]SyntaxToken? {
                    part.OpenModifier,
                    part.SealedKeyword,
                    part.AbstractModifier,
                    part.DataKeyword
                } {
                    if conflicting != nil {
                        diagnostics.ReportSharedClassModifierConflict(conflicting.Location, conflicting.Text)
                    }
                }
            }
        }
        // GS0480: identical type-parameter lists (names + arity + constraints).
        let primaryTypeParams = NormalizeNodeText(primary.TypeParameterList)
        var typeParametersMatch = true
        for part in parts.Skip(1).Where(
            (p StructDeclarationSyntax) -> NormalizeNodeText(p.TypeParameterList) != primaryTypeParams
        ) {
            typeParametersMatch = false
            diagnostics.ReportPartialTypeParameterMismatch(part.Identifier?.Location ?? default(TextLocation), name)
        }
        // Primary constructor: at most one part may declare one (GS0482).
        var primaryCtorPart StructDeclarationSyntax? = nil
        for part in parts.Where(
            (p StructDeclarationSyntax) -> p.HasPrimaryConstructor || p.PrimaryConstructorParameters?.Count > 0
        ) {
            if primaryCtorPart == nil {
                primaryCtorPart = part
            } else {
                diagnostics.ReportPartialMultiplePrimaryConstructors(
                    part.Identifier?.Location ?? default(TextLocation),
                    name
                )
            }
        }
        // deinit: at most one across all parts (GS0483).
        var deinit DeinitDeclarationSyntax? = nil
        for part in parts {
            let deinitializer DeinitDeclarationSyntax? = part.Deinitializer
            if deinitializer == nil {
                continue
            }
            if deinit == nil {
                deinit = deinitializer
            } else {
                diagnostics.ReportPartialMultipleDeinit(deinitializer.Location, name)
            }
        }
        // Base clause (GS0481) + union.
        let baseInfo = ResolveStructBaseClause(parts, primary, name, diagnostics)
        let mergedShared = MergeSharedBlocks(
            primary.SyntaxTree,
            parts.Select((p StructDeclarationSyntax) -> p.SharedBlock)
        )
        let primaryIdentifier = primary.Identifier ??
            throw InvalidOperationException("A partial declaration must have an identifier.")
        let merged = StructDeclarationSyntax(
            primary.SyntaxTree,
            accessibilityModifier,
            primary.TypeKeyword,
            primaryIdentifier,
            primary.DataKeyword,
            primary.InlineKeyword,
            openModifier,
            primary.StructKeyword,
            primaryCtorPart?.PrimaryConstructorOpenParenthesisToken,
            primaryCtorPart?.PrimaryConstructorParameters ??
                GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty),
            primaryCtorPart?.PrimaryConstructorCloseParenthesisToken,
            baseInfo.BaseColonToken,
            baseInfo.BaseTypeIdentifier,
            baseInfo.AdditionalBaseTypeIdentifiers,
            primary.OpenBraceToken,
            Concat[StructDeclarationSyntax, FieldDeclarationSyntax](parts, (p StructDeclarationSyntax) -> p.Fields),
            Concat[StructDeclarationSyntax, PropertyDeclarationSyntax](
                parts,
                (p StructDeclarationSyntax) -> p.Properties
            ),
            Concat[StructDeclarationSyntax, EventDeclarationSyntax](parts, (p StructDeclarationSyntax) -> p.Events),
            Concat[StructDeclarationSyntax, FunctionDeclarationSyntax](parts, (p StructDeclarationSyntax) -> p.Methods),
            primary.CloseBraceToken
        ){
            BaseTypeClauses = baseInfo.BaseTypeClauses,
            SharedBlock = mergedShared,
            BaseConstructorOpenParenthesisToken = baseInfo.BaseConstructorOpenParenthesisToken,
            BaseConstructorArguments = baseInfo.BaseConstructorArguments,
            BaseConstructorCloseParenthesisToken = baseInfo.BaseConstructorCloseParenthesisToken,
            Constructors = Concat[StructDeclarationSyntax, ConstructorDeclarationSyntax](
                parts,
                (p StructDeclarationSyntax) -> p.Constructors
            ),
            Deinitializer = deinit,
            NestedTypes = MergePartialNestedTypes(
                Concat[StructDeclarationSyntax, MemberSyntax](parts, (p StructDeclarationSyntax) -> p.NestedTypes),
                diagnostics
            ),
            TypeParameterList = primary.TypeParameterList,
            RefModifier = parts.Select((p StructDeclarationSyntax) -> p.RefModifier).FirstOrDefault(
                (t SyntaxToken?) -> t != nil
            ),
            AbstractModifier = parts.Select((p StructDeclarationSyntax) -> p.AbstractModifier).FirstOrDefault(
                (t SyntaxToken?) -> t != nil
            ),
            SharedModifier = parts.Select((p StructDeclarationSyntax) -> p.SharedModifier).FirstOrDefault(
                (t SyntaxToken?) -> t != nil
            ),
            SharedInitializers = parts.SelectMany(
                func (p StructDeclarationSyntax) IEnumerable[StaticInitializerBlockSyntax] {
                    return p.SharedInitializers
                }
            )
                .ToImmutableArray(),
            UnsafeModifier = parts.Select((p StructDeclarationSyntax) -> p.UnsafeModifier).FirstOrDefault(
                (t SyntaxToken?) -> t != nil
            ),
            PartialModifier = parts.Select((p StructDeclarationSyntax) -> p.PartialModifier).FirstOrDefault(
                (t SyntaxToken?) -> t != nil
            ),
            SealedKeyword = sealedKeyword,
            PartialPartLocations = parts.Select(
                (p StructDeclarationSyntax) -> p.Identifier?.Location ?? default(TextLocation)
            )
                .ToImmutableArray(),
            PartialPartExtents = parts.Select((p StructDeclarationSyntax) -> p.Location).ToImmutableArray(),
            PartialTypeParameterLists = if typeParametersMatch {
                parts
                    .Select((p StructDeclarationSyntax) -> p.TypeParameterList)
                    .OfType[TypeParameterListSyntax]()
                    .ToImmutableArray()
            } else {
                ImmutableArray[TypeParameterListSyntax].Empty
            }
        }
        merged.WithAnnotations(UnionAnnotations(parts))
        return merged
    }

    private func ResolveStructBaseClause(
        parts List[StructDeclarationSyntax],
        primary StructDeclarationSyntax,
        name string,
        diagnostics DiagnosticBag
    ) BaseClauseInfo {
        let basedParts = parts.Where((p StructDeclarationSyntax) -> p.HasBaseType).ToList()
        // Common case: at most one part supplies a base clause — copy it
        // verbatim so binding is byte-for-byte identical to the un-merged part.
        if basedParts.Count <= 1 {
            let bp = basedParts.FirstOrDefault()
            return BaseClauseInfo(
                bp?.BaseColonToken,
                bp?.BaseTypeIdentifier,
                bp?.AdditionalBaseTypeIdentifiers ?? ImmutableArray[SyntaxToken?].Empty,
                bp?.BaseTypeClauses ??
                    GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SeparatedSyntaxList[TypeClauseSyntax](ImmutableArray[SyntaxNode].Empty),
                bp?.BaseConstructorOpenParenthesisToken,
                bp?.BaseConstructorArguments ??
                    GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
                bp?.BaseConstructorCloseParenthesisToken
            )
        }
        // GS0481: base-constructor arguments may appear on at most one part.
        var ctorArgPart StructDeclarationSyntax? = nil
        for part in basedParts.Where((p StructDeclarationSyntax) -> p.HasBaseConstructorArguments) {
            if ctorArgPart == nil {
                ctorArgPart = part
            } else {
                diagnostics.ReportPartialBaseClauseConflict(part.Identifier?.Location ?? default(TextLocation), name)
            }
        }
        // GS0481: for classes, a differing FIRST base entry names a different
        // base class. (Structs cannot have a base class, so their first entry is
        // always an interface — union handles those with no conflict.)
        if primary.IsClass {
            var firstBase string? = nil
            for part in basedParts.Where((p StructDeclarationSyntax) -> p.BaseTypeClauses.Count > 0) {
                let entry = part.BaseTypeClauses[0].DottedName
                if firstBase == nil {
                    firstBase = entry
                } else if !string.Equals(firstBase, entry, StringComparison.Ordinal) {
                    diagnostics.ReportPartialBaseClauseConflict(
                        part.Identifier?.Location ?? default(TextLocation),
                        name
                    )
                }
            }
        }
        // Union the base type clauses, de-duplicating by textual (dotted) name.
        let seen = HashSet[string](StringComparer.Ordinal)
        let uniqueClauses = List[TypeClauseSyntax]()
        for part in basedParts {
            for clause in part.BaseTypeClauses {
                if seen.Add(clause.DottedName) {
                    uniqueClauses.Add(clause)
                }
            }
        }
        let mergedClauses = BuildSeparatedList(primary.SyntaxTree, uniqueClauses)
        return BaseClauseInfo(
            basedParts[0].BaseColonToken,
            baseTypeIdentifier: nil,
            ImmutableArray[SyntaxToken?].Empty,
            mergedClauses,
            ctorArgPart?.BaseConstructorOpenParenthesisToken,
            ctorArgPart?.BaseConstructorArguments ??
                GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty),
            ctorArgPart?.BaseConstructorCloseParenthesisToken
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Interface merge
    // ─────────────────────────────────────────────────────────────────────────
    private func MergeInterfaceGroup(
        parts List[InterfaceDeclarationSyntax],
        diagnostics DiagnosticBag
    ) InterfaceDeclarationSyntax {
        let primary = parts[0]
        let name = primary.Identifier?.Text ?? string.Empty
        if !parts.All((p InterfaceDeclarationSyntax) -> p.IsPartial) {
            for part in parts.Where((p InterfaceDeclarationSyntax) -> !p.IsPartial) {
                diagnostics.ReportPartialModifierMissing(part.Identifier?.Location ?? default(TextLocation), name)
            }
        }
        let accessibilityModifier = ResolveInterfaceAccessibility(parts, name, diagnostics)
        let sealedKeyword = parts.Select((p InterfaceDeclarationSyntax) -> p.SealedKeyword).FirstOrDefault(
            (t SyntaxToken?) -> t != nil
        )
        // GS0480: identical type-parameter lists.
        let primaryTypeParams = NormalizeNodeText(primary.TypeParameterList)
        var typeParametersMatch = true
        for part in parts.Skip(1).Where(
            (p InterfaceDeclarationSyntax) -> NormalizeNodeText(p.TypeParameterList) != primaryTypeParams
        ) {
            typeParametersMatch = false
            diagnostics.ReportPartialTypeParameterMismatch(part.Identifier?.Location ?? default(TextLocation), name)
        }
        // Base interfaces: union across parts, de-duplicating by textual name.
        let basedParts = parts.Where((p InterfaceDeclarationSyntax) -> p.HasBaseInterfaces).ToList()
        let baseColon SyntaxToken? = basedParts.FirstOrDefault()?.BaseColonToken
        var mergedBaseInterfaces GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[TypeClauseSyntax]
        if basedParts.Count <= 1 {
            mergedBaseInterfaces = basedParts.FirstOrDefault()
                ?.BaseTypeClauses ??
                GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[TypeClauseSyntax](ImmutableArray[SyntaxNode].Empty)
        } else {
            let seen = HashSet[string](StringComparer.Ordinal)
            let unique = List[TypeClauseSyntax]()
            for part in basedParts {
                for clause in part.BaseTypeClauses {
                    if seen.Add(clause.DottedName) {
                        unique.Add(clause)
                    }
                }
            }
            mergedBaseInterfaces = BuildSeparatedList(primary.SyntaxTree, unique)
        }
        let primaryIdentifier = primary.Identifier ??
            throw InvalidOperationException("A partial declaration must have an identifier.")
        let merged = InterfaceDeclarationSyntax(
            primary.SyntaxTree,
            accessibilityModifier,
            primary.TypeKeyword,
            primaryIdentifier,
            primary.TypeParameterList,
            sealedKeyword,
            primary.InterfaceKeyword,
            primary.OpenBraceToken,
            Concat[InterfaceDeclarationSyntax, PropertyDeclarationSyntax](
                parts,
                (p InterfaceDeclarationSyntax) -> p.Properties
            ),
            Concat[InterfaceDeclarationSyntax, EventDeclarationSyntax](
                parts,
                (p InterfaceDeclarationSyntax) -> p.Events
            ),
            Concat[InterfaceDeclarationSyntax, FunctionDeclarationSyntax](
                parts,
                (p InterfaceDeclarationSyntax) -> p.Methods
            ),
            primary.CloseBraceToken
        ){
            BaseColonToken = baseColon,
            BaseTypeClauses = mergedBaseInterfaces,
            StaticFields = Concat[InterfaceDeclarationSyntax, FieldDeclarationSyntax](
                parts,
                (p InterfaceDeclarationSyntax) -> p.StaticFields
            ),
            PartialModifier = parts.Select((p InterfaceDeclarationSyntax) -> p.PartialModifier).FirstOrDefault(
                (t SyntaxToken?) -> t != nil
            ),
            PartialPartLocations = parts.Select(
                (p InterfaceDeclarationSyntax) -> p.Identifier?.Location ?? default(TextLocation)
            )
                .ToImmutableArray(),
            PartialPartExtents = parts.Select((p InterfaceDeclarationSyntax) -> p.Location).ToImmutableArray(),
            PartialTypeParameterLists = if typeParametersMatch {
                parts
                    .Select((p InterfaceDeclarationSyntax) -> p.TypeParameterList)
                    .OfType[TypeParameterListSyntax]()
                    .ToImmutableArray()
            } else {
                ImmutableArray[TypeParameterListSyntax].Empty
            }
        }
        ApplyAnnotations(merged, UnionAnnotations(parts))
        return merged
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared helpers
    // ─────────────────────────────────────────────────────────────────────────
    private func ApplyAnnotations(member MemberSyntax, annotations ImmutableArray[AnnotationSyntax]) {
        member.WithAnnotations(annotations)
    }

    private func ResolveAccessibility(
        parts List[StructDeclarationSyntax],
        name string,
        diagnostics DiagnosticBag
    ) SyntaxToken? {
        var stated SyntaxToken? = nil
        for part in parts {
            let modifier SyntaxToken? = part.AccessibilityModifier
            if modifier == nil {
                continue
            }
            if stated == nil {
                stated = modifier
            } else if !string.Equals(stated.Text, modifier.Text, StringComparison.Ordinal) {
                diagnostics.ReportPartialAccessibilityConflict(modifier.Location, name)
            }
        }
        return stated
    }

    private func ResolveInterfaceAccessibility(
        parts List[InterfaceDeclarationSyntax],
        name string,
        diagnostics DiagnosticBag
    ) SyntaxToken? {
        var stated SyntaxToken? = nil
        for part in parts {
            let modifier SyntaxToken? = part.AccessibilityModifier
            if modifier == nil {
                continue
            }
            if stated == nil {
                stated = modifier
            } else if !string.Equals(stated.Text, modifier.Text, StringComparison.Ordinal) {
                diagnostics.ReportPartialAccessibilityConflict(modifier.Location, name)
            }
        }
        return stated
    }

    private func ValidateOpenSealed(parts List[StructDeclarationSyntax], name string, diagnostics DiagnosticBag) {
        let openPart StructDeclarationSyntax? = parts.FirstOrDefault(
            (p StructDeclarationSyntax) -> p.OpenModifier != nil
        )
        let sealedPart StructDeclarationSyntax? = parts.FirstOrDefault(
            (p StructDeclarationSyntax) -> p.SealedKeyword != nil
        )
        if openPart != nil && sealedPart != nil {
            // Report on the second-appearing offender in part order.
            let offender = if parts.IndexOf(openPart) > parts.IndexOf(sealedPart) {
                openPart
            } else {
                sealedPart
            }
            diagnostics.ReportPartialOpenSealedConflict(offender.Identifier?.Location ?? default(TextLocation), name)
        }
    }

    private func RequireOnEveryPart(
        parts List[StructDeclarationSyntax],
        hasModifier(StructDeclarationSyntax) -> bool,
        modifier string,
        name string,
        diagnostics DiagnosticBag
    ) {
        var withCount = 0
        for part in parts {
            if hasModifier(part) {
                withCount++
            }
        }
        if withCount == 0 || withCount == parts.Count {
            return
        }
        // Inconsistent: report each part that lacks the modifier.
        for part in parts.Where((p StructDeclarationSyntax) -> !hasModifier(p)) {
            diagnostics.ReportPartialModifierMustMatchAllParts(
                part.Identifier?.Location ?? default(TextLocation),
                modifier,
                name
            )
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Nested partial types
    // ─────────────────────────────────────────────────────────────────────────
    /// Returns [`node`](paramref) with its nested types normalized so that
    /// any `partial` nested struct/interface split into several parts is
    /// merged into one. The same node instance is returned when nothing changed
    /// (the common case), so a lone declaration without nested partials is passed
    /// through untouched.
    private func NormalizeNestedTypes(node StructDeclarationSyntax, diagnostics DiagnosticBag) StructDeclarationSyntax {
        if node.NestedTypes.IsDefaultOrEmpty {
            return node
        }
        let merged = MergePartialNestedTypes(node.NestedTypes, diagnostics)
        // ImmutableArray<T>.Equals compares the backing-array reference, so this
        // is true only when MergePartialNestedTypes returned the same instance
        // (nothing merged) — assign (and invalidate the cached span) only on a
        // real change.
        if !merged.Equals(node.NestedTypes) {
            node.NestedTypes = merged
        }
        return node
    }

    /// Merges the `partial` nested struct/interface declarations within a
    /// container's `NestedTypes` list, recursively (nested-in-nested).
    /// Non-partial members, enums, and singleton types are preserved in place and
    /// in first-appearance order; when no nested partial group exists the input
    /// array is returned unchanged (reference-equal) so callers can skip mutation.
    private func MergePartialNestedTypes(nested ImmutableArray[MemberSyntax], diagnostics DiagnosticBag) ImmutableArray[
        MemberSyntax
    ] {
        if nested.IsDefaultOrEmpty {
            return nested
        }
        // Group the nested structs and interfaces by name and arity (order-preserving).
        let structGroups = GroupByKey(nested.OfType[StructDeclarationSyntax](), EmptyPackages)
        let interfaceGroups = GroupByKey(nested.OfType[InterfaceDeclarationSyntax](), EmptyPackages)
        // Issue #3907: keyed by (name, arity), matching GroupByKey. On the name
        // alone a nested `Box` and `Box[T]` would collide here — the second
        // merge would overwrite the first and the rebuild below would drop one
        // of the two types outright.
        let mergedStructByName = Dictionary[(Name string, Arity int32), StructDeclarationSyntax]()
        let mergedInterfaceByName = Dictionary[(Name string, Arity int32), InterfaceDeclarationSyntax]()
        for g in structGroups.Where(
            (g List[StructDeclarationSyntax]) -> g.Count > 1 && g.Any((d StructDeclarationSyntax) -> d.IsPartial)
        ) {
            mergedStructByName[(g[0].Identifier?.Text ?? string.Empty, GetArity(g[0]))] = MergeStructGroup(
                g,
                diagnostics
            )
        }
        for g in interfaceGroups.Where(
            (g List[InterfaceDeclarationSyntax]) -> g.Count > 1 && g.Any((d InterfaceDeclarationSyntax) -> d.IsPartial)
        ) {
            mergedInterfaceByName[(g[0].Identifier?.Text ?? string.Empty, GetArity(g[0]))] = MergeInterfaceGroup(
                g,
                diagnostics
            )
        }
        // No nested partial group to merge at this level — but a lone nested
        // struct may still contain its OWN nested partials, so recurse into every
        // nested struct (NormalizeNestedTypes mutates it in place) and return the
        // same array instance so the caller skips rebuilding.
        if mergedStructByName.Count == 0 && mergedInterfaceByName.Count == 0 {
            for s in nested.OfType[StructDeclarationSyntax]() {
                NormalizeNestedTypes(s, diagnostics)
            }
            return nested
        }
        let emittedStruct = HashSet[(Name string, Arity int32)]()
        let emittedInterface = HashSet[(Name string, Arity int32)]()
        let result = ImmutableArray.CreateBuilder[MemberSyntax]()
        for member in nested {
            switch member {
                case s is StructDeclarationSyntax {
                    let sName = (s.Identifier?.Text ?? string.Empty, GetArity(s))
                    if mergedStructByName.TryGetValue(sName, out var mergedStruct) {
                        if emittedStruct.Add(sName) {
                            result.Add(mergedStruct)
                        }
                        // Later parts of the same group are dropped (already merged).

                    } else {
                        result.Add(NormalizeNestedTypes(s, diagnostics))
                    }
                }
                case iface is InterfaceDeclarationSyntax {
                    let iName = (iface.Identifier?.Text ?? string.Empty, GetArity(iface))
                    if mergedInterfaceByName.TryGetValue(iName, out var mergedIface) {
                        if emittedInterface.Add(iName) {
                            result.Add(mergedIface)
                        }
                    } else {
                        result.Add(iface)
                    }
                }
                default {
                    result.Add(member)
                }
            }
        }
        return result.ToImmutable()
    }

    private let EmptyPackages IReadOnlyDictionary[SyntaxTree, PackageSymbol] = Dictionary[SyntaxTree, PackageSymbol]()

    private func MergeSharedBlocks(tree SyntaxTree, blocks IEnumerable[SharedBlockSyntax?]) SharedBlockSyntax? {
        let present = blocks.Where((b SharedBlockSyntax?) -> b != nil).ToList()
        if present.Count == 0 {
            return nil
        }
        if present.Count == 1 {
            return present[0] ?? throw InvalidOperationException("A present shared block cannot be null.")
        }
        let first = present[0] ?? throw InvalidOperationException("A present shared block cannot be null.")
        let nonNullPresent = present.Cast[SharedBlockSyntax]().ToList()
        return SharedBlockSyntax(
            tree,
            first.SharedKeyword,
            first.OpenBraceToken,
            Concat[SharedBlockSyntax, FieldDeclarationSyntax](nonNullPresent, (b SharedBlockSyntax) -> b.Fields),
            Concat[SharedBlockSyntax, PropertyDeclarationSyntax](nonNullPresent, (b SharedBlockSyntax) -> b.Properties),
            Concat[SharedBlockSyntax, EventDeclarationSyntax](nonNullPresent, (b SharedBlockSyntax) -> b.Events),
            Concat[SharedBlockSyntax, FunctionDeclarationSyntax](nonNullPresent, (b SharedBlockSyntax) -> b.Methods),
            Concat[SharedBlockSyntax, StaticInitializerBlockSyntax](
                nonNullPresent,
                (b SharedBlockSyntax) -> b.InitBlocks
            ),
            first.CloseBraceToken
        )
    }

    private func UnionAnnotations[T MemberSyntax](parts List[T]) ImmutableArray[AnnotationSyntax] {
        let builder = ImmutableArray.CreateBuilder[AnnotationSyntax]()
        for part in parts {
            if !part.Annotations.IsDefaultOrEmpty {
                builder.AddRange(part.Annotations)
            }
        }
        return builder.ToImmutable()
    }

    private func Concat[TPart, TItem](
        parts IEnumerable[TPart],
        selector(TPart) -> ImmutableArray[TItem]
    ) ImmutableArray[TItem] {
        let builder = ImmutableArray.CreateBuilder[TItem]()
        for part in parts {
            let items = selector(part)
            if !items.IsDefaultOrEmpty {
                builder.AddRange(items)
            }
        }
        return builder.ToImmutable()
    }

    private func BuildSeparatedList(tree SyntaxTree, nodes List[TypeClauseSyntax]) GSharp
        .Core
        .CodeAnalysis
        .Syntax
        .SeparatedSyntaxList[TypeClauseSyntax] {
        let withSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        for var i = 0; i < nodes.Count; i++ {
            withSeparators.Add(nodes[i])
            if i < nodes.Count - 1 {
                withSeparators.Add(SyntaxToken(tree, SyntaxKind.CommaToken, 0, ",", nil))
            }
        }
        return GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[TypeClauseSyntax](withSeparators.ToImmutable())
    }

    private func NormalizeNodeText(node SyntaxNode?) string {
        if node?.SyntaxTree?.Text == nil {
            return string.Empty
        }
        let text = node!!.SyntaxTree.Text.ToString(node!!.Span)
        let normalized = StringBuilder(text.Length)
        for character in text {
            if !char.IsWhiteSpace(character) {
                normalized.Append(character)
            }
        }
        return normalized.ToString()
    }
}
