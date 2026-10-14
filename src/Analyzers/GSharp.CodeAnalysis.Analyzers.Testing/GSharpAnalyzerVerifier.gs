// <copyright file="GSharpAnalyzerVerifier.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.CodeAnalysis.Analyzers.Testing

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis.Compilation

/// The instance-based entry point of the ADR-0169 verifier: it takes the
/// analyzer as a value rather than as a type argument, which is the shape a
/// translated Roslyn test harness lands on. A migrated
/// `AnalyzerTestHelper.AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer,
/// …)` has an analyzer *instance* in hand and no type parameter to bind, so
/// (cref:GSharpAnalyzerVerifier{TAnalyzer}) — static, generic, and
/// `new()`-constrained — cannot receive it without turning an argument
/// into a type argument. Hand-written G# analyzer tests should keep using the
/// generic form; this one exists so cs2gs's harness rewrite (ADR-0169 M5,
/// issue #3686) is a body substitution rather than a call-site rewrite.
shared class GSharpAnalyzerVerifier {
    /// One `[|…|]` marker: the marked REGION, plus the 1-based
    /// line/column of its first character for readable failure messages.
    /// @remarks The region, not the start point, is the assertion (ADR-0169, issue
    /// #3778). A hand-written G# test brackets exactly the construct it
    /// expects the diagnostic on, and a diagnostic on that construct is
    /// span-equal to the marker, so nothing about those tests relaxes. What
    /// the region admits is the cross-language case: a snippet TRANSLATED from
    /// C# keeps the C# marker's extent, and G#'s syntax shapes are not always
    /// span-identical — its index node is narrower than C#'s element access,
    /// so `[|this.cache.Defs[field]|]` yields a diagnostic that starts
    /// inside the marker. Requiring the diagnostic to be CONTAINED in the
    /// marker keeps the assertion falsifiable — a diagnostic on a neighbouring
    /// construct, or on an enclosing one, still fails — while not asserting a
    /// span identity that does not survive translation.
    /// @param Unit The zero-based compilation unit the marker is in.
    /// @param Start The marked region's start offset in the clean source.
    /// @param End The marked region's end offset in the clean source.
    /// @param Line The 1-based line of the region's first character.
    /// @param Column The 1-based column of the region's first character.
    private data struct MarkerSpan(Unit int32, Start int32, End int32, Line int32, Column int32) : IEquatable[
        MarkerSpan
    ] { }

    /// The line that separates one G# compilation unit from the next inside a
    /// single `markedSource` string (issue #3794).
    ///
    /// A G# compilation unit declares exactly ONE `package`, so a C#
    /// analyzer-test snippet spanning several namespaces has no single-unit
    /// G# rendering: collapsing it into the first package silently moves every
    /// declaration, and a namespace-scoped rule (GSA0003, GSA0004) then judges
    /// the wrong ones — which is how the migrated
    /// `ReportsSymbolKeyedReferenceCachesWithoutRemapScope` detected
    /// nothing at all and the migrated
    /// `IgnoresTypeSymbolsInstanceCachesTuplesAndNonMetadataNamespaces`
    /// reported a false positive. The harness signature stays "one source
    /// string" — it is what a translated Roslyn harness has in hand — and the
    /// string carries the unit boundaries explicitly instead.
    ///
    /// Markers and diagnostics are compared per unit: a diagnostic belongs to
    /// the unit whose file name it carries, and ordering is
    /// (unit, span start), so a rule that fires in the wrong package fails
    /// exactly as it should.
    const UnitSeparator string = "// ---8<--- cs2gs:next-compilation-unit ---"

    /// Compiles [`markedSource`](paramref) (after stripping the
    /// `[|…|]` markers), runs [`analyzer`](paramref) over it, and
    /// asserts the produced diagnostics match the markers and
    /// [`diagnosticIds`](paramref). A source containing
    /// (cref:UnitSeparator) lines compiles as several compilation
    /// units in one compilation.
    /// @param analyzer The analyzer under test.
    /// @param markedSource G# source with expected-diagnostic markers.
    /// @param diagnosticIds Expected diagnostic IDs, one per marker, in span order.
    /// @exception GSharpAnalyzerVerificationException The source does not compile, or the produced
    /// diagnostics differ from
    /// the markers and ids.
    func VerifyAnalyzer(analyzer GSharpDiagnosticAnalyzer, markedSource string, diagnosticIds ...string) {
        let markedUnits = SplitUnits(markedSource)
        let expectedLocations = List[MarkerSpan]()
        let trees = List[SyntaxTree](markedUnits.Count)
        for var unit = 0; unit < markedUnits.Count; unit++ {
            let unitMarkers = List[MarkerSpan]()
            let cleanSource = StripMarkers(markedUnits[unit], unitMarkers, unit)
            // Markers are recorded when they CLOSE, so a nested pair would land
            // out of order; produced diagnostics are compared in span order.
            unitMarkers.Sort((left MarkerSpan, right MarkerSpan) -> left.Start.CompareTo(right.Start))
            expectedLocations.AddRange(unitMarkers)
            trees.Add(SyntaxTree.Parse(SourceText.From(cleanSource, UnitFileName(unit))))
        }
        if expectedLocations.Count != diagnosticIds.Length {
            throw GSharpAnalyzerVerificationException(
                "The source contains ${expectedLocations.Count} [|…|] marker(s) but ${diagnosticIds.Length} diagnostic ID(s) were supplied."
            )
        }
        let compilation = Compilation(trees.ToArray())
        let compileErrors = trees
            .SelectMany(
            func (t SyntaxTree) IEnumerable[Diagnostic] {
                return t.Diagnostics
            }
        )
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where((d Diagnostic) -> d.IsError)
            .ToList()
        if compileErrors.Count > 0 {
            throw GSharpAnalyzerVerificationException(
                "The test source does not compile:\n" + string.Join("\n", compileErrors.Select(Format))
            )
        }
        let produced = GSharpAnalyzerDriver
            .Run(compilation, ImmutableArray.Create(analyzer))
            .OrderBy((d Diagnostic) -> UnitOf(d, markedUnits.Count))
            .ThenBy((d Diagnostic) -> d.Location.Span.Start)
            .ToImmutableArray()
        if !produced.Select((d Diagnostic) -> d.Id).SequenceEqual(diagnosticIds) {
            throw GSharpAnalyzerVerificationException(
                (`Expected diagnostics [` + "${string.Join(", ", diagnosticIds)}" + `] but the analyzer produced:
`) + (
                    if produced.Length == 0 {
                        "(none)"
                    } else {
                        string.Join("\n", produced.Select(Format))
                    }
                )
            )
        }
        for var i = 0; i < expectedLocations.Count; i++ {
            let expected = expectedLocations[i]
            if produced[i].Location.Text == nil {
                throw GSharpAnalyzerVerificationException(
                    "Diagnostic $i (${produced[i].Id}) carries no source location, so the marker at " +
                        "(${expected.Line},${expected.Column}) cannot be checked. An analyzer that reports " +
                        "on a symbol must attribute the diagnostic to one of its declaring syntax nodes."
                )
            }
            let actualUnit = UnitOf(produced[i], markedUnits.Count)
            let actualStart = produced[i].Location.Span.Start
            let actualEnd = produced[i].Location.Span.End
            if actualUnit != expected.Unit || actualStart < expected.Start || actualEnd > expected.End {
                let actualLine = produced[i].Location.StartLine + 1
                let actualColumn = produced[i].Location.StartCharacter + 1
                let where = if markedUnits.Count == 1 {
                    string.Empty
                } else {
                    " in compilation unit $actualUnit (expected unit ${expected.Unit})"
                }
                throw GSharpAnalyzerVerificationException(
                    "Diagnostic $i (${produced[i].Id}) spans [$actualStart..$actualEnd) — reported at " +
                        "($actualLine,$actualColumn)$where — which is not inside the marked region " +
                        "[${expected.Start}..${expected.End}) starting at (${expected.Line},${expected.Column})."
                )
            }
        }
    }

    private func Format(diagnostic Diagnostic) string -> if diagnostic.Location.Text == nil {
        "${diagnostic.Id}: ${diagnostic.Message}"
    } else {
        "${diagnostic.Id} at ${diagnostic.Location.FileName}(${diagnostic.Location.StartLine + 1},${diagnostic.Location.StartCharacter + 1}): ${diagnostic.Message}"
    }

    /// The file name of the [`unit`](paramref)-th compilation unit.
    /// @param unit The zero-based unit index.
    /// @returns The synthetic file name.
    private func UnitFileName(unit int32) string -> if unit == 0 {
        "test.gs"
    } else {
        "test$unit.gs"
    }

    /// Which compilation unit [`diagnostic`](paramref) was reported in.
    /// A diagnostic with no location sorts last so the marker loop can name it
    /// as location-less rather than mis-ordering the comparison.
    /// @param diagnostic The produced diagnostic.
    /// @param unitCount How many units the source declared.
    /// @returns The zero-based unit index, or [`unitCount`](paramref).
    private func UnitOf(diagnostic Diagnostic, unitCount int32) int32 {
        if diagnostic.Location.Text == nil {
            return unitCount
        }
        for var unit = 0; unit < unitCount; unit++ {
            if string.Equals(diagnostic.Location.FileName, UnitFileName(unit), StringComparison.Ordinal) {
                return unit
            }
        }
        return unitCount
    }

    /// Splits [`markedSource`](paramref) on (cref:UnitSeparator)
    /// lines. A source with no separator is one unit, which is every
    /// hand-written G# analyzer test.
    /// @param markedSource The marked source.
    /// @returns One entry per compilation unit, in source order.
    private func SplitUnits(markedSource string?) IReadOnlyList[string] {
        if markedSource == nil || markedSource.IndexOf(UnitSeparator, StringComparison.Ordinal) < 0 {
            return []string{markedSource ?? string.Empty}
        }
        let units = List[string]()
        let current = StringBuilder()
        for line in markedSource.Split('\n') {
            if line.Trim().Equals(UnitSeparator, StringComparison.Ordinal) {
                units.Add(current.ToString())
                current.Clear()
                continue
            }
            current.Append(line).Append('\n')
        }
        units.Add(current.ToString())
        return units
    }

    private func StripMarkers(source string, expectedLocations List[MarkerSpan], unit int32 = 0) string {
        let result = StringBuilder(source.Length)
        let open_ = Stack[(Start int32, Line int32, Column int32)]()
        var line = 1
        var column = 1
        for var i = 0; i < source.Length; i++ {
            if i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|' {
                open_.Push((result.Length, line, column))
                i++
                continue
            }
            if i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']' {
                if open_.Count > 0 {
                    let (start, startLine, startColumn) = open_.Pop()
                    expectedLocations.Add(MarkerSpan(unit, start, result.Length, startLine, startColumn))
                }
                i++
                continue
            }
            result.Append(source[i])
            if source[i] == '\n' {
                line++
                column = 1
            } else {
                column++
            }
        }
        return result.ToString()
    }
}

/// Test-framework-agnostic verifier for (cref:GSharpDiagnosticAnalyzer)s
/// (ADR-0169). G# source is annotated with `[|`…`|]` span markers at
/// each expected diagnostic start; the verifier strips the markers, compiles
/// the source, runs the analyzer through (cref:GSharpAnalyzerDriver),
/// and asserts the produced diagnostic IDs (in span order) and their exact
/// 1-based line/column positions. Mismatches throw
/// (cref:GSharpAnalyzerVerificationException). Deliberately shaped like
/// the repo's Roslyn-side `AnalyzerTestHelper.AssertDiagnosticsAsync` so
/// cs2gs can translate existing analyzer tests mechanically.
/// @typeparam TAnalyzer The analyzer under test.
shared class GSharpAnalyzerVerifier[TAnalyzer GSharpDiagnosticAnalyzer init()] {
    /// Compiles [`markedSource`](paramref) (after stripping the
    /// `[|…|]` markers), runs the analyzer, and asserts the produced
    /// diagnostics match the markers and [`diagnosticIds`](paramref).
    /// @param markedSource G# source with expected-diagnostic markers.
    /// @param diagnosticIds Expected diagnostic IDs, one per marker, in span order.
    func VerifyAnalyzer(markedSource string, diagnosticIds ...string) -> GSharpAnalyzerVerifier.VerifyAnalyzer(
        TAnalyzer(),
        markedSource,
        diagnosticIds
    )
}
