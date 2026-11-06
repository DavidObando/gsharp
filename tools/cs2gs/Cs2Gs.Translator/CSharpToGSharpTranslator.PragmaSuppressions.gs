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
        private let consumedGsaPragmas HashSet[(int32, string)] = HashSet[(int32, string)]()
        private let droppedGsaPragmas HashSet[(int32, string)] = HashSet[(int32, string)]()

        /// Appends a `@SuppressDiagnostic` annotation to
        /// [`translated`](paramref) for every `GSA` identifier whose
        /// `#pragma warning disable` region covers the whole of
        /// [`source`](paramref).
        /// @param translated The translated G# member.
        /// @param source The C# member declaration it came from.
        internal func AttachPragmaSuppressions(translated GMember, source MemberDeclarationSyntax?) {
            let declared IReadOnlyList[AttributeUse]? = switch translated {
                case m is MethodDeclaration: m.Attributes
                case p is PropertyDeclaration: p.Attributes
                case f is FieldDeclaration: f.Attributes
                case c is ConstructorDeclaration: c.Attributes
                case e is EventDeclaration: e.Attributes
                case d is DestructorDeclaration: d.Attributes
                default: default(IReadOnlyList[AttributeUse]?)
            }
            if declared is not List[AttributeUse]attributes || source == nil {
                return
            }
            let ids = CoveringGsaSuppressions(source, out var activeDirectives)
            if ids.Count == 0 {
                return
            }
            this.RecordConsumedGsaPragmas(activeDirectives)
            attributes.Add(
                AttributeUse(
                    "SuppressDiagnostic",
                    ids.Select((id string) -> AttributeArgument(LiteralExpression.String(id))).ToList()
                )
            )
        }

        internal func RecordConsumedGsaPragmas(activeDirectives Dictionary[string, int32]) {
            for entry in activeDirectives {
                if entry.Key.StartsWith("GSA", StringComparison.Ordinal) {
                    this.consumedGsaPragmas.Add((entry.Value, entry.Key))
                }
            }
        }

        internal func RecordDroppedGsaPragmas(activeDirectives Dictionary[string, int32]) {
            for entry in activeDirectives {
                if entry.Key.StartsWith("GSA", StringComparison.Ordinal) {
                    this.droppedGsaPragmas.Add((entry.Value, entry.Key))
                }
            }
        }

        /// Issues #4447 / #3824: reports a `CS2GS-PRAGMA-DROPPED` warning for
        /// every `#pragma warning disable GSA####` directive in [`root`](paramref)
        /// that did not cover a whole member or a statement range that could be
        /// annotated with `@SuppressDiagnostic`.
        /// @param root The C# compilation-unit root.
        internal func ReportDroppedGsaPragmas(root SyntaxNode) {
            let directives = CollectPragmaWarningDirectives(root)
            for directive in directives {
                if !directive.DisableOrRestoreKeyword.IsKind(SyntaxKind.DisableKeyword) {
                    continue
                }
                for id in DirectiveIds(directive, includeNullability: false) {
                    let key = (directive.SpanStart, id)
                    if this.droppedGsaPragmas.Contains(key) || !this.consumedGsaPragmas.Contains(key) {
                        let message = "'#pragma warning disable $id' does not cover a whole declaration or statement " +
                            "range that G# can annotate with '@SuppressDiagnostic(\"$id\")' and was dropped."
                        this.context.Report(
                            TranslationDiagnostic(
                                "pragma-suppression",
                                message,
                                directive.GetLocation(),
                                TranslationSeverity.Warning
                            ){DiagnosticId = "CS2GS-PRAGMA-DROPPED"}
                        )
                    }
                }
            }
        }

        shared {
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
            /// [`source`](paramref) (or across the sole expression body of a
            /// block-free member).
            ///
            /// A region qualifies only when the whole declaration (or its sole
            /// expression body) sits inside it: the last directive naming the
            /// identifier at or before the start is a `disable`, and no directive
            /// naming it appears strictly inside the span.
            /// @param source The C# member declaration.
            /// @param activeDirectives Maps each returned ID to the `SpanStart` of the `disable` directive
            /// that enabled it.
            /// @returns The identifiers, sorted in ordinal order.
            private func CoveringGsaSuppressions(
                source MemberDeclarationSyntax?,
                out activeDirectives Dictionary[string, int32]
            ) List[string] {
                activeDirectives = Dictionary[string, int32](StringComparer.Ordinal)
                let root SyntaxNode? = source!!.SyntaxTree?.GetRoot()
                if root == nil {
                    return List[string]()
                }
                let result = CoveringSpanSuppressions(
                    root,
                    source!!.Span,
                    includeNullability: true,
                    out activeDirectives
                )
                if !source!!.DescendantNodes().OfType[BlockSyntax]().Any() {
                    let expressionBody ArrowExpressionClauseSyntax? = source!!
                        .DescendantNodes()
                        .OfType[ArrowExpressionClauseSyntax]()
                        .FirstOrDefault()
                    if expressionBody != nil {
                        for id in CoveringSpanSuppressions(
                            root,
                            expressionBody.Expression.Span,
                            includeNullability: false,
                            out var exprDirectives
                        ) {
                            if !activeDirectives.ContainsKey(id) {
                                result.Add(id)
                                activeDirectives[id] = exprDirectives[id]
                            }
                        }
                        result.Sort(StringComparer.Ordinal)
                    }
                }
                return result
            }

            /// Issue #4447: returns the `GSA` identifiers disabled across the
            /// entire span of [`statement`](paramref) that do not already cover an
            /// enclosing member or outer statement.
            /// @param statement The C# statement inside a block.
            /// @param activeDirectives Maps each returned ID to the `SpanStart` of the `disable` directive
            /// that enabled it.
            /// @returns The statement-scoped GSA identifiers, sorted in ordinal order.
            internal func StatementGsaSuppressions(
                statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax,
                out activeDirectives Dictionary[string, int32]
            ) List[string] {
                activeDirectives = Dictionary[string, int32](StringComparer.Ordinal)
                let root SyntaxNode? = statement.SyntaxTree?.GetRoot()
                if root == nil {
                    return List[string]()
                }
                let candidates = CoveringSpanSuppressions(
                    root,
                    statement.Span,
                    includeNullability: false,
                    out activeDirectives
                )
                if candidates.Count == 0 {
                    return candidates
                }
                let inherited = HashSet[string](StringComparer.Ordinal)
                for ancestor in statement.Ancestors() {
                    if ancestor is MemberDeclarationSyntax member {
                        for id in CoveringGsaSuppressions(member, out _) {
                            inherited.Add(id)
                        }
                    } else if ancestor is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .StatementSyntax ancestorStatement &&
                        (!(ancestorStatement is BlockSyntax) || ancestorStatement.Parent is BlockSyntax) {
                        for id in CoveringSpanSuppressions(
                            root,
                            ancestorStatement.Span,
                            includeNullability: false,
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

            private func CollectPragmaWarningDirectives(root SyntaxNode) List[
                PragmaWarningDirectiveTriviaSyntax
            ] -> root
                .DescendantTrivia(descendIntoTrivia: true)
                .Where((t SyntaxTrivia) -> t.IsKind(SyntaxKind.PragmaWarningDirectiveTrivia))
                .Select((t SyntaxTrivia) -> cast[PragmaWarningDirectiveTriviaSyntax](t.GetStructure()))
                .Where((d PragmaWarningDirectiveTriviaSyntax) -> d != nil)
                .OrderBy((d PragmaWarningDirectiveTriviaSyntax) -> d.SpanStart)
                .ToList()

            private func CoveringSpanSuppressions(
                root SyntaxNode?,
                span TextSpan,
                includeNullability bool,
                out activeDirectives Dictionary[string, int32]
            ) List[string] {
                activeDirectives = Dictionary[string, int32](StringComparer.Ordinal)
                let result = List[string]()
                if root == nil {
                    return result
                }
                let directives = CollectPragmaWarningDirectives(root)
                if directives.Count == 0 {
                    return result
                }
                let state = Dictionary[string, bool](StringComparer.Ordinal)
                let directiveStarts = Dictionary[string, int32](StringComparer.Ordinal)
                let interrupted = HashSet[string](StringComparer.Ordinal)
                for directive in directives {
                    let disable = directive.DisableOrRestoreKeyword.IsKind(SyntaxKind.DisableKeyword)
                    for id in DirectiveIds(directive, includeNullability) {
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
