// <copyright file="GSharpAnalyzerVerifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    /// Compiles <paramref name="markedSource"/> (after stripping the
    /// <c>[|…|]</c> markers), runs <paramref name="analyzer"/> over it, and
    /// asserts the produced diagnostics match the markers and
    /// <paramref name="diagnosticIds"/>.
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
        var expectedLocations = new List<MarkerSpan>();
        var cleanSource = StripMarkers(markedSource, expectedLocations);

        // Markers are recorded when they CLOSE, so a nested pair would land out
        // of order; produced diagnostics are compared in span order.
        expectedLocations.Sort((left, right) => left.Start.CompareTo(right.Start));
        if (expectedLocations.Count != diagnosticIds.Length)
        {
            throw new GSharpAnalyzerVerificationException(
                $"The source contains {expectedLocations.Count} [|…|] marker(s) but {diagnosticIds.Length} diagnostic ID(s) were supplied.");
        }

        var tree = SyntaxTree.Parse(SourceText.From(cleanSource, "test.gs"));
        var compilation = new Core.CodeAnalysis.Compilation.Compilation(tree);
        var compileErrors = tree.Diagnostics
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
            .OrderBy(d => d.Location.Span.Start)
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

            var actualStart = produced[i].Location.Span.Start;
            var actualEnd = produced[i].Location.Span.End;
            if (actualStart < expected.Start || actualEnd > expected.End)
            {
                var actualLine = produced[i].Location.StartLine + 1;
                var actualColumn = produced[i].Location.StartCharacter + 1;
                throw new GSharpAnalyzerVerificationException(
                    $"Diagnostic {i} ({produced[i].Id}) spans [{actualStart}..{actualEnd}) — reported at "
                    + $"({actualLine},{actualColumn}) — which is not inside the marked region "
                    + $"[{expected.Start}..{expected.End}) starting at ({expected.Line},{expected.Column}).");
            }
        }
    }

    private static string Format(Diagnostic diagnostic)
        => diagnostic.Location.Text is null
            ? $"{diagnostic.Id}: {diagnostic.Message}"
            : $"{diagnostic.Id} at ({diagnostic.Location.StartLine + 1},{diagnostic.Location.StartCharacter + 1}): {diagnostic.Message}";

    private static string StripMarkers(string source, List<MarkerSpan> expectedLocations)
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
                        new MarkerSpan(start, result.Length, startLine, startColumn));
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
    /// <param name="Start">The marked region's start offset in the clean source.</param>
    /// <param name="End">The marked region's end offset in the clean source.</param>
    /// <param name="Line">The 1-based line of the region's first character.</param>
    /// <param name="Column">The 1-based column of the region's first character.</param>
    private readonly record struct MarkerSpan(int Start, int End, int Line, int Column);
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
