// <copyright file="GSharpAnalyzerVerifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.CodeAnalysis.Analyzers.Testing;

/// <summary>
/// The instance-based entry point of the ADR-0169 verifier: it takes the
/// analyzer as a value rather than as a type argument, which is the shape a
/// translated Roslyn test harness lands on. A migrated
/// <c>AnalyzerTestHelper.AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer,
/// …)</c> has an analyzer *instance* in hand and no type parameter to bind, so
/// <see cref="GSharpAnalyzerVerifier{TAnalyzer}"/> — static, generic, and
/// <c>new()</c>-constrained — cannot receive it without turning an argument
/// into a type argument. Hand-written G# analyzer tests should keep using the
/// generic form; this one exists so cs2gs's harness rewrite (ADR-0169 M5,
/// issue #3686) is a body substitution rather than a call-site rewrite.
/// </summary>
public static class GSharpAnalyzerVerifier
{
    /// <summary>
    /// The line that separates one G# compilation unit from the next inside a
    /// single <c>markedSource</c> string (issue #3794).
    ///
    /// <para>
    /// A G# compilation unit declares exactly ONE <c>package</c>, so a C#
    /// analyzer-test snippet spanning several namespaces has no single-unit
    /// G# rendering: collapsing it into the first package silently moves every
    /// declaration, and a namespace-scoped rule (GSA0003, GSA0004) then judges
    /// the wrong ones — which is how the migrated
    /// <c>ReportsSymbolKeyedReferenceCachesWithoutRemapScope</c> detected
    /// nothing at all and the migrated
    /// <c>IgnoresTypeSymbolsInstanceCachesTuplesAndNonMetadataNamespaces</c>
    /// reported a false positive. The harness signature stays "one source
    /// string" — it is what a translated Roslyn harness has in hand — and the
    /// string carries the unit boundaries explicitly instead.
    /// </para>
    ///
    /// <para>
    /// Markers and diagnostics are compared per unit: a diagnostic belongs to
    /// the unit whose file name it carries, and ordering is
    /// (unit, span start), so a rule that fires in the wrong package fails
    /// exactly as it should.
    /// </para>
    /// </summary>
    public const string UnitSeparator = "// ---8<--- cs2gs:next-compilation-unit ---";

    /// <summary>
    /// Compiles <paramref name="markedSource"/> (after stripping the
    /// <c>[|…|]</c> markers), runs <paramref name="analyzer"/> over it, and
    /// asserts the produced diagnostics match the markers and
    /// <paramref name="diagnosticIds"/>. A source containing
    /// <see cref="UnitSeparator"/> lines compiles as several compilation
    /// units in one compilation.
    /// </summary>
    /// <param name="analyzer">The analyzer under test.</param>
    /// <param name="markedSource">G# source with expected-diagnostic markers.</param>
    /// <param name="diagnosticIds">Expected diagnostic IDs, one per marker, in span order.</param>
    /// <exception cref="GSharpAnalyzerVerificationException">
    /// The source does not compile, or the produced diagnostics differ from
    /// the markers and ids.
    /// </exception>
    public static void VerifyAnalyzer(
        GSharpDiagnosticAnalyzer analyzer,
        string markedSource,
        params string[] diagnosticIds)
    {
        IReadOnlyList<string> markedUnits = SplitUnits(markedSource);
        var expectedLocations = new List<MarkerSpan>();
        var trees = new List<SyntaxTree>(markedUnits.Count);
        for (var unit = 0; unit < markedUnits.Count; unit++)
        {
            var unitMarkers = new List<MarkerSpan>();
            var cleanSource = StripMarkers(markedUnits[unit], unitMarkers, unit);

            // Markers are recorded when they CLOSE, so a nested pair would land
            // out of order; produced diagnostics are compared in span order.
            unitMarkers.Sort((left, right) => left.Start.CompareTo(right.Start));
            expectedLocations.AddRange(unitMarkers);
            trees.Add(SyntaxTree.Parse(SourceText.From(cleanSource, UnitFileName(unit))));
        }

        if (expectedLocations.Count != diagnosticIds.Length)
        {
            throw new GSharpAnalyzerVerificationException(
                $"The source contains {expectedLocations.Count} [|…|] marker(s) but {diagnosticIds.Length} diagnostic ID(s) were supplied.");
        }

        var compilation = new Core.CodeAnalysis.Compilation.Compilation(trees.ToArray());
        var compileErrors = trees.SelectMany(t => t.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToList();
        if (compileErrors.Count > 0)
        {
            throw new GSharpAnalyzerVerificationException(
                "The test source does not compile:\n" + string.Join("\n", compileErrors.Select(Format)));
        }

        var produced = GSharpAnalyzerDriver
            .Run(compilation, ImmutableArray.Create(analyzer))
            .OrderBy(d => UnitOf(d, markedUnits.Count))
            .ThenBy(d => d.Location.Span.Start)
            .ToImmutableArray();

        if (!produced.Select(d => d.Id).SequenceEqual(diagnosticIds))
        {
            throw new GSharpAnalyzerVerificationException(
                $"Expected diagnostics [{string.Join(", ", diagnosticIds)}] but the analyzer produced:\n"
                + (produced.Length == 0 ? "(none)" : string.Join("\n", produced.Select(Format))));
        }

        for (var i = 0; i < expectedLocations.Count; i++)
        {
            MarkerSpan expected = expectedLocations[i];
            if (produced[i].Location.Text is null)
            {
                throw new GSharpAnalyzerVerificationException(
                    $"Diagnostic {i} ({produced[i].Id}) carries no source location, so the marker at "
                    + $"({expected.Line},{expected.Column}) cannot be checked. An analyzer that reports "
                    + "on a symbol must attribute the diagnostic to one of its declaring syntax nodes.");
            }

            var actualUnit = UnitOf(produced[i], markedUnits.Count);
            var actualStart = produced[i].Location.Span.Start;
            var actualEnd = produced[i].Location.Span.End;
            if (actualUnit != expected.Unit || actualStart < expected.Start || actualEnd > expected.End)
            {
                var actualLine = produced[i].Location.StartLine + 1;
                var actualColumn = produced[i].Location.StartCharacter + 1;
                var where = markedUnits.Count == 1
                    ? string.Empty
                    : $" in compilation unit {actualUnit} (expected unit {expected.Unit})";
                throw new GSharpAnalyzerVerificationException(
                    $"Diagnostic {i} ({produced[i].Id}) spans [{actualStart}..{actualEnd}) — reported at "
                    + $"({actualLine},{actualColumn}){where} — which is not inside the marked region "
                    + $"[{expected.Start}..{expected.End}) starting at ({expected.Line},{expected.Column}).");
            }
        }
    }

    private static string Format(Diagnostic diagnostic)
        => diagnostic.Location.Text is null
            ? $"{diagnostic.Id}: {diagnostic.Message}"
            : $"{diagnostic.Id} at {diagnostic.Location.FileName}({diagnostic.Location.StartLine + 1},{diagnostic.Location.StartCharacter + 1}): {diagnostic.Message}";

    /// <summary>The file name of the <paramref name="unit"/>-th compilation unit.</summary>
    /// <param name="unit">The zero-based unit index.</param>
    /// <returns>The synthetic file name.</returns>
    private static string UnitFileName(int unit) => unit == 0 ? "test.gs" : $"test{unit}.gs";

    /// <summary>
    /// Which compilation unit <paramref name="diagnostic"/> was reported in.
    /// A diagnostic with no location sorts last so the marker loop can name it
    /// as location-less rather than mis-ordering the comparison.
    /// </summary>
    /// <param name="diagnostic">The produced diagnostic.</param>
    /// <param name="unitCount">How many units the source declared.</param>
    /// <returns>The zero-based unit index, or <paramref name="unitCount"/>.</returns>
    private static int UnitOf(Diagnostic diagnostic, int unitCount)
    {
        if (diagnostic.Location.Text is null)
        {
            return unitCount;
        }

        for (var unit = 0; unit < unitCount; unit++)
        {
            if (string.Equals(diagnostic.Location.FileName, UnitFileName(unit), StringComparison.Ordinal))
            {
                return unit;
            }
        }

        return unitCount;
    }

    /// <summary>
    /// Splits <paramref name="markedSource"/> on <see cref="UnitSeparator"/>
    /// lines. A source with no separator is one unit, which is every
    /// hand-written G# analyzer test.
    /// </summary>
    /// <param name="markedSource">The marked source.</param>
    /// <returns>One entry per compilation unit, in source order.</returns>
    private static IReadOnlyList<string> SplitUnits(string markedSource)
    {
        if (markedSource is null || markedSource.IndexOf(UnitSeparator, StringComparison.Ordinal) < 0)
        {
            return new[] { markedSource ?? string.Empty };
        }

        var units = new List<string>();
        var current = new StringBuilder();
        foreach (var line in markedSource.Split('\n'))
        {
            if (line.Trim().Equals(UnitSeparator, StringComparison.Ordinal))
            {
                units.Add(current.ToString());
                current.Clear();
                continue;
            }

            current.Append(line).Append('\n');
        }

        units.Add(current.ToString());
        return units;
    }

    private static string StripMarkers(string source, List<MarkerSpan> expectedLocations, int unit = 0)
    {
        var result = new StringBuilder(source.Length);
        var open = new Stack<(int Start, int Line, int Column)>();
        var line = 1;
        var column = 1;
        for (var i = 0; i < source.Length; i++)
        {
            if (i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|')
            {
                open.Push((result.Length, line, column));
                i++;
                continue;
            }

            if (i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']')
            {
                if (open.Count > 0)
                {
                    (int start, int startLine, int startColumn) = open.Pop();
                    expectedLocations.Add(
                        new MarkerSpan(unit, start, result.Length, startLine, startColumn));
                }

                i++;
                continue;
            }

            result.Append(source[i]);
            if (source[i] == '\n')
            {
                line++;
                column = 1;
            }
            else
            {
                column++;
            }
        }

        return result.ToString();
    }

    /// <summary>
    /// One <c>[|…|]</c> marker: the marked REGION, plus the 1-based
    /// line/column of its first character for readable failure messages.
    /// </summary>
    /// <remarks>
    /// The region, not the start point, is the assertion (ADR-0169, issue
    /// #3778). A hand-written G# test brackets exactly the construct it
    /// expects the diagnostic on, and a diagnostic on that construct is
    /// span-equal to the marker, so nothing about those tests relaxes. What
    /// the region admits is the cross-language case: a snippet TRANSLATED from
    /// C# keeps the C# marker's extent, and G#'s syntax shapes are not always
    /// span-identical — its index node is narrower than C#'s element access,
    /// so <c>[|this.cache.Defs[field]|]</c> yields a diagnostic that starts
    /// inside the marker. Requiring the diagnostic to be CONTAINED in the
    /// marker keeps the assertion falsifiable — a diagnostic on a neighbouring
    /// construct, or on an enclosing one, still fails — while not asserting a
    /// span identity that does not survive translation.
    /// </remarks>
    /// <param name="Unit">The zero-based compilation unit the marker is in.</param>
    /// <param name="Start">The marked region's start offset in the clean source.</param>
    /// <param name="End">The marked region's end offset in the clean source.</param>
    /// <param name="Line">The 1-based line of the region's first character.</param>
    /// <param name="Column">The 1-based column of the region's first character.</param>
    private readonly record struct MarkerSpan(int Unit, int Start, int End, int Line, int Column);
}

/// <summary>
/// Test-framework-agnostic verifier for <see cref="GSharpDiagnosticAnalyzer"/>s
/// (ADR-0169). G# source is annotated with <c>[|</c>…<c>|]</c> span markers at
/// each expected diagnostic start; the verifier strips the markers, compiles
/// the source, runs the analyzer through <see cref="GSharpAnalyzerDriver"/>,
/// and asserts the produced diagnostic IDs (in span order) and their exact
/// 1-based line/column positions. Mismatches throw
/// <see cref="GSharpAnalyzerVerificationException"/>. Deliberately shaped like
/// the repo's Roslyn-side <c>AnalyzerTestHelper.AssertDiagnosticsAsync</c> so
/// cs2gs can translate existing analyzer tests mechanically.
/// </summary>
/// <typeparam name="TAnalyzer">The analyzer under test.</typeparam>
public static class GSharpAnalyzerVerifier<TAnalyzer>
    where TAnalyzer : GSharpDiagnosticAnalyzer, new()
{
    /// <summary>
    /// Compiles <paramref name="markedSource"/> (after stripping the
    /// <c>[|…|]</c> markers), runs the analyzer, and asserts the produced
    /// diagnostics match the markers and <paramref name="diagnosticIds"/>.
    /// </summary>
    /// <param name="markedSource">G# source with expected-diagnostic markers.</param>
    /// <param name="diagnosticIds">Expected diagnostic IDs, one per marker, in span order.</param>
    public static void VerifyAnalyzer(string markedSource, params string[] diagnosticIds)
        => GSharpAnalyzerVerifier.VerifyAnalyzer(new TAnalyzer(), markedSource, diagnosticIds);
}
