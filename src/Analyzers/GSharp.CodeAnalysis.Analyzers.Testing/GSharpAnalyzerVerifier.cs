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
        var expectedLocations = new List<(int Line, int Column)>();
        var cleanSource = StripMarkers(markedSource, expectedLocations);
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
            var actualLine = produced[i].Location.StartLine + 1;
            var actualColumn = produced[i].Location.StartCharacter + 1;
            if ((actualLine, actualColumn) != expectedLocations[i])
            {
                throw new GSharpAnalyzerVerificationException(
                    $"Diagnostic {i} ({produced[i].Id}) was reported at ({actualLine},{actualColumn}) but the marker expects ({expectedLocations[i].Line},{expectedLocations[i].Column}).");
            }
        }
    }

    private static string Format(Diagnostic diagnostic)
        => diagnostic.Location.Text is null
            ? $"{diagnostic.Id}: {diagnostic.Message}"
            : $"{diagnostic.Id} at ({diagnostic.Location.StartLine + 1},{diagnostic.Location.StartCharacter + 1}): {diagnostic.Message}";

    private static string StripMarkers(string source, List<(int Line, int Column)> expectedLocations)
    {
        var result = new StringBuilder(source.Length);
        var line = 1;
        var column = 1;
        for (var i = 0; i < source.Length; i++)
        {
            if (i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|')
            {
                expectedLocations.Add((line, column));
                i++;
                continue;
            }

            if (i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']')
            {
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
