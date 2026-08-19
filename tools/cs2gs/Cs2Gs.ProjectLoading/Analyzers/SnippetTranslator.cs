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
        var markedTexts = new List<string>();
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
            return new SnippetTranslationResult(null, diagnostics, markedTexts);
        }

        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) == "Snippet.cs");
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
        diagnostics.AddRange(context.Diagnostics);

        var unplaced = new List<string>();
        var result = new StringBuilder(printed);

        // Ordered placement: member order survives translation, so each
        // marker's text is searched after the previous marker's position.
        int cursor = 0;
        foreach (string markedText in markedTexts)
        {
            int index = result.ToString().IndexOf(markedText, cursor, StringComparison.Ordinal);
            if (index < 0)
            {
                unplaced.Add(markedText);
                diagnostics.Add(new TranslationDiagnostic(
                    "analyzer-snippet",
                    $"Marker text '{markedText}' does not survive translation verbatim; re-place the [|…|] marker in the G# snippet by hand.",
                    location: null,
                    TranslationSeverity.Warning)
                {
                    DiagnosticId = SnippetDiagnosticId,
                });
                continue;
            }

            result.Insert(index + markedText.Length, "|]");
            result.Insert(index, "[|");
            cursor = index + markedText.Length + 4;
        }

        return new SnippetTranslationResult(result.ToString(), diagnostics, unplaced);
    }

    private static string StripMarkers(string source, List<string> markedTexts)
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
                    markedTexts.Add(result.ToString(start, result.Length - start));
                }

                i++;
                continue;
            }

            result.Append(source[i]);
        }

        return result.ToString();
    }
}

/// <summary>
/// The result of <see cref="SnippetTranslator.Translate"/>.
/// </summary>
/// <param name="GsWithMarkers">The G# snippet with re-placed markers, or null when the C# snippet did not compile.</param>
/// <param name="Diagnostics">Translation and marker-placement diagnostics.</param>
/// <param name="UnplacedMarkers">The marked texts that could not be re-placed automatically.</param>
public sealed record SnippetTranslationResult(
    string GsWithMarkers,
    IReadOnlyList<TranslationDiagnostic> Diagnostics,
    IReadOnlyList<string> UnplacedMarkers);
