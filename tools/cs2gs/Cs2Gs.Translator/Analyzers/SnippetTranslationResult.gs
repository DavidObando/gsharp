// <copyright file="SnippetTranslationResult.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Analyzers

import Cs2Gs.Translator
import System
import System.Collections.Generic

/// The result of translating one analyzer-test snippet (ADR-0169 M5). The
/// producer — `SnippetTranslator` — lives in `Cs2Gs.ProjectLoading`
/// because it needs a C# project loader, but the CONSUMER is the translator
/// itself (issue #3778: the dispatch point is a marker-bearing local in an
/// analyzer test method). ProjectLoading already references Translator, so the
/// contract type lives here and the hook is handed in as a delegate
/// ((cref:TranslationContext.TranslateAnalyzerSnippet)) rather than
/// inverting the assembly dependency.
/// @param GsWithMarkers The G# snippet with re-placed markers, or null when the C# snippet did not
/// compile.
/// @param Diagnostics Translation and marker-placement diagnostics.
/// @param UnplacedMarkers The marked texts that could not be re-placed automatically.
data class SnippetTranslationResult(
    GsWithMarkers string?,
    Diagnostics IReadOnlyList[TranslationDiagnostic],
    UnplacedMarkers IReadOnlyList[string]
) : IEquatable[SnippetTranslationResult] { }
