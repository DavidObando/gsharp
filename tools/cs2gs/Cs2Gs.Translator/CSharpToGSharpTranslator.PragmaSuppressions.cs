// <copyright file="CSharpToGSharpTranslator.PragmaSuppressions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

/// <summary>
/// Issues #3820 / #3824, ADR-0175: carries C# <c>#pragma warning
/// disable/restore</c> regions naming a G# analyzer diagnostic (<c>GSA####</c>)
/// across into the migrated tree as <c>@SuppressDiagnostic("GSA####")</c>
/// annotations.
///
/// Only <c>GSA</c> identifiers are translated. Every other identifier family in
/// the corpus names an analyzer that does not run on G# at all — StyleCop
/// (<c>SA####</c>), the C# compiler (<c>CS####</c>), and the Roslyn ecosystem
/// (<c>CA####</c>, <c>IDE####</c>, <c>VSTHRD###</c>, <c>RS####</c>) — so
/// carrying them would emit annotations that suppress nothing.
/// </summary>
public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// Appends a <c>@SuppressDiagnostic</c> annotation to
        /// <paramref name="translated"/> for every <c>GSA</c> identifier whose
        /// <c>#pragma warning disable</c> region covers the whole of
        /// <paramref name="source"/>.
        /// </summary>
        /// <param name="translated">The translated G# member.</param>
        /// <param name="source">The C# member declaration it came from.</param>
        internal static void AttachPragmaSuppressions(GMember translated, MemberDeclarationSyntax source)
        {
            IReadOnlyList<AttributeUse> declared = translated switch
            {
                MethodDeclaration m => m.Attributes,
                PropertyDeclaration p => p.Attributes,
                FieldDeclaration f => f.Attributes,
                ConstructorDeclaration c => c.Attributes,
                EventDeclaration e => e.Attributes,
                DestructorDeclaration d => d.Attributes,
                _ => null,
            };

            if (declared is not List<AttributeUse> attributes)
            {
                return;
            }

            List<string> ids = CoveringGsaSuppressions(source);
            if (ids.Count == 0)
            {
                return;
            }

            attributes.Add(new AttributeUse(
                "SuppressDiagnostic",
                ids.Select(id => new AttributeArgument(LiteralExpression.String(id))).ToList()));
        }

        /// <summary>
        /// Returns the <c>GSA</c> identifiers disabled across the entire span of
        /// <paramref name="source"/>.
        ///
        /// A region qualifies only when the whole declaration sits inside it:
        /// the last directive naming the identifier at or before the
        /// declaration's start is a <c>disable</c>, and no directive naming it
        /// appears strictly inside the declaration. A region that cuts a
        /// declaration in half therefore contributes nothing rather than
        /// silently widening to the declaration — a widened suppression would
        /// hide violations the C# source still reports.
        /// </summary>
        /// <param name="source">The C# member declaration.</param>
        /// <returns>The identifiers, in first-mention order.</returns>
        private static List<string> CoveringGsaSuppressions(MemberDeclarationSyntax source)
        {
            var result = new List<string>();
            SyntaxNode root = source.SyntaxTree?.GetRoot();
            if (root is null)
            {
                return result;
            }

            // Issue #3831: collected with a type PATTERN rather than
            // `Select(cast).Where(d => d is not null)`. This file is itself in
            // the self-migration corpus, and a sequence-level null filter does
            // not narrow the ELEMENT type: the migrated G# kept
            // `PragmaWarningDirectiveTriviaSyntax?` all the way down, so every
            // member access on a directive below failed to resolve. The
            // pattern narrows, and the loop is the same work.
            var collected = new List<PragmaWarningDirectiveTriviaSyntax>();
            foreach (SyntaxTrivia trivia in root.DescendantTrivia(descendIntoTrivia: true))
            {
                if (trivia.IsKind(SyntaxKind.PragmaWarningDirectiveTrivia)
                    && trivia.GetStructure() is PragmaWarningDirectiveTriviaSyntax pragma)
                {
                    collected.Add(pragma);
                }
            }

            List<PragmaWarningDirectiveTriviaSyntax> directives = collected
                .OrderBy(d => d.SpanStart)
                .ToList();

            if (directives.Count == 0)
            {
                return result;
            }

            TextSpan span = source.Span;
            var state = new Dictionary<string, bool>(StringComparer.Ordinal);
            var interrupted = new HashSet<string>(StringComparer.Ordinal);

            foreach (PragmaWarningDirectiveTriviaSyntax directive in directives)
            {
                bool disable = directive.DisableOrRestoreKeyword.IsKind(SyntaxKind.DisableKeyword);
                foreach (string id in DirectiveIds(directive))
                {
                    if (directive.SpanStart <= span.Start)
                    {
                        state[id] = disable;
                    }
                    else if (directive.SpanStart < span.End)
                    {
                        // A directive inside the declaration: the region does
                        // not cover it uniformly.
                        interrupted.Add(id);
                    }
                }
            }

            foreach (KeyValuePair<string, bool> entry in state)
            {
                if (entry.Value && !interrupted.Contains(entry.Key))
                {
                    result.Add(entry.Key);
                }
            }

            result.Sort(StringComparer.Ordinal);
            return result;
        }

        /// <summary>
        /// Yields the <c>GSA</c> identifiers a pragma directive names. A bare
        /// <c>#pragma warning disable</c> (no identifier list) names none — it
        /// disables everything, which has no faithful scoped G# spelling and is
        /// deliberately not translated.
        /// </summary>
        /// <param name="directive">The directive.</param>
        /// <returns>The GSA identifiers.</returns>
        private static IEnumerable<string> DirectiveIds(PragmaWarningDirectiveTriviaSyntax directive)
        {
            foreach (ExpressionSyntax code in directive.ErrorCodes)
            {
                // Issue #3831: the "names nothing" arm is the empty string, not
                // `null`. A `null` arm makes the whole switch — and with it this
                // iterator's element type — nullable in the migrated G#, where
                // the `text != null` test does not narrow across the `yield`;
                // no identifier starts with "GSA" for the empty string either.
                string text = code switch
                {
                    IdentifierNameSyntax name => name.Identifier.ValueText,
                    LiteralExpressionSyntax literal => literal.Token.ValueText,
                    _ => string.Empty,
                };

                if (text.StartsWith("GSA", StringComparison.Ordinal))
                {
                    yield return text;
                }
            }
        }
    }
}
