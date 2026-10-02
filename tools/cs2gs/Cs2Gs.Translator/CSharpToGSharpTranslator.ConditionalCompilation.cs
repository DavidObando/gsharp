// <copyright file="CSharpToGSharpTranslator.ConditionalCompilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// How the translator treats a C# <c>#if</c> or <c>#elif</c> directive.
/// </summary>
public enum ConditionalCompilationPolicy
{
    /// <summary>
    /// Every <c>#if</c> and <c>#elif</c> is an unsupported construct, which
    /// fails the Translate stage. This is the default.
    /// </summary>
    Reject,

    /// <summary>
    /// Every <c>#if</c> and <c>#elif</c> is reported as a non-fatal warning and
    /// the arm Roslyn parsed as active is translated. Only for a pinned
    /// external corpus that cs2gs cannot edit; the warning names each site.
    /// </summary>
    Warn,
}

/// <summary>
/// Conditional compilation (<c>#if</c>/<c>#elif</c>) has no G# form, by design.
/// </summary>
/// <remarks>
/// Roslyn parses a document under one set of preprocessor symbols, so the
/// inactive arm of an <c>#if</c> reaches the translator only as disabled text.
/// Translating the active arm would keep one configuration's behavior and
/// drop the other's without any notice. That happened to a Release-only
/// assertion in the self-migrated Runtime.Channels tests. Every <c>#if</c> and
/// <c>#elif</c> is therefore reported, including those inside inactive arms.
/// <c>#else</c> and <c>#endif</c> only occur with an <c>#if</c> and are
/// covered by its report.
/// </remarks>
public sealed partial class CSharpToGSharpTranslator
{
    /// <summary>
    /// The diagnostic id for a C# <c>#if</c> or <c>#elif</c> directive. An error
    /// under <see cref="ConditionalCompilationPolicy.Reject"/>, and a forwarded
    /// non-fatal warning under <see cref="ConditionalCompilationPolicy.Warn"/>.
    /// </summary>
    public const string ConditionalCompilationDiagnosticId = "CS2GS-CONDITIONAL-COMPILATION";

    /// <summary>
    /// Gets or sets how <c>#if</c> and <c>#elif</c> directives are reported.
    /// Defaults to <see cref="ConditionalCompilationPolicy.Reject"/>.
    /// </summary>
    public ConditionalCompilationPolicy ConditionalCompilation { get; set; }

    /// <summary>
    /// Builds the message for one conditional directive.
    /// </summary>
    /// <param name="directive">The <c>#if</c> or <c>#elif</c> directive.</param>
    /// <returns>The message, naming the directive and its condition.</returns>
    public static string ConditionalCompilationMessage(ConditionalDirectiveTriviaSyntax directive)
    {
        string keyword = directive.IsKind(SyntaxKind.ElifDirectiveTrivia) ? "#elif" : "#if";
        return $"'{keyword} {directive.Condition}': G# has no conditional compilation. "
            + "cs2gs would translate only the arm active under this build's preprocessor "
            + "symbols and silently drop the others. Rewrite it as a runtime check, or "
            + "delete the arm that is not needed.";
    }

    private static void ReportConditionalCompilation(
        CompilationUnitSyntax root,
        TranslationContext context,
        ConditionalCompilationPolicy policy)
    {
        foreach (SyntaxTrivia trivia in root.DescendantTrivia(descendIntoTrivia: true))
        {
            if (!trivia.IsKind(SyntaxKind.IfDirectiveTrivia) && !trivia.IsKind(SyntaxKind.ElifDirectiveTrivia))
            {
                continue;
            }

            if (trivia.GetStructure() is not ConditionalDirectiveTriviaSyntax directive)
            {
                continue;
            }

            string message = ConditionalCompilationMessage(directive);
            if (policy == ConditionalCompilationPolicy.Warn)
            {
                context.Report(new TranslationDiagnostic(
                    directive.Kind().ToString(),
                    message,
                    directive.GetLocation(),
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = ConditionalCompilationDiagnosticId,
                    Classification = UnsupportedClassification.ByDesign,
                    Rationale = Coverage.UnsupportedRationale.Preprocessor,
                });
            }
            else
            {
                context.ReportUnsupported(directive, message, ConditionalCompilationDiagnosticId);
            }
        }
    }
}
