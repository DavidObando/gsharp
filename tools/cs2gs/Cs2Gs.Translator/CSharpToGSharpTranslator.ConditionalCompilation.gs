// <copyright file="CSharpToGSharpTranslator.ConditionalCompilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.Translator.Coverage
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax

/// How the translator treats a C# `#if` or `#elif` directive.
enum ConditionalCompilationPolicy {
    Reject,
    Warn
}

/// Conditional compilation (`#if`/`#elif`) has no G# form, by design.
/// @remarks Roslyn parses a document under one set of preprocessor symbols, so the
/// inactive arm of an `#if` reaches the translator only as disabled text.
/// Translating the active arm would keep one configuration's behavior and
/// drop the other's without any notice. That happened to a Release-only
/// assertion in the self-migrated Runtime.Channels tests. Every `#if` and
/// `#elif` is therefore reported, including those inside inactive arms.
/// `#else` and `#endif` only occur with an `#if` and are
/// covered by its report.
partial class CSharpToGSharpTranslator {
    /// Gets or sets how `#if` and `#elif` directives are reported.
    /// Defaults to (cref:ConditionalCompilationPolicy.Reject).
    prop ConditionalCompilation ConditionalCompilationPolicy

    shared {
        /// The diagnostic id for a C# `#if` or `#elif` directive. An error
        /// under (cref:ConditionalCompilationPolicy.Reject), and a forwarded
        /// non-fatal warning under (cref:ConditionalCompilationPolicy.Warn).
        const ConditionalCompilationDiagnosticId string = "CS2GS-CONDITIONAL-COMPILATION"

        /// Builds the message for one conditional directive.
        /// @param directive The `#if` or `#elif` directive.
        /// @returns The message, naming the directive and its condition.
        func ConditionalCompilationMessage(directive ConditionalDirectiveTriviaSyntax) string {
            let keyword = if directive.IsKind(SyntaxKind.ElifDirectiveTrivia) {
                "#elif"
            } else {
                "#if"
            }
            return "'$keyword ${directive.Condition}': G# has no conditional compilation. " +
                "cs2gs would translate only the arm active under this build's preprocessor " +
                "symbols and silently drop the others. Rewrite it as a runtime check, or " +
                "delete the arm that is not needed."
        }

        private func ReportConditionalCompilation(
            root CompilationUnitSyntax,
            context TranslationContext,
            policy ConditionalCompilationPolicy
        ) {
            for trivia in root.DescendantTrivia(descendIntoTrivia: true) {
                if !trivia.IsKind(SyntaxKind.IfDirectiveTrivia) && !trivia.IsKind(SyntaxKind.ElifDirectiveTrivia) {
                    continue
                }
                if trivia.GetStructure() is not ConditionalDirectiveTriviaSyntax directive {
                    continue
                }
                let message = ConditionalCompilationMessage(directive)
                if policy == ConditionalCompilationPolicy.Warn {
                    context.Report(
                        TranslationDiagnostic(
                            directive.Kind().ToString(),
                            message,
                            directive.GetLocation(),
                            TranslationSeverity.Warning
                        ){
                            DiagnosticId = ConditionalCompilationDiagnosticId,
                            Classification = UnsupportedClassification.ByDesign,
                            Rationale = UnsupportedRationale.Preprocessor
                        }
                    )
                } else {
                    context.ReportUnsupported(directive, message, ConditionalCompilationDiagnosticId)
                }
            }
        }
    }
}
