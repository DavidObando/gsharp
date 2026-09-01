// <copyright file="SnippetTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;

namespace Cs2Gs.Translator.Analyzers;

/// <summary>
/// Translates a C# analyzer-test snippet — a self-contained compilation unit
/// annotated with <c>[|…|]</c> expected-diagnostic markers — into the
/// equivalent G# snippet with the markers re-placed
/// (docs/cs2gs-analyzer-translation.md §Test-harness). Markers are re-placed
/// by ordered exact-text match: analyzer-test markers overwhelmingly wrap
/// expressions whose surface text survives translation verbatim. A marker
/// whose text does not survive is dropped from the output and surfaced as a
/// <c>CS2GS-ANALYZER-SNIPPET</c> warning — loud, never silently misplaced —
/// for the human to re-place during review. Re-placed markers denote
/// expected-diagnostic REGIONS: G#'s syntax shapes differ (e.g. its index
/// node is narrower than C#'s element access), so migrated verifications
/// should assert the diagnostic starts within the marker, or hand-tighten
/// the span during review.
/// </summary>
public static class SnippetTranslator
{
    /// <summary>The diagnostic id carried by unplaceable-marker warnings.</summary>
    public const string SnippetDiagnosticId = "CS2GS-ANALYZER-SNIPPET";

    /// <summary>
    /// Translates <paramref name="csharpWithMarkers"/> to a G# snippet with
    /// re-placed markers.
    /// </summary>
    /// <param name="csharpWithMarkers">The marked C# snippet (a full compilation unit).</param>
    /// <returns>The translation result.</returns>
    public static SnippetTranslationResult Translate(string csharpWithMarkers)
    {
        var markedTexts = new List<MarkedText>();
        string cleanSource = StripMarkers(csharpWithMarkers, markedTexts);

        var diagnostics = new List<TranslationDiagnostic>();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", cleanSource) });
        if (!project.BoundWithoutErrors)
        {
            diagnostics.Add(new TranslationDiagnostic(
                "analyzer-snippet",
                "The C# snippet does not compile: " + string.Join("; ", project.ErrorDiagnostics.Take(3)),
                location: null,
                TranslationSeverity.Unsupported));
            return new SnippetTranslationResult(
                null,
                diagnostics,
                markedTexts.Select(m => m.Text).ToList());
        }

        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) == "Snippet.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
        diagnostics.AddRange(context.Diagnostics);
        ReportNamespaceCollapse(document, diagnostics);

        var unplaced = new List<string>();

        // Occurrence-ORDINAL placement (issue #3778). The previous rule —
        // "search forward from the last marker" — silently mis-places a marker
        // whose text also occurs EARLIER in the translated unit, and a
        // composed snippet (`Model + """…"""`) is exactly that case: the
        // shared model declares `RewriteFieldNode`, so the marker on the
        // per-test override landed on the base method instead. Member order
        // survives translation, so the truthful rule is positional: the Nth
        // occurrence of a marked text in the C# maps to the Nth occurrence of
        // that same text in the G#. Placements are computed against the
        // untouched printed text and applied last, back to front, so inserting
        // one marker cannot move another's index.
        var placements = new List<(int Index, int Length)>();
        foreach (MarkedText marked in markedTexts)
        {
            int ordinal = OccurrenceOrdinal(cleanSource, marked.Text, marked.Start);
            int index = NthOccurrence(printed, marked.Text, ordinal);
            if (index < 0)
            {
                unplaced.Add(marked.Text);
                diagnostics.Add(new TranslationDiagnostic(
                    "analyzer-snippet",
                    $"Marker text '{marked.Text}' does not survive translation verbatim (occurrence {ordinal + 1} not found); re-place the [|…|] marker in the G# snippet by hand.",
                    location: null,
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = SnippetDiagnosticId,
                });
                continue;
            }

            placements.Add((index, marked.Text.Length));
        }

        var result = new StringBuilder(printed);
        foreach ((int index, int length) in placements.OrderByDescending(p => p.Index))
        {
            result.Insert(index + length, "|]");
            result.Insert(index, "[|");
        }

        return new SnippetTranslationResult(result.ToString(), diagnostics, unplaced);
    }

    /// <summary>
    /// A G# compilation unit declares exactly ONE package, so a C# snippet
    /// spanning several namespaces collapses into the first one — every type
    /// silently changes namespace, and a namespace-scoped analyzer rule
    /// (GSA0003, GSA0004) then fires, or fails to fire, on the wrong
    /// declarations. cs2gs's normal pipeline splits such a file per package;
    /// a snippet has nowhere to split to because the verifier takes ONE
    /// source. Surface it as <c>CS2GS-ANALYZER-SNIPPET</c> so the migrated
    /// test's disagreement has a stated cause rather than looking like an
    /// analyzer regression.
    /// </summary>
    /// <param name="document">The loaded snippet document.</param>
    /// <param name="diagnostics">The diagnostic list to append to.</param>
    private static void ReportNamespaceCollapse(
        LoadedDocument document,
        List<TranslationDiagnostic> diagnostics)
    {
        var names = document.SemanticModel.SyntaxTree.GetRoot()
            .DescendantNodes()
            .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BaseNamespaceDeclarationSyntax>()
            .Select(declaration => declaration.Name.ToString())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (names.Count < 2)
        {
            return;
        }

        string message = "the snippet declares " + names.Count + " namespaces ("
            + string.Join(", ", names)
            + ") but a G# compilation unit declares one package, so they collapse into '"
            + names[0] + "'. Namespace-scoped analyzer rules will disagree with the C# "
            + "expectation; split the test or re-express the snippet in one namespace.";
        diagnostics.Add(new TranslationDiagnostic(
            "analyzer-snippet",
            message,
            location: null,
            TranslationSeverity.Warning)
        {
            DiagnosticId = SnippetDiagnosticId,
        });
    }

    /// <summary>
    /// Counts how many non-overlapping occurrences of <paramref name="text"/>
    /// start before <paramref name="start"/> in <paramref name="source"/>.
    /// </summary>
    /// <param name="source">The text to scan.</param>
    /// <param name="text">The occurrence text.</param>
    /// <param name="start">The offset of the occurrence being ranked.</param>
    /// <returns>The zero-based occurrence ordinal.</returns>
    private static int OccurrenceOrdinal(string source, string text, int start)
    {
        var ordinal = 0;
        for (int i = source.IndexOf(text, StringComparison.Ordinal);
             i >= 0 && i < start;
             i = source.IndexOf(text, i + text.Length, StringComparison.Ordinal))
        {
            ordinal++;
        }

        return ordinal;
    }

    /// <summary>
    /// Returns the index of the <paramref name="ordinal"/>-th (zero-based)
    /// non-overlapping occurrence of <paramref name="text"/>, or -1.
    /// </summary>
    /// <param name="source">The text to scan.</param>
    /// <param name="text">The occurrence text.</param>
    /// <param name="ordinal">The zero-based occurrence to find.</param>
    /// <returns>The index, or -1 when there are fewer occurrences.</returns>
    private static int NthOccurrence(string source, string text, int ordinal)
    {
        int index = source.IndexOf(text, StringComparison.Ordinal);
        for (var seen = 0; index >= 0 && seen < ordinal; seen++)
        {
            index = source.IndexOf(text, index + text.Length, StringComparison.Ordinal);
        }

        return index;
    }

    private static string StripMarkers(string source, List<MarkedText> markedTexts)
    {
        var result = new StringBuilder(source.Length);
        var markStarts = new Stack<int>();
        for (int i = 0; i < source.Length; i++)
        {
            if (i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|')
            {
                markStarts.Push(result.Length);
                i++;
                continue;
            }

            if (i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']')
            {
                if (markStarts.Count > 0)
                {
                    int start = markStarts.Pop();
                    markedTexts.Add(new MarkedText(
                        result.ToString(start, result.Length - start),
                        start));
                }

                i++;
                continue;
            }

            result.Append(source[i]);
        }

        return result.ToString();
    }

    /// <summary>One <c>[|…|]</c> marker: its text and its offset in the marker-free C# source.</summary>
    /// <param name="Text">The marked text.</param>
    /// <param name="Start">The offset of the marked text in the stripped source.</param>
    private readonly record struct MarkedText(string Text, int Start);
}
