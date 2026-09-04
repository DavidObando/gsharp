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
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

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
    /// The line separating one emitted G# compilation unit from the next
    /// (issue #3794). MUST equal
    /// <c>GSharpAnalyzerVerifier.UnitSeparator</c>, which is what splits it
    /// back apart; <c>Issue3794AnalyzerSnippetPackageSplitTests</c> asserts the two
    /// spellings agree, because cs2gs cannot reference the G# testing assembly
    /// it emits calls into.
    /// </summary>
    public const string UnitSeparator = "// ---8<--- cs2gs:next-compilation-unit ---";

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

        LoadedDocument document = project.Documents.Single(d => Path.GetFileName(d.FilePath) == "Snippet.cs");

        // Issue #3794: one G# compilation unit declares one `package`, so a
        // snippet spanning several namespaces is emitted as several units
        // joined by UnitSeparator instead of being collapsed into the first
        // package. Collapsing silently moved every declaration, which made a
        // namespace-scoped rule (GSA0003, GSA0004) judge the wrong ones — total
        // detection loss in one migrated test and a false positive in another.
        // Unit order is declaration order, which is what lets the ordinal
        // marker placement below keep working over the concatenation.
        IReadOnlyList<string> packages = CSharpToGSharpTranslator.GetDeclaredPackages(document);
        int unitCount = Math.Max(1, packages.Count);
        var printedUnits = new List<string>(unitCount);
        for (var unitIndex = 0; unitIndex < unitCount; unitIndex++)
        {
            string package = packages.Count > 1 ? packages[unitIndex] : null;
            var translator = new CSharpToGSharpTranslator(
                packageFilter: package,
                includeFileAttributes: unitIndex == 0);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            printedUnits.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)));
            foreach (TranslationDiagnostic reported in context.Diagnostics)
            {
                // The same document is translated once per package, so a
                // diagnostic about a construct outside every filter is raised
                // by every unit; report each distinct one once.
                if (!diagnostics.Any(existing =>
                        string.Equals(existing.Message, reported.Message, StringComparison.Ordinal)))
                {
                    diagnostics.Add(reported);
                }
            }
        }

        string printed = string.Join("\n" + UnitSeparator + "\n", printedUnits);

        var unplaced = new List<string>();
        PredefinedRenaming renaming = PredefinedRenaming.For(document, cleanSource);

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
            int length = marked.Text.Length;

            // Issue #3794: a marker on a DECLARATION's name is placed on a
            // declaration, never on a use. Plain ordinal placement breaks here
            // because translation does not preserve occurrence counts: cs2gs
            // hoists a property initializer into a synthesized constructor, so
            // the migrated `NullableCtorRefs` occurs twice — assignment first,
            // declaration second — and the C#'s single occurrence (ordinal 0)
            // landed on the assignment, moving the expected span off the
            // property the rule actually reports on. Being a declaration name
            // is a fact about the C# node, and "is preceded by a declaration
            // keyword" is the printed G# counterpart, so the two ordinals are
            // counted over declarations only and agree again.
            int index = DeclarationOrdinal(document, marked) is { } declarationOrdinal
                ? NthDeclarationOccurrence(printed, marked.Text, declarationOrdinal)
                : -1;
            if (index < 0)
            {
                index = NthOccurrence(printed, marked.Text, ordinal);
            }

            if (index < 0)
            {
                // Issue #3797: retry against the ONE lexical rename translation
                // applies inside expression text — C#'s predefined type
                // keywords become G#'s width-bearing primitive names, so
                // `typeof(int) != type` prints as `typeof(int32) != type`.
                // The renamed candidate is computed from the marked region's
                // own `PredefinedTypeSyntax` nodes, never by text substitution,
                // so an identifier that merely contains `int` is untouched, and
                // its ordinal is measured in the equally renamed source so a
                // repeated marker still lands on the right occurrence.
                MarkedText renamed = renaming.Rename(marked);
                if (!string.Equals(renamed.Text, marked.Text, StringComparison.Ordinal))
                {
                    int renamedOrdinal = OccurrenceOrdinal(renaming.Source, renamed.Text, renamed.Start);
                    index = NthOccurrence(printed, renamed.Text, renamedOrdinal);
                    length = renamed.Text.Length;
                }
            }

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

            placements.Add((index, length));
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
    /// When <paramref name="marked"/> covers exactly the identifier a C#
    /// declaration is NAMED by, the number of same-named declarations earlier
    /// in the snippet; otherwise <see langword="null"/> (issue #3794).
    /// </summary>
    /// <param name="document">The loaded snippet document.</param>
    /// <param name="marked">The marker.</param>
    /// <returns>The declaration ordinal, or <see langword="null"/>.</returns>
    private static int? DeclarationOrdinal(LoadedDocument document, MarkedText marked)
    {
        var ordinal = 0;
        var isDeclarationName = false;
        foreach (SyntaxToken token in document.GetRoot().DescendantTokens())
        {
            if (!token.IsKind(SyntaxKind.IdentifierToken)
                || !string.Equals(token.ValueText, marked.Text, StringComparison.Ordinal)
                || !IsDeclarationName(token))
            {
                continue;
            }

            if (token.Span.Start == marked.Start && token.Span.Length == marked.Text.Length)
            {
                isDeclarationName = true;
                break;
            }

            ordinal++;
        }

        return isDeclarationName ? ordinal : null;
    }

    /// <summary>
    /// Whether <paramref name="token"/> is the identifier that names its
    /// declaration — a field/local declarator, a property, a method, a type,
    /// a parameter, or an enum member.
    /// </summary>
    /// <param name="token">The candidate identifier token.</param>
    /// <returns>True when the token names a declaration.</returns>
    private static bool IsDeclarationName(SyntaxToken token) =>
        token.Parent switch
        {
            VariableDeclaratorSyntax declarator => declarator.Identifier == token,
            PropertyDeclarationSyntax property => property.Identifier == token,
            MethodDeclarationSyntax method => method.Identifier == token,
            BaseTypeDeclarationSyntax type => type.Identifier == token,
            ParameterSyntax parameter => parameter.Identifier == token,
            EnumMemberDeclarationSyntax member => member.Identifier == token,
            _ => false,
        };

    /// <summary>
    /// The index of the <paramref name="ordinal"/>-th (zero-based) occurrence
    /// of <paramref name="text"/> in <paramref name="source"/> that is spelled
    /// as a G# DECLARATION name — a whole word immediately preceded, on the
    /// same line, by a declaration keyword — or -1.
    /// </summary>
    /// <param name="source">The printed G#.</param>
    /// <param name="text">The declaration name.</param>
    /// <param name="ordinal">The zero-based declaration occurrence to find.</param>
    /// <returns>The index, or -1.</returns>
    private static int NthDeclarationOccurrence(string source, string text, int ordinal)
    {
        var seen = 0;
        for (int i = source.IndexOf(text, StringComparison.Ordinal);
             i >= 0;
             i = source.IndexOf(text, i + text.Length, StringComparison.Ordinal))
        {
            if (!IsWholeWord(source, i, text.Length) || !FollowsDeclarationKeyword(source, i))
            {
                continue;
            }

            if (seen == ordinal)
            {
                return i;
            }

            seen++;
        }

        return -1;
    }

    private static bool IsWholeWord(string source, int index, int length)
        => (index == 0 || !IsIdentifierChar(source[index - 1]))
            && (index + length >= source.Length || !IsIdentifierChar(source[index + length]));

    private static bool IsIdentifierChar(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '$';

    // The G# keyword that introduces a declaration name, read backwards from
    // the name over the spaces that separate them. Modifiers (`private`,
    // `shared`) sit BEFORE the keyword, so only the immediately preceding word
    // matters.
    private static bool FollowsDeclarationKeyword(string source, int index)
    {
        int end = index;
        while (end > 0 && source[end - 1] == ' ')
        {
            end--;
        }

        int start = end;
        while (start > 0 && IsIdentifierChar(source[start - 1]))
        {
            start--;
        }

        if (start == end)
        {
            return false;
        }

        return source.Substring(start, end - start) switch
        {
            "let" or "var" or "const" or "prop" or "func" or "class" or "struct"
                or "interface" or "enum" or "type" or "data" => true,
            _ => false,
        };
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

    /// <summary>
    /// Issue #3797: the C# snippet re-spelled with G#'s predefined type names
    /// (<c>int</c> → <c>int32</c>, <c>float</c> → <c>float32</c>, …), plus the
    /// offset map that carries a marker from the C# text to that re-spelling.
    ///
    /// <para>
    /// This is the one lexical rename translation applies INSIDE expression
    /// text, and it is the reason ordered exact-text marker placement drops an
    /// otherwise perfectly survivable marker. Replacements come from the C#
    /// tree's <c>PredefinedTypeSyntax</c> nodes, so nothing that merely
    /// contains the keyword's letters is rewritten.
    /// </para>
    /// </summary>
    private sealed class PredefinedRenaming
    {
        private readonly List<(int Start, int End, int Delta)> deltas = new();

        private PredefinedRenaming(string source) => this.Source = source;

        /// <summary>Gets the renamed source.</summary>
        public string Source { get; }

        /// <summary>
        /// Builds the renaming for <paramref name="document"/>.
        /// </summary>
        /// <param name="document">The loaded snippet document.</param>
        /// <param name="cleanSource">The marker-free C# source.</param>
        /// <returns>The renaming.</returns>
        public static PredefinedRenaming For(LoadedDocument document, string cleanSource)
        {
            var replacements = new List<(int Start, int Length, string Text)>();
            foreach (PredefinedTypeSyntax predefined in document.GetRoot()
                .DescendantNodes()
                .OfType<PredefinedTypeSyntax>())
            {
                ITypeSymbol type = document.SemanticModel.GetTypeInfo(predefined).Type;
                if (type is null
                    || CSharpTypeMapper.GetPredefinedName(type.SpecialType) is not { } name
                    || string.Equals(name, predefined.Keyword.ValueText, StringComparison.Ordinal))
                {
                    continue;
                }

                replacements.Add((predefined.Span.Start, predefined.Span.Length, name));
            }

            replacements.Sort((left, right) => left.Start.CompareTo(right.Start));

            var builder = new StringBuilder(cleanSource.Length);
            var pending = new List<(int Start, int End, int Delta)>();
            var copied = 0;
            var delta = 0;
            foreach ((int start, int length, string text) in replacements)
            {
                if (start < copied)
                {
                    continue;
                }

                builder.Append(cleanSource, copied, start - copied);
                builder.Append(text);
                copied = start + length;
                delta += text.Length - length;
                pending.Add((start, copied, delta));
            }

            builder.Append(cleanSource, copied, cleanSource.Length - copied);
            var renaming = new PredefinedRenaming(builder.ToString());
            renaming.deltas.AddRange(pending);
            return renaming;
        }

        /// <summary>
        /// Carries <paramref name="marked"/> into the renamed source: its text
        /// re-spelled, and its start offset shifted.
        /// </summary>
        /// <param name="marked">The marker as it appears in the C# source.</param>
        /// <returns>The marker as it appears in the renamed source.</returns>
        public MarkedText Rename(MarkedText marked)
        {
            int start = this.Shift(marked.Start);
            int end = this.Shift(marked.Start + marked.Text.Length);
            return new MarkedText(this.Source.Substring(start, end - start), start);
        }

        // The renamed offset of a C# offset: shifted by every replacement that
        // ENDS at or before it, so an offset inside a replacement (which a
        // marker boundary never is — a marker wraps whole nodes) maps to the
        // replacement's own start.
        private int Shift(int offset)
        {
            var delta = 0;
            foreach ((int Start, int End, int Delta) entry in this.deltas)
            {
                if (entry.End > offset)
                {
                    break;
                }

                delta = entry.Delta;
            }

            return offset + delta;
        }
    }
}
