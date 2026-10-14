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
                let ids = CoveringGsaSuppressions(source)
                if ids.Count == 0 {
                    return
                }
                attributes.Add(
                    AttributeUse(
                        "SuppressDiagnostic",
                        ids.Select((id string) -> AttributeArgument(LiteralExpression.String(id))).ToList()
                    )
                )
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
            ///
            /// A region qualifies only when the whole declaration sits inside it:
            /// the last directive naming the identifier at or before the
            /// declaration's start is a `disable`, and no directive naming it
            /// appears strictly inside the declaration. A region that cuts a
            /// declaration in half therefore contributes nothing rather than
            /// silently widening to the declaration — a widened suppression would
            /// hide violations the C# source still reports.
            /// @param source The C# member declaration.
            /// @returns The identifiers, in first-mention order.
            private func CoveringGsaSuppressions(source MemberDeclarationSyntax?) List[string] {
                let result = List[string]()
                let root SyntaxNode? = source!!.SyntaxTree?.GetRoot()
                if root == nil {
                    return result
                }
                let directives = root
                    .DescendantTrivia(descendIntoTrivia: true)
                    .Where((t SyntaxTrivia) -> t.IsKind(SyntaxKind.PragmaWarningDirectiveTrivia))
                    .Select((t SyntaxTrivia) -> cast[PragmaWarningDirectiveTriviaSyntax](t.GetStructure()))
                    .Where((d PragmaWarningDirectiveTriviaSyntax) -> d != nil)
                    .OrderBy((d PragmaWarningDirectiveTriviaSyntax) -> d.SpanStart)
                    .ToList()
                if directives.Count == 0 {
                    return result
                }
                let span = source!!.Span
                let state = Dictionary[string, bool](StringComparer.Ordinal)
                let interrupted = HashSet[string](StringComparer.Ordinal)
                for directive in directives {
                    let disable = directive.DisableOrRestoreKeyword.IsKind(SyntaxKind.DisableKeyword)
                    for id in DirectiveIds(directive) {
                        if directive.SpanStart <= span.Start {
                            state[id] = disable
                        } else if directive.SpanStart < span.End {
                            // A directive inside the declaration: the region does
                            // not cover it uniformly.
                            interrupted.Add(id)
                        }
                    }
                }
                for entry in state {
                    if entry.Value && !interrupted.Contains(entry.Key) {
                        result.Add(entry.Key)
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
            /// @returns The GSA identifiers.
            private func DirectiveIds(directive PragmaWarningDirectiveTriviaSyntax) sequence[string] {
                for code in directive.ErrorCodes {
                    let text string? = switch code {
                        case name is IdentifierNameSyntax: name.Identifier.ValueText
                        case literal is LiteralExpressionSyntax: literal.Token.ValueText
                        default: default(string?)
                    }
                    if text != nil && text.StartsWith("GSA", StringComparison.Ordinal) {
                        yield text
                    } else if text != nil && CSharpNullabilityIdsForGs0612.Contains(text) {
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
