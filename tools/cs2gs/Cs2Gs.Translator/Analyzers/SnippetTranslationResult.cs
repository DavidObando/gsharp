// <copyright file="SnippetTranslationResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.Translator.Analyzers;

/// <summary>
/// The result of translating one analyzer-test snippet (ADR-0169 M5). The
/// producer — <c>SnippetTranslator</c> — lives in <c>Cs2Gs.ProjectLoading</c>
/// because it needs a C# project loader, but the CONSUMER is the translator
/// itself (issue #3778: the dispatch point is a marker-bearing local in an
/// analyzer test method). ProjectLoading already references Translator, so the
/// contract type lives here and the hook is handed in as a delegate
/// (<see cref="TranslationContext.TranslateAnalyzerSnippet"/>) rather than
/// inverting the assembly dependency.
/// </summary>
/// <param name="GsWithMarkers">The G# snippet with re-placed markers, or null when the C# snippet did not compile.</param>
/// <param name="Diagnostics">Translation and marker-placement diagnostics.</param>
/// <param name="UnplacedMarkers">The marked texts that could not be re-placed automatically.</param>
public sealed record SnippetTranslationResult(
    string GsWithMarkers,
    IReadOnlyList<TranslationDiagnostic> Diagnostics,
    IReadOnlyList<string> UnplacedMarkers);
