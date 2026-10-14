// <copyright file="CSharpToGSharpTranslator.AnalyzerSnippets.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.Translator.Analyzers
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Collections.Generic
import System.Linq

/// ADR-0169 M5, issue #3778: the SNIPPET half of analyzer-test translation.
/// #3777 put the migrated harness on `GSharpAnalyzerVerifier`, which
/// compiles the source under analysis as <b>G#</b> — so the C# snippets the
/// tests hand it must be translated too, markers and all.
partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Translates an analyzer-test snippet in place of the ordinary
        /// string-literal translation.
        /// @remarks <b>The dispatch rule.</b> An expression is a snippet exactly when it
        /// is a compile-time constant string that <i>flows into the source
        /// parameter of an analyzer test harness entry point</i> — either as
        /// the initializer of a local that is later passed there, or directly
        /// as that argument. Nothing else in the project is touched.
        ///
        /// That conjunction is the whole point. "A `const string` local"
        /// alone would rewrite every constant in the project; "a string
        /// containing `[|…|]`" alone would miss the nine of sixteen
        /// snippets in `test/InternalAnalyzers.Tests` that assert NO
        /// diagnostic and therefore carry no marker, and would fire on any
        /// unrelated string that happened to contain the marker digraph. The
        /// harness parameter is the only signal that says "this string will be
        /// compiled as source" — which is precisely what makes translating it
        /// correct, and leaving it alone wrong. Silently rewriting a string
        /// that was never a snippet is the bad failure mode here, so the rule
        /// keys on the one fact that rules it out.
        ///
        /// <b>Composed snippets.</b> Several tests build the source as
        /// `Model + """…"""`, where `Model` is a shared
        /// `const string` field. Neither operand is a compilable unit, so
        /// the translatable unit is the concatenation: the guard therefore only
        /// ever fires on the <i>whole initializer</i> (never on a sub-operand),
        /// and takes its text from Roslyn's constant folding. The migrated test
        /// consequently carries the folded, translated whole and loses the
        /// shared-`Model` factoring — the trade #3778 records; a
        /// piecewise scheme would have to translate a fragment that does not
        /// compile on its own.
        ///
        /// <b>Markers.</b> Re-placement is `SnippetTranslator`'s job; what
        /// this dispatch owes is loudness. A marker whose text does not survive
        /// translation is dropped and reported as
        /// `CS2GS-ANALYZER-SNIPPET`; the migrated test then has fewer
        /// markers than the ids its call site passes, so the verifier fails it
        /// with a marker/id count mismatch instead of silently asserting the
        /// wrong span.
        /// @param expression The expression being translated.
        /// @param translated The G# snippet literal, when this is a snippet.
        /// @returns True when the expression was translated as a snippet.
        private func TryTranslateAnalyzerSnippet(expression ExpressionSyntax?, out translated GExpression?) bool {
            translated = nil
            if !this.InAnalyzerApiMode || this.context.TranslateAnalyzerSnippet == nil || !this.IsAnalyzerSnippetSource(
                expression
            ) {
                return false
            }
            let constant = this.context.SemanticModel.GetConstantValue(expression!!)
            if !constant.HasValue || constant.Value is not string csharpSnippet {
                let nonConstant = "the analyzer test source flowing into the harness is not a " +
                    "compile-time constant, so it cannot be translated to G#; the migrated test " +
                    "would hand C# to the G# verifier (ADR-0169 M5, issue #3778)."
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-snippet",
                        nonConstant,
                        expression!!.GetLocation(),
                        TranslationSeverity.Unsupported
                    ){DiagnosticId = AnalyzerSnippetDiagnosticId}
                )
                return false
            }
            let result SnippetTranslationResult? = this.context.TranslateAnalyzerSnippet!!(csharpSnippet)
            if result?.GsWithMarkers == nil {
                let detail = if result == nil {
                    "no snippet translator is configured"
                } else {
                    string.Join("; ", result.Diagnostics.Select((d TranslationDiagnostic) -> d.Message).Take(2))
                }
                let failure = "the analyzer test snippet could not be translated to G#: $detail " +
                    "(ADR-0169 M5, issue #3778)."
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-snippet",
                        failure,
                        expression!!.GetLocation(),
                        TranslationSeverity.Unsupported
                    ){DiagnosticId = AnalyzerSnippetDiagnosticId}
                )
                return false
            }
            // Everything the snippet translator noticed — a dropped marker, a
            // namespace collapse — is re-reported HERE so it lands in the
            // migration's own diagnostics. Bridge sites retain their inner
            // source positions; other notices are attributed to the call site.
            for inner in result!!.Diagnostics {
                if inner.Severity == TranslationSeverity.Info {
                    continue
                }
                if inner.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId {
                    this.context.Report(inner)
                    continue
                }
                // Issue #4632: an #if in the snippet stays a translation
                // error. Downgrading it would keep one arm of the snippet and
                // drop the other without failing anything.
                if inner.DiagnosticId == CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId &&
                    inner.Severity == TranslationSeverity
                    .Unsupported {
                    this.context.Report(
                        TranslationDiagnostic(
                            inner.ConstructKind,
                            "in an analyzer test snippet: " + inner.Message,
                            expression!!.GetLocation(),
                            TranslationSeverity.Unsupported
                        ){
                            DiagnosticId = CSharpToGSharpTranslator.ConditionalCompilationDiagnosticId,
                            Classification = inner.Classification,
                            Rationale = inner.Rationale
                        }
                    )
                    continue
                }
                this.context.Report(
                    TranslationDiagnostic(
                        "analyzer-snippet",
                        inner.Message,
                        expression!!.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = AnalyzerSnippetDiagnosticId}
                )
            }
            let note = "analyzer test snippet translated from C# to G# with its [|…|] markers " +
                "re-placed: the migrated harness delegates to GSharpAnalyzerVerifier, which compiles " +
                "the source under analysis as G# (ADR-0169 M5, issue #3778)."
            // Info, not Warning: the substitution itself is the intended
            // behavior and happens once per test, so it is recorded rather than
            // printed. The two things that CHANGE what a migrated test asserts
            // — a dropped marker and a namespace collapse — are the warnings.
            this.context.Report(
                TranslationDiagnostic("analyzer-snippet", note, expression!!.GetLocation(), TranslationSeverity.Info){
                    DiagnosticId = AnalyzerSnippetDiagnosticId
                }
            )
            translated = LiteralExpression.String(result!!.GsWithMarkers!!)
            return true
        }

        /// True when [`expression`](paramref) is the whole source
        /// expression handed to an analyzer test harness entry point — the
        /// initializer of a local later passed as its source argument, or that
        /// argument itself.
        /// @param expression The candidate expression.
        /// @returns True when the expression is an analyzer-test snippet.
        private func IsAnalyzerSnippetSource(expression ExpressionSyntax?) bool {
            // The literal-at-the-call-site shape the original design assumed.
            // Restricted to a literal or a `+` composition of them: an
            // IDENTIFIER in that position is a reference to the local handled
            // below, and translating the reference instead of its declaration
            // would replace `source` with the snippet text at the call site.
            if IsStringComposition(expression) &&
                expression!!.Parent is ArgumentSyntax directArgument &&
                directArgument.Parent is ArgumentListSyntax directList &&
                directList.Parent is InvocationExpressionSyntax directCall &&
                this.HarnessSourceArgument(directCall) == directArgument {
                return true
            }
            // The shape the real tests have (#3778): a local declaration whose
            // value reaches the harness. Only the WHOLE initializer qualifies,
            // so a composed `Model + """…"""` translates as one unit.
            if expression!!.Parent is not EqualsValueClauseSyntax equals ||
                equals.Parent is not VariableDeclaratorSyntax declarator ||
                declarator.Parent is not VariableDeclarationSyntax declaration ||
                !(declaration.Parent is LocalDeclarationStatementSyntax) ||
                this
                .context
                .GetDeclaredSymbol(declarator) is not ILocalSymbol local {
                return false
            }
            let scope_ SyntaxNode? = expression!!.FirstAncestorOrSelf[BaseMethodDeclarationSyntax]() ??
                cast[SyntaxNode](expression!!.FirstAncestorOrSelf[AccessorDeclarationSyntax]())
            if scope_ == nil {
                return false
            }
            for call in scope_.DescendantNodes().OfType[InvocationExpressionSyntax]() {
                if this.HarnessSourceArgument(call) is not{} argument {
                    continue
                }
                if SymbolEqualityComparer.Default.Equals(
                    this.context.GetSymbolInfo(argument.Expression).Symbol,
                    local
                ) {
                    return true
                }
            }
            return false
        }

        /// Returns the argument bound to the source (second) parameter of an
        /// analyzer test harness entry point, or null when
        /// [`call`](paramref) does not target one.
        /// @param call The candidate invocation.
        /// @returns The source argument, or null.
        private func HarnessSourceArgument(call InvocationExpressionSyntax) ArgumentSyntax? {
            if this
                .context
                .GetSymbolInfo(call)
                .Symbol is not IMethodSymbol method ||
                !AnalyzerProjectDetector.IsAnalyzerTestHarnessEntry(method.OriginalDefinition) {
                return nil
            }
            let sourceParameterName = method.OriginalDefinition.Parameters[1].Name
            let arguments IReadOnlyList[ArgumentSyntax] = call.ArgumentList.Arguments
            let named ArgumentSyntax? = arguments.FirstOrDefault(
                (argument ArgumentSyntax) -> argument.NameColon?.Name.Identifier.ValueText == sourceParameterName
            )
            if named != nil {
                return named
            }
            return if arguments.Count > 1 && arguments[1].NameColon == nil && arguments[0].NameColon == nil {
                arguments[1]
            } else {
                default(ArgumentSyntax?)
            }
        }

        shared {
            /// The diagnostic id carried by snippet-dispatch reports.
            private const AnalyzerSnippetDiagnosticId string = "CS2GS-ANALYZER-SNIPPET"

            /// True when [`expression`](paramref) is spelled as a string
            /// literal or a `+` composition of string-composition operands —
            /// the syntactic shape of an embedded snippet, as opposed to a
            /// reference to something holding one.
            /// @param expression The candidate expression.
            /// @returns True when the expression is spelled out as string text.
            private func IsStringComposition(expression ExpressionSyntax?) bool -> switch expression {
                case literal is LiteralExpressionSyntax: literal.IsKind(SyntaxKind.StringLiteralExpression) ||
                    literal.IsKind(SyntaxKind.Utf8StringLiteralExpression)
                case binary is BinaryExpressionSyntax when binary.IsKind(SyntaxKind.AddExpression): IsStringComposition(
                    binary.Left
                ) ||
                    IsStringComposition(binary.Right)
                case parenthesized is ParenthesizedExpressionSyntax: IsStringComposition(parenthesized.Expression)
                default: false
            }
        }
    }
}
