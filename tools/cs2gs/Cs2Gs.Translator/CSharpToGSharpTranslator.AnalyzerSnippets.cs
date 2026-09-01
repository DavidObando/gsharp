// <copyright file="CSharpToGSharpTranslator.AnalyzerSnippets.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.Translator.Analyzers;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// ADR-0169 M5, issue #3778: the SNIPPET half of analyzer-test translation.
/// #3777 put the migrated harness on <c>GSharpAnalyzerVerifier</c>, which
/// compiles the source under analysis as <b>G#</b> — so the C# snippets the
/// tests hand it must be translated too, markers and all.
/// </summary>
public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        /// <summary>The diagnostic id carried by snippet-dispatch reports.</summary>
        private const string AnalyzerSnippetDiagnosticId = "CS2GS-ANALYZER-SNIPPET";

        /// <summary>
        /// Translates an analyzer-test snippet in place of the ordinary
        /// string-literal translation.
        /// </summary>
        /// <remarks>
        /// <para>
        /// <b>The dispatch rule.</b> An expression is a snippet exactly when it
        /// is a compile-time constant string that <i>flows into the source
        /// parameter of an analyzer test harness entry point</i> — either as
        /// the initializer of a local that is later passed there, or directly
        /// as that argument. Nothing else in the project is touched.
        /// </para>
        /// <para>
        /// That conjunction is the whole point. "A <c>const string</c> local"
        /// alone would rewrite every constant in the project; "a string
        /// containing <c>[|…|]</c>" alone would miss the nine of sixteen
        /// snippets in <c>test/InternalAnalyzers.Tests</c> that assert NO
        /// diagnostic and therefore carry no marker, and would fire on any
        /// unrelated string that happened to contain the marker digraph. The
        /// harness parameter is the only signal that says "this string will be
        /// compiled as source" — which is precisely what makes translating it
        /// correct, and leaving it alone wrong. Silently rewriting a string
        /// that was never a snippet is the bad failure mode here, so the rule
        /// keys on the one fact that rules it out.
        /// </para>
        /// <para>
        /// <b>Composed snippets.</b> Several tests build the source as
        /// <c>Model + """…"""</c>, where <c>Model</c> is a shared
        /// <c>const string</c> field. Neither operand is a compilable unit, so
        /// the translatable unit is the concatenation: the guard therefore only
        /// ever fires on the <i>whole initializer</i> (never on a sub-operand),
        /// and takes its text from Roslyn's constant folding. The migrated test
        /// consequently carries the folded, translated whole and loses the
        /// shared-<c>Model</c> factoring — the trade #3778 records; a
        /// piecewise scheme would have to translate a fragment that does not
        /// compile on its own.
        /// </para>
        /// <para>
        /// <b>Markers.</b> Re-placement is <c>SnippetTranslator</c>'s job; what
        /// this dispatch owes is loudness. A marker whose text does not survive
        /// translation is dropped and reported as
        /// <c>CS2GS-ANALYZER-SNIPPET</c>; the migrated test then has fewer
        /// markers than the ids its call site passes, so the verifier fails it
        /// with a marker/id count mismatch instead of silently asserting the
        /// wrong span.
        /// </para>
        /// </remarks>
        /// <param name="expression">The expression being translated.</param>
        /// <param name="translated">The G# snippet literal, when this is a snippet.</param>
        /// <returns>True when the expression was translated as a snippet.</returns>
        private bool TryTranslateAnalyzerSnippet(ExpressionSyntax expression, out GExpression translated)
        {
            translated = null;
            if (!this.InAnalyzerApiMode
                || this.context.TranslateAnalyzerSnippet is null
                || !this.IsAnalyzerSnippetSource(expression))
            {
                return false;
            }

            Optional<object> constant = this.context.SemanticModel.GetConstantValue(expression);
            if (!constant.HasValue || constant.Value is not string csharpSnippet)
            {
                string nonConstant = "the analyzer test source flowing into the harness is not a "
                    + "compile-time constant, so it cannot be translated to G#; the migrated test "
                    + "would hand C# to the G# verifier (ADR-0169 M5, issue #3778).";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-snippet",
                    nonConstant,
                    expression.GetLocation(),
                    TranslationSeverity.Unsupported)
                {
                    DiagnosticId = AnalyzerSnippetDiagnosticId,
                });
                return false;
            }

            SnippetTranslationResult result = this.context.TranslateAnalyzerSnippet(csharpSnippet);
            if (result?.GsWithMarkers is null)
            {
                string detail = result is null
                    ? "no snippet translator is configured"
                    : string.Join("; ", result.Diagnostics.Select(d => d.Message).Take(2));
                string failure = $"the analyzer test snippet could not be translated to G#: {detail} "
                    + "(ADR-0169 M5, issue #3778).";
                this.context.Report(new TranslationDiagnostic(
                    "analyzer-snippet",
                    failure,
                    expression.GetLocation(),
                    TranslationSeverity.Unsupported)
                {
                    DiagnosticId = AnalyzerSnippetDiagnosticId,
                });
                return false;
            }

            // Everything the snippet translator noticed — a dropped marker, a
            // namespace collapse — is re-reported HERE, attributed to the call
            // site, so it lands in the migration's own diagnostics rather than
            // being swallowed inside a nested translation the run never sees.
            foreach (TranslationDiagnostic inner in result.Diagnostics)
            {
                if (inner.Severity == TranslationSeverity.Info)
                {
                    continue;
                }

                this.context.Report(new TranslationDiagnostic(
                    "analyzer-snippet",
                    inner.Message,
                    expression.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = AnalyzerSnippetDiagnosticId,
                });
            }

            string note = "analyzer test snippet translated from C# to G# with its [|…|] markers "
                + "re-placed: the migrated harness delegates to GSharpAnalyzerVerifier, which compiles "
                + "the source under analysis as G# (ADR-0169 M5, issue #3778).";

            // Info, not Warning: the substitution itself is the intended
            // behavior and happens once per test, so it is recorded rather than
            // printed. The two things that CHANGE what a migrated test asserts
            // — a dropped marker and a namespace collapse — are the warnings.
            this.context.Report(new TranslationDiagnostic(
                "analyzer-snippet",
                note,
                expression.GetLocation(),
                TranslationSeverity.Info)
            {
                DiagnosticId = AnalyzerSnippetDiagnosticId,
            });

            translated = LiteralExpression.String(result.GsWithMarkers);
            return true;
        }

        /// <summary>
        /// True when <paramref name="expression"/> is the whole source
        /// expression handed to an analyzer test harness entry point — the
        /// initializer of a local later passed as its source argument, or that
        /// argument itself.
        /// </summary>
        /// <param name="expression">The candidate expression.</param>
        /// <returns>True when the expression is an analyzer-test snippet.</returns>
        private bool IsAnalyzerSnippetSource(ExpressionSyntax expression)
        {
            // The literal-at-the-call-site shape the original design assumed.
            // Restricted to a literal or a `+` composition of them: an
            // IDENTIFIER in that position is a reference to the local handled
            // below, and translating the reference instead of its declaration
            // would replace `source` with the snippet text at the call site.
            if (IsStringComposition(expression)
                && expression.Parent is ArgumentSyntax directArgument
                && directArgument.Parent is ArgumentListSyntax directList
                && directList.Parent is InvocationExpressionSyntax directCall
                && this.HarnessSourceArgument(directCall) == directArgument)
            {
                return true;
            }

            // The shape the real tests have (#3778): a local declaration whose
            // value reaches the harness. Only the WHOLE initializer qualifies,
            // so a composed `Model + """…"""` translates as one unit.
            if (expression.Parent is not EqualsValueClauseSyntax equals
                || equals.Parent is not VariableDeclaratorSyntax declarator
                || declarator.Parent is not VariableDeclarationSyntax declaration
                || declaration.Parent is not LocalDeclarationStatementSyntax
                || this.context.GetDeclaredSymbol(declarator) is not ILocalSymbol local)
            {
                return false;
            }

            SyntaxNode scope = expression.FirstAncestorOrSelf<BaseMethodDeclarationSyntax>()
                ?? (SyntaxNode)expression.FirstAncestorOrSelf<AccessorDeclarationSyntax>();
            if (scope is null)
            {
                return false;
            }

            foreach (InvocationExpressionSyntax call in scope.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (this.HarnessSourceArgument(call) is not { } argument)
                {
                    continue;
                }

                if (SymbolEqualityComparer.Default.Equals(
                    this.context.GetSymbolInfo(argument.Expression).Symbol,
                    local))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// True when <paramref name="expression"/> is spelled as a string
        /// literal or a <c>+</c> composition of string-composition operands —
        /// the syntactic shape of an embedded snippet, as opposed to a
        /// reference to something holding one.
        /// </summary>
        /// <param name="expression">The candidate expression.</param>
        /// <returns>True when the expression is spelled out as string text.</returns>
        private static bool IsStringComposition(ExpressionSyntax expression)
            => expression switch
            {
                LiteralExpressionSyntax literal => literal.IsKind(SyntaxKind.StringLiteralExpression)
                    || literal.IsKind(SyntaxKind.Utf8StringLiteralExpression),
                BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.AddExpression) =>
                    IsStringComposition(binary.Left) || IsStringComposition(binary.Right),
                ParenthesizedExpressionSyntax parenthesized => IsStringComposition(parenthesized.Expression),
                _ => false,
            };

        /// <summary>
        /// Returns the argument bound to the source (second) parameter of an
        /// analyzer test harness entry point, or null when
        /// <paramref name="call"/> does not target one.
        /// </summary>
        /// <param name="call">The candidate invocation.</param>
        /// <returns>The source argument, or null.</returns>
        private ArgumentSyntax HarnessSourceArgument(InvocationExpressionSyntax call)
        {
            if (this.context.GetSymbolInfo(call).Symbol is not IMethodSymbol method
                || !AnalyzerProjectDetector.IsAnalyzerTestHarnessEntry(method.OriginalDefinition))
            {
                return null;
            }

            string sourceParameterName = method.OriginalDefinition.Parameters[1].Name;
            IReadOnlyList<ArgumentSyntax> arguments = call.ArgumentList.Arguments;
            ArgumentSyntax named = arguments.FirstOrDefault(
                argument => argument.NameColon?.Name.Identifier.ValueText == sourceParameterName);
            if (named is not null)
            {
                return named;
            }

            return arguments.Count > 1 && arguments[1].NameColon is null && arguments[0].NameColon is null
                ? arguments[1]
                : null;
        }
    }
}
