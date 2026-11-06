// <copyright file="CSharpToGSharpTranslator.PragmaSuppressions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import System.Runtime.CompilerServices

/// Issues #3820 / #3824, ADR-0175: carries C# `#pragma warning
/// disable/restore` regions naming a G# analyzer diagnostic (`GSA####`)
/// across into the migrated tree as `@SuppressDiagnostic("GSA####")`
/// annotations.
///
/// Only `GSA` identifiers are translated. Every other identifier family in
/// the corpus names an analyzer that does not run on G# at all — StyleCop
/// (`SA####`), the C# compiler (`CS####`), and the Roslyn ecosystem
/// (`CA####`, `IDE####`, `VSTHRD###`, `RS####`) — so
/// carrying them would emit annotations that suppress nothing. The one exception
/// (issue #4422): CS8600, CS8601, CS8604 and CS8620, the csc nullability warnings that
/// gsc reports at a by-reference argument as GS0612, translate to
/// `@SuppressDiagnostic("GS0612")`.
partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private sealed class CachedPragmaDirective {
            init(
                spanStart int32,
                isDisable bool,
                isRestoreAll bool,
                ids List[string],
                gsaOnlyIds List[string],
                directive PragmaWarningDirectiveTriviaSyntax
            ) {
                SpanStart = spanStart
                IsDisable = isDisable
                IsRestoreAll = isRestoreAll
                Ids = ids
                GsaOnlyIds = gsaOnlyIds
                Directive = directive
            }

            prop SpanStart int32 {
                get;
            }

            prop IsDisable bool {
                get;
            }

            prop IsRestoreAll bool {
                get;
            }

            prop Ids List[string] {
                get;
            }

            prop GsaOnlyIds List[string] {
                get;
            }

            prop Directive PragmaWarningDirectiveTriviaSyntax {
                get;
            }
        }

        private let consumedGsaPragmas HashSet[(Microsoft.CodeAnalysis.SyntaxTree, int32, string)] = HashSet[
            (Microsoft.CodeAnalysis.SyntaxTree, int32, string)
        ]()
        private let droppedGsaPragmas HashSet[(Microsoft.CodeAnalysis.SyntaxTree, int32, string)] = HashSet[
            (Microsoft.CodeAnalysis.SyntaxTree, int32, string)
        ]()
        private let translatedAggregateParts Dictionary[Microsoft.CodeAnalysis.SyntaxTree, List[TextSpan]] = Dictionary[
            Microsoft.CodeAnalysis.SyntaxTree,
            List[TextSpan]
        ]()
        private let translatedAggregateTrees List[Microsoft.CodeAnalysis.SyntaxTree] = List[
            Microsoft.CodeAnalysis.SyntaxTree
        ]()
        private let skippedAggregateParts Dictionary[Microsoft.CodeAnalysis.SyntaxTree, List[TextSpan]] = Dictionary[
            Microsoft.CodeAnalysis.SyntaxTree,
            List[TextSpan]
        ]()

        internal func RecordTranslatedAggregatePart(node TypeDeclarationSyntax) {
            let tree = node.SyntaxTree
            if !this.translatedAggregateParts.TryGetValue(tree, out var spans) {
                spans = List[TextSpan]()
                this.translatedAggregateParts[tree] = spans
                this.translatedAggregateTrees.Add(tree)
            }
            spans.Add(node.Span)
        }

        internal func RecordSkippedAggregatePart(node TypeDeclarationSyntax) {
            let tree = node.SyntaxTree
            if !this.skippedAggregateParts.TryGetValue(tree, out var spans) {
                spans = List[TextSpan]()
                this.skippedAggregateParts[tree] = spans
            }
            spans.Add(node.Span)
        }

        /// Appends a `@SuppressDiagnostic` annotation to
        /// [`translated`](paramref) for every `GSA` identifier whose
        /// `#pragma warning disable` region covers the whole of
        /// [`source`](paramref).
        /// @param translated The translated G# member.
        /// @param source The C# member declaration it came from.
        internal func AttachPragmaSuppressions(translated GMember, source MemberDeclarationSyntax?) {
            if source == nil {
                return
            }
            let ids = CoveringGsaSuppressions(source, out var activeDirectives, out var interruptedDirectives)
            for interrupted in interruptedDirectives {
                if !activeDirectives.ContainsKey(interrupted.Id) &&
                    !IsInterruptionHandledInDescendantBlock(
                    source,
                    interrupted.DisableStart,
                    interrupted.InterruptionPosition
                ) {
                    this.droppedGsaPragmas.Add((source.SyntaxTree, interrupted.DisableStart, interrupted.Id))
                }
            }
            let attributes List[AttributeUse]? = GetMemberAttributeList(translated)
            if attributes == nil || ids.Count == 0 {
                return
            }
            this.RecordConsumedGsaPragmas(source.SyntaxTree, activeDirectives)
            attributes.Add(
                AttributeUse(
                    "SuppressDiagnostic",
                    ids.Select((id string) -> AttributeArgument(LiteralExpression.String(id))).ToList()
                )
            )
        }

        internal func RecordConsumedGsaPragmas(
            tree Microsoft.CodeAnalysis.SyntaxTree,
            activeDirectives Dictionary[string, int32]
        ) {
            for entry in activeDirectives {
                if entry.Key.StartsWith("GSA", StringComparison.Ordinal) {
                    this.consumedGsaPragmas.Add((tree, entry.Value, entry.Key))
                }
            }
        }

        internal func RecordDroppedGsaPragmas(
            tree Microsoft.CodeAnalysis.SyntaxTree,
            activeDirectives Dictionary[string, int32]
        ) {
            for entry in activeDirectives {
                if entry.Key.StartsWith("GSA", StringComparison.Ordinal) {
                    this.droppedGsaPragmas.Add((tree, entry.Value, entry.Key))
                }
            }
        }

        /// Issues #4447 / #3824: reports a `CS2GS-PRAGMA-DROPPED` warning for
        /// every `#pragma warning disable GSA####` directive in [`root`](paramref)
        /// (or in a secondary partial-part tree merged into this unit) belonging
        /// to this unit that did not cover a whole member or a statement range
        /// that could be annotated with `@SuppressDiagnostic`, or that partially
        /// cut a construct in half.
        internal func ReportDroppedGsaPragmas(
            root SyntaxNode,
            allTopLevelDeclarations IReadOnlyList[MemberDeclarationSyntax],
            unitDeclarations IReadOnlyList[MemberDeclarationSyntax],
            globalStatements IReadOnlyList[GlobalStatementSyntax],
            hasNativeTopLevelStatements bool,
            packageFilter string?,
            includeGlobalNamespace bool
        ) {
            let rootTree = root.SyntaxTree
            let directives = GetCachedPragmaWarningDirectives(root)
            for var i = 0; i < directives.Count; i++ {
                let cached = directives[i]
                if !cached.IsDisable || cached.GsaOnlyIds.Count == 0 {
                    continue
                }
                for id in cached.GsaOnlyIds {
                    let regionEnd = FindGsaRegionEnd(directives, i, id, root.FullSpan.End)
                    if packageFilter != nil &&
                        !UnitOwnsGsaPragmaRegion(
                        cached.SpanStart,
                        regionEnd,
                        allTopLevelDeclarations,
                        unitDeclarations,
                        globalStatements,
                        hasNativeTopLevelStatements,
                        includeGlobalNamespace
                    ) {
                        continue
                    }
                    if this.IsPragmaRegionSkippedInTree(rootTree, cached.SpanStart, regionEnd) {
                        continue
                    }
                    let key = (rootTree, cached.SpanStart, id)
                    if this.droppedGsaPragmas.Contains(key) || !this.consumedGsaPragmas.Contains(key) {
                        this.ReportDroppedGsaPragmaDirective(cached.Directive, id)
                    }
                }
            }
            for foreignTree in this.translatedAggregateTrees {
                if foreignTree == rootTree {
                    continue
                }
                let foreignSpans = this.translatedAggregateParts[foreignTree]
                let foreignRoot = foreignTree.GetRoot()
                let foreignDirectives = GetCachedPragmaWarningDirectives(foreignRoot)
                for var i = 0; i < foreignDirectives.Count; i++ {
                    let cached = foreignDirectives[i]
                    if !cached.IsDisable || cached.GsaOnlyIds.Count == 0 {
                        continue
                    }
                    for id in cached.GsaOnlyIds {
                        let regionEnd = FindGsaRegionEnd(foreignDirectives, i, id, foreignRoot.FullSpan.End)
                        if !OverlapsAnySpan(foreignSpans, cached.SpanStart, regionEnd) {
                            continue
                        }
                        let key = (foreignTree, cached.SpanStart, id)
                        if this.droppedGsaPragmas.Contains(key) || !this.consumedGsaPragmas.Contains(key) {
                            this.ReportDroppedGsaPragmaDirective(cached.Directive, id)
                        }
                    }
                }
            }
        }

        private func ReportDroppedGsaPragmaDirective(directive PragmaWarningDirectiveTriviaSyntax, id string) {
            let message = "'#pragma warning disable $id' does not cover a whole declaration or statement " +
                "range that G# can annotate with '@SuppressDiagnostic(\"$id\")' and was dropped."
            this.context.Report(
                TranslationDiagnostic(
                    "pragma-suppression",
                    message,
                    directive.GetLocation(),
                    TranslationSeverity.Warning
                ){DiagnosticId = PragmaSuppressionDroppedDiagnosticId}
            )
        }

        private func IsPragmaRegionSkippedInTree(
            tree Microsoft.CodeAnalysis.SyntaxTree,
            regionStart int32,
            regionEnd int32
        ) bool {
            if !this.skippedAggregateParts.TryGetValue(tree, out var skippedSpans) ||
                !OverlapsAnySpan(skippedSpans, regionStart, regionEnd) {
                return false
            }
            if this.translatedAggregateParts.TryGetValue(tree, out var translatedSpans) &&
                OverlapsAnySpan(translatedSpans, regionStart, regionEnd) {
                return false
            }
            return true
        }

        /// Issue #4447: returns the `GSA` identifiers disabled across the
        /// entire span of [`statement`](paramref) that do not already cover an
        /// enclosing member or outer statement, and records any `GSA` directive
        /// that starts or restores mid-statement outside a nested block.
        internal func StatementGsaSuppressions(
            statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax,
            out activeDirectives Dictionary[string, int32]
        ) List[string] {
            activeDirectives = EmptyDirectiveMap
            let root SyntaxNode? = statement.SyntaxTree?.GetRoot()
            let directives = GetCachedPragmaWarningDirectives(root)
            if directives.Count == 0 {
                return EmptyStringList
            }
            let candidates = CoveringSpanSuppressions(
                directives,
                statement.Span,
                includeNullability: false,
                out activeDirectives,
                out var interruptedDirectives
            )
            for interrupted in interruptedDirectives {
                if !IsInterruptionHandledInDescendantBlock(
                    statement,
                    interrupted.DisableStart,
                    interrupted.InterruptionPosition
                ) {
                    this.droppedGsaPragmas.Add((statement.SyntaxTree, interrupted.DisableStart, interrupted.Id))
                }
            }
            if candidates.Count == 0 {
                return candidates
            }
            let inherited = HashSet[string](StringComparer.Ordinal)
            for ancestor in statement.Ancestors() {
                if ancestor is MemberDeclarationSyntax member {
                    for id in CoveringGsaSuppressions(member, out _, out _) {
                        inherited.Add(id)
                    }
                } else if ancestor is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .StatementSyntax ancestorStatement &&
                    (!(ancestorStatement is BlockSyntax) || ancestorStatement.Parent is BlockSyntax) {
                    for id in CoveringSpanSuppressions(
                        directives,
                        ancestorStatement.Span,
                        includeNullability: false,
                        out _,
                        out _
                    ) {
                        inherited.Add(id)
                    }
                }
            }
            if inherited.Count == 0 {
                return candidates
            }
            let filtered = List[string](candidates.Count)
            for id in candidates {
                if inherited.Contains(id) {
                    activeDirectives.Remove(id)
                } else {
                    filtered.Add(id)
                }
            }
            return filtered
        }

        shared {
            private let EmptyCachedPragmaDirectives List[CachedPragmaDirective] = List[CachedPragmaDirective]()
            private let EmptyStringList List[string] = List[string]()
            private let EmptyDirectiveMap Dictionary[string, int32] = Dictionary[string, int32](StringComparer.Ordinal)
            private let CachedDirectivesByRoot ConditionalWeakTable[
                SyntaxNode,
                List[CachedPragmaDirective]
            ] = ConditionalWeakTable[SyntaxNode, List[CachedPragmaDirective]]()

            // Issue #4422: CS8600 (possible null converted to a non-null type),
            // CS8601 (possible null reference assignment), CS8604 (possible null
            // argument, the `in` direction) and CS8620 (nullability
            // differs in a nested type argument) — the csc warnings that match
            // gsc's GS0612 at a by-reference argument.
            private let CSharpNullabilityIdsForGs0612 HashSet[string] = HashSet[string](StringComparer.Ordinal){
                "CS8600",
                "CS8601",
                "CS8604",
                "CS8620"
            }

            private func GetMemberAttributeList(translated GMember?) List[AttributeUse]? {
                let declared IReadOnlyList[AttributeUse]? = switch translated {
                    case m is MethodDeclaration: m.Attributes
                    case p is PropertyDeclaration: p.Attributes
                    case f is FieldDeclaration: f.Attributes
                    case c is ConstructorDeclaration: c.Attributes
                    case e is EventDeclaration: e.Attributes
                    case d is DestructorDeclaration: d.Attributes
                    default: default(IReadOnlyList[AttributeUse]?)
                }
                return declared as List[AttributeUse]
            }

            /// Issue #4422: puts the GS0612 suppressions that a member's
            /// statement-free code collected ([`suppressions`](paramref)) on
            /// the translated member. Only a member with no statement block at all
            /// — an expression-bodied method, property or operator, or an
            /// initializer — qualifies: its body IS the one expression the C#
            /// `!` covered, so the member scope is no wider. A member with a
            /// block got its suppressions from its statements; anything left over
            /// (a constructor initializer beside a body) is dropped rather than
            /// widened over the body. The set is cleared either way.
            /// @param translated The translated G# member, or null.
            /// @param source The C# member declaration it came from.
            /// @param suppressions The collected identifiers.
            internal func AttachExpressionBodySuppressions(
                translated GMember?,
                source MemberDeclarationSyntax?,
                suppressions HashSet[string]
            ) {
                if suppressions.Count == 0 {
                    return
                }
                let declared IReadOnlyList[AttributeUse]? = switch translated {
                    case m is MethodDeclaration: m.Attributes
                    case p is PropertyDeclaration: p.Attributes
                    case f is FieldDeclaration: f.Attributes
                    case c is ConstructorDeclaration: c.Attributes
                    default: default(IReadOnlyList[AttributeUse]?)
                }
                if declared is List[AttributeUse]attributes &&
                    source != nil &&
                    !source
                    .DescendantNodes()
                    .OfType[BlockSyntax]()
                    .Any() {
                    attributes.Add(
                        AttributeUse(
                            "SuppressDiagnostic",
                            suppressions
                                .OrderBy((id string) -> id, StringComparer.Ordinal)
                                .Select((id string) -> AttributeArgument(LiteralExpression.String(id)))
                                .ToList()
                        )
                    )
                }
                suppressions.Clear()
            }

            /// Returns the `GSA` identifiers disabled across the entire span of
            /// [`source`](paramref).
            private func CoveringGsaSuppressions(
                source MemberDeclarationSyntax?,
                out activeDirectives Dictionary[string, int32],
                out interruptedDirectives List[(DisableStart int32, Id string, InterruptionPosition int32)]
            ) List[string] {
                activeDirectives = EmptyDirectiveMap
                interruptedDirectives = List[(DisableStart int32, Id string, InterruptionPosition int32)]()
                let root SyntaxNode? = source!!.SyntaxTree?.GetRoot()
                let directives = GetCachedPragmaWarningDirectives(root)
                if directives.Count == 0 {
                    return EmptyStringList
                }
                return CoveringSpanSuppressions(
                    directives,
                    source!!.Span,
                    includeNullability: true,
                    out activeDirectives,
                    out interruptedDirectives
                )
            }

            private func IsInterruptionHandledInDescendantBlock(
                node SyntaxNode,
                disableStart int32,
                interruptionPosition int32
            ) bool {
                if node is BlockSyntax selfBlock {
                    return selfBlock.Span.Start <= interruptionPosition && interruptionPosition <= selfBlock.Span.End
                }
                for block in node.DescendantNodes().OfType[BlockSyntax]() {
                    if block
                        .Span
                        .Start <= disableStart &&
                        disableStart <= block
                        .Span
                        .End &&
                        block
                        .Span
                        .Start <= interruptionPosition &&
                        interruptionPosition <= block
                        .Span
                        .End {
                        return true
                    }
                }
                return false
            }

            private func OverlapsAnySpan(spans List[TextSpan], regionStart int32, regionEnd int32) bool {
                for span in spans {
                    if span.End > regionStart && span.Start < regionEnd {
                        return true
                    }
                }
                return false
            }

            private func FindGsaRegionEnd(
                directives List[CachedPragmaDirective],
                startIndex int32,
                id string,
                fullSpanEnd int32
            ) int32 {
                for var j = startIndex + 1; j < directives.Count; j++ {
                    if directives[j].IsRestoreAll || directives[j].GsaOnlyIds.Contains(id) {
                        return directives[j].SpanStart
                    }
                }
                return fullSpanEnd
            }

            private func UnitOwnsGsaPragmaRegion(
                regionStart int32,
                regionEnd int32,
                allTopLevelDeclarations IReadOnlyList[MemberDeclarationSyntax],
                unitDeclarations IReadOnlyList[MemberDeclarationSyntax],
                globalStatements IReadOnlyList[GlobalStatementSyntax],
                hasNativeTopLevelStatements bool,
                includeGlobalNamespace bool
            ) bool {
                for member in unitDeclarations {
                    if member.Span.End > regionStart && member.Span.Start < regionEnd {
                        return true
                    }
                }
                if hasNativeTopLevelStatements {
                    for globalStmt in globalStatements {
                        if globalStmt.Span.End > regionStart && globalStmt.Span.Start < regionEnd {
                            return true
                        }
                    }
                }
                for member in allTopLevelDeclarations {
                    if member.Span.End > regionStart && member.Span.Start < regionEnd {
                        return false
                    }
                }
                for globalStmt in globalStatements {
                    if globalStmt.Span.End > regionStart && globalStmt.Span.Start < regionEnd {
                        return false
                    }
                }
                return includeGlobalNamespace
            }

            /// Issue #4447: whether the translated statements of
            /// `ordered[startIndex..endIndex]` can be wrapped in a single
            /// `@SuppressDiagnostic("GSA####") { … }` block without hiding a
            /// variable or label used by a later statement in `ordered`, or
            /// shortening a `using` local's lifetime.
            internal func CanWrapSuppressedStatementRun(
                ordered IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax],
                startIndex int32,
                endIndex int32,
                translatedRun List[GStatement]
            ) bool {
                if translatedRun.Count == 0 || translatedRun.TrueForAll((s GStatement) -> s is RawStatement) {
                    return false
                }
                if translatedRun.Any(
                    (s GStatement) -> s is LabeledStatement or LocalFunctionStatement or DeferStatement
                ) {
                    return false
                }
                if endIndex >= ordered.Count - 1 {
                    return true
                }
                let declaredNames = HashSet[string](StringComparer.Ordinal)
                for var i = startIndex; i <= endIndex; i++ {
                    let current = ordered[i]
                    if current is LocalDeclarationStatementSyntax localDecl {
                        if localDecl.UsingKeyword != default(SyntaxToken) {
                            return false
                        }
                        for variable in localDecl.Declaration.Variables {
                            declaredNames.Add(variable.Identifier.ValueText)
                        }
                    } else if current is LocalFunctionStatementSyntax localFunction {
                        declaredNames.Add(localFunction.Identifier.ValueText)
                    } else if current is LabeledStatementSyntax labeled {
                        declaredNames.Add(labeled.Identifier.ValueText)
                    }
                    for node in current.DescendantNodes(
                        (n SyntaxNode) -> n == current ||
                            (
                            !(n is Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) &&
                                !(n is AnonymousFunctionExpressionSyntax)
                        )
                    ) {
                        if node is SingleVariableDesignationSyntax designation {
                            declaredNames.Add(designation.Identifier.ValueText)
                        }
                    }
                }
                if declaredNames.Count == 0 {
                    return true
                }
                for var j = endIndex + 1; j < ordered.Count; j++ {
                    for identifier in ordered[j].DescendantNodesAndSelf().OfType[IdentifierNameSyntax]() {
                        if declaredNames.Contains(identifier.Identifier.ValueText) {
                            return false
                        }
                    }
                }
                return true
            }

            internal func CanAnnotateLocalDeclarationsInPlace(
                statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax,
                translated List[GStatement]
            ) bool {
                if statement is not LocalDeclarationStatementSyntax localDecl ||
                    localDecl.UsingKeyword != default(SyntaxToken) ||
                    DeclaresVariableVisibleAfter(statement) {
                    return false
                }
                var hasLocal = false
                for item in translated {
                    if item is LocalDeclarationStatement{IsUsing: false} {
                        hasLocal = true
                    } else if item is not RawStatement {
                        return false
                    }
                }
                return hasLocal
            }

            internal func MergeSuppressionIds(
                existing IReadOnlyList[string],
                added IReadOnlyList[string]
            ) IReadOnlyList[string] {
                if existing.Count == 0 {
                    return added
                }
                let merged = HashSet[string](existing, StringComparer.Ordinal)
                for id in added {
                    merged.Add(id)
                }
                return merged.OrderBy((id string) -> id, StringComparer.Ordinal).ToList()
            }

            private func GetCachedPragmaWarningDirectives(root SyntaxNode?) List[CachedPragmaDirective] {
                if root == nil || !root.ContainsDirectives {
                    return EmptyCachedPragmaDirectives
                }
                return CachedDirectivesByRoot.GetValue(root, BuildCachedPragmaWarningDirectives)
            }

            private func BuildCachedPragmaWarningDirectives(root SyntaxNode) List[CachedPragmaDirective] {
                let raw = root
                    .DescendantTrivia(descendIntoTrivia: true)
                    .Where((t SyntaxTrivia) -> t.IsKind(SyntaxKind.PragmaWarningDirectiveTrivia))
                    .Select((t SyntaxTrivia) -> cast[PragmaWarningDirectiveTriviaSyntax](t.GetStructure()))
                    .Where((d PragmaWarningDirectiveTriviaSyntax) -> d != nil)
                    .OrderBy((d PragmaWarningDirectiveTriviaSyntax) -> d.SpanStart)
                    .ToList()
                if raw.Count == 0 {
                    return EmptyCachedPragmaDirectives
                }
                let cached = List[CachedPragmaDirective](raw.Count)
                for directive in raw {
                    let isDisable = directive.DisableOrRestoreKeyword.IsKind(SyntaxKind.DisableKeyword)
                    let isRestoreAll = !isDisable && directive.ErrorCodes.Count == 0
                    let ids = DirectiveIds(directive, includeNullability: true).ToList()
                    let gsaOnlyIds = DirectiveIds(directive, includeNullability: false).ToList()
                    if !isRestoreAll && ids.Count == 0 && gsaOnlyIds.Count == 0 {
                        continue
                    }
                    cached.Add(
                        CachedPragmaDirective(directive.SpanStart, isDisable, isRestoreAll, ids, gsaOnlyIds, directive)
                    )
                }
                return if cached.Count == 0 {
                    EmptyCachedPragmaDirectives
                } else {
                    cached
                }
            }

            private func CoveringSpanSuppressions(
                directives List[CachedPragmaDirective],
                span TextSpan,
                includeNullability bool,
                out activeDirectives Dictionary[string, int32],
                out interruptedDirectives List[(DisableStart int32, Id string, InterruptionPosition int32)]
            ) List[string] {
                activeDirectives = Dictionary[string, int32](StringComparer.Ordinal)
                interruptedDirectives = List[(DisableStart int32, Id string, InterruptionPosition int32)]()
                let result = List[string]()
                if directives.Count == 0 {
                    return result
                }
                let state = Dictionary[string, bool](StringComparer.Ordinal)
                let directiveStarts = Dictionary[string, int32](StringComparer.Ordinal)
                let interrupted = HashSet[string](StringComparer.Ordinal)
                for directive in directives {
                    if directive.IsRestoreAll {
                        let keys = state.Keys.OrderBy((k string) -> k, StringComparer.Ordinal).ToList()
                        if directive.SpanStart <= span.Start {
                            for key in keys {
                                state[key] = false
                            }
                            directiveStarts.Clear()
                        } else if directive.SpanStart < span.End {
                            for key in keys {
                                if state[key] {
                                    interrupted.Add(key)
                                    if key.StartsWith("GSA", StringComparison.Ordinal) && directiveStarts.TryGetValue(
                                        key,
                                        out var activeStart
                                    ) {
                                        interruptedDirectives.Add((activeStart, key, directive.SpanStart))
                                    }
                                    state[key] = false
                                    directiveStarts.Remove(key)
                                }
                            }
                        }
                        continue
                    }
                    let disable = directive.IsDisable
                    let ids = if includeNullability {
                        directive.Ids
                    } else {
                        directive.GsaOnlyIds
                    }
                    for id in ids {
                        if directive.SpanStart <= span.Start {
                            state[id] = disable
                            if disable {
                                directiveStarts[id] = directive.SpanStart
                            } else {
                                directiveStarts.Remove(id)
                            }
                        } else if directive.SpanStart < span.End {
                            // A directive inside the span: the region does
                            // not cover it uniformly.
                            interrupted.Add(id)
                            if id.StartsWith("GSA", StringComparison.Ordinal) {
                                if disable {
                                    interruptedDirectives.Add((directive.SpanStart, id, directive.SpanStart))
                                    state[id] = true
                                    directiveStarts[id] = directive.SpanStart
                                } else if state.TryGetValue(id, out var wasActive) &&
                                    wasActive &&
                                    directiveStarts
                                    .TryGetValue(id, out var activeStart) {
                                    interruptedDirectives.Add((activeStart, id, directive.SpanStart))
                                    state[id] = false
                                    directiveStarts.Remove(id)
                                }
                            }
                        }
                    }
                }
                for entry in state {
                    if entry.Value && !interrupted.Contains(entry.Key) {
                        result.Add(entry.Key)
                        if directiveStarts.TryGetValue(entry.Key, out var start) {
                            activeDirectives[entry.Key] = start
                        }
                    }
                }
                result.Sort(StringComparer.Ordinal)
                return result
            }

            /// Yields the `GSA` identifiers a pragma directive names. A bare
            /// `#pragma warning disable` (no identifier list) names none — it
            /// disables everything, which has no faithful scoped G# spelling and is
            /// deliberately not translated.
            /// @param directive The directive.
            /// @param includeNullability Whether to map CS8600/8601/8604/8620 to GS0612.
            /// @returns The GSA identifiers.
            private func DirectiveIds(directive PragmaWarningDirectiveTriviaSyntax, includeNullability bool) sequence[
                string
            ] {
                for code in directive.ErrorCodes {
                    let text string? = switch code {
                        case name is IdentifierNameSyntax: name.Identifier.ValueText
                        case literal is LiteralExpressionSyntax: literal.Token.ValueText
                        default: default(string?)
                    }
                    if text != nil && text.StartsWith("GSA", StringComparison.Ordinal) {
                        yield text
                    } else if includeNullability && text != nil && CSharpNullabilityIdsForGs0612.Contains(text) {
                        // Issue #4422: the csc nullability warnings a by-reference
                        // argument can raise (a nested-type mismatch, a possible
                        // null assigned through the reference, a possible null
                        // converted to a non-null out/ref target) are the ones
                        // gsc reports as GS0612. It is the only G# diagnostic they
                        // map to: gsc's by-value nullability checks are errors,
                        // which a suppression cannot hide.
                        yield "GS0612"
                    }
                }
            }
        }
    }
}
