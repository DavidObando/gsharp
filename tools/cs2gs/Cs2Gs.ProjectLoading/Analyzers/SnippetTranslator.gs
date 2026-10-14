// <copyright file="SnippetTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator.Analyzers

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Cs2Gs.Translator
import GSharp.Core.CodeAnalysis.Syntax

/// Translates a C# analyzer-test snippet — a self-contained compilation unit
/// annotated with `[|…|]` expected-diagnostic markers — into the
/// equivalent G# snippet with the markers re-placed
/// (docs/cs2gs-analyzer-translation.md §Test-harness). Markers are re-placed
/// by ordered exact-text match: analyzer-test markers overwhelmingly wrap
/// expressions whose surface text survives translation verbatim. A marker
/// whose text does not survive is dropped from the output and surfaced as a
/// `CS2GS-ANALYZER-SNIPPET` warning — loud, never silently misplaced —
/// for the human to re-place during review. Re-placed markers denote
/// expected-diagnostic REGIONS: G#'s syntax shapes differ (e.g. its index
/// node is narrower than C#'s element access), so migrated verifications
/// should assert the diagnostic starts within the marker, or hand-tighten
/// the span during review.
shared class SnippetTranslator {
    /// One `[|…|]` marker: its text and its offset in the marker-free C# source.
    /// @param Text The marked text.
    /// @param Start The offset of the marked text in the stripped source.
    private data struct MarkedText(Text string, Start int32) : IEquatable[MarkedText] { }

    /// Issue #3797: the C# snippet re-spelled with G#'s predefined type names
    /// (`int` → `int32`, `float` → `float32`, …), plus the
    /// offset map that carries a marker from the C# text to that re-spelling.
    ///
    /// This is the one lexical rename translation applies INSIDE expression
    /// text, and it is the reason ordered exact-text marker placement drops an
    /// otherwise perfectly survivable marker. Replacements come from the C#
    /// tree's `PredefinedTypeSyntax` nodes, so nothing that merely
    /// contains the keyword's letters is rewritten.
    private class PredefinedRenaming {
        private let deltas List[(Start int32, End int32, Delta int32)] = List[(Start int32, End int32, Delta int32)]()

        private init(source string) {
            this.Source = source
        }

        /// Gets the renamed source.
        prop Source string {
            get;
        }

        /// Carries [`marked`](paramref) into the renamed source: its text
        /// re-spelled, and its start offset shifted.
        /// @param marked The marker as it appears in the C# source.
        /// @returns The marker as it appears in the renamed source.
        func Rename(marked MarkedText) MarkedText {
            let start = this.Shift(marked.Start)
            let end = this.Shift(marked.Start + marked.Text.Length)
            return MarkedText(this.Source.Substring(start, end - start), start)
        }

        /// Maps an offset in (cref:Source) back to the original C# source.
        /// @param offset The renamed-source offset.
        /// @returns The corresponding original-source offset.
        func OriginalOffset(offset int32) int32 {
            var delta = 0
            for entry in this.deltas {
                let renamedStart = entry.Start + delta
                let renamedEnd = entry.End + entry.Delta
                if offset < renamedStart {
                    break
                }
                if offset < renamedEnd {
                    return entry.Start
                }
                delta = entry.Delta
            }
            return offset - delta
        }

        // The renamed offset of a C# offset: shifted by every replacement that
        // ENDS at or before it, so an offset inside a replacement (which a
        // marker boundary never is — a marker wraps whole nodes) maps to the
        // replacement's own start.
        private func Shift(offset int32) int32 {
            var delta = 0
            for entry in this.deltas {
                if entry.End > offset {
                    break
                }
                delta = entry.Delta
            }
            return offset + delta
        }

        shared {
            /// Builds the renaming for [`document`](paramref).
            /// @param document The loaded snippet document.
            /// @param cleanSource The marker-free C# source.
            /// @returns The renaming.
            func For(document LoadedDocument, cleanSource string) PredefinedRenaming {
                let replacements = List[(Start int32, Length int32, Text string)]()
                for predefined in document.GetRoot().DescendantNodes().OfType[PredefinedTypeSyntax]() {
                    let type ITypeSymbol? = document.SemanticModel.GetTypeInfo(predefined).Type
                    if type == nil || CSharpTypeMapper.GetPredefinedName(type.SpecialType) is not{} name ||
                        string.Equals(name, predefined.Keyword.ValueText, StringComparison.Ordinal) {
                        continue
                    }
                    replacements.Add((predefined.Span.Start, predefined.Span.Length, name))
                }
                replacements.Sort(
                    (
                        left(Start int32, Length int32, Text string),
                        right(Start int32, Length int32, Text string)
                    ) -> left
                        .Start
                        .CompareTo(right.Start)
                )
                let builder = StringBuilder(cleanSource.Length)
                let pending = List[(Start int32, End int32, Delta int32)]()
                var copied = 0
                var delta = 0
                for (start, length, text) in replacements {
                    if start < copied {
                        continue
                    }
                    builder.Append(cleanSource, copied, start - copied)
                    builder.Append(text)
                    copied = start + length
                    delta += text.Length - length
                    pending.Add((start, copied, delta))
                }
                builder.Append(cleanSource, copied, cleanSource.Length - copied)
                let renaming = PredefinedRenaming(builder.ToString())
                renaming.deltas.AddRange(pending)
                return renaming
            }
        }
    }

    /// The diagnostic id carried by unplaceable-marker warnings.
    const SnippetDiagnosticId string = "CS2GS-ANALYZER-SNIPPET"

    /// The line separating one emitted G# compilation unit from the next
    /// (issue #3794). MUST equal
    /// `GSharpAnalyzerVerifier.UnitSeparator`, which is what splits it
    /// back apart; `Issue3794AnalyzerSnippetPackageSplitTests` asserts the two
    /// spellings agree, because cs2gs cannot reference the G# testing assembly
    /// it emits calls into.
    const UnitSeparator string = "// ---8<--- cs2gs:next-compilation-unit ---"

    /// Translates [`csharpWithMarkers`](paramref) to a G# snippet with
    /// re-placed markers.
    /// @param csharpWithMarkers The marked C# snippet (a full compilation unit).
    /// @returns The translation result.
    func Translate(csharpWithMarkers string) SnippetTranslationResult {
        let markedTexts = List[MarkedText]()
        let cleanSource = StripMarkers(csharpWithMarkers, markedTexts)
        let diagnostics = List[TranslationDiagnostic]()
        let project = CSharpProjectLoader.LoadInMemory([](string, cleanSource string){("Snippet.cs", cleanSource)})
        if !project.BoundWithoutErrors {
            diagnostics.Add(
                TranslationDiagnostic(
                    "analyzer-snippet",
                    "The C# snippet does not compile: " + string.Join("; ", project.ErrorDiagnostics.Take(3)),
                    location: nil,
                    TranslationSeverity.Unsupported
                )
            )
            return SnippetTranslationResult(nil, diagnostics, markedTexts.Select((m MarkedText) -> m.Text).ToList())
        }
        let document = project.Documents.Single((d LoadedDocument) -> Path.GetFileName(d.FilePath) == "Snippet.cs")
        // Issue #3794: one G# compilation unit declares one `package`, so a
        // snippet spanning several namespaces is emitted as several units
        // joined by UnitSeparator instead of being collapsed into the first
        // package. Collapsing silently moved every declaration, which made a
        // namespace-scoped rule (GSA0003, GSA0004) judge the wrong ones — total
        // detection loss in one migrated test and a false positive in another.
        // Unit order is declaration order, which is what lets the ordinal
        // marker placement below keep working over the concatenation.
        let packages = CSharpToGSharpTranslator.GetDeclaredPackages(document)
        let unitCount = Math.Max(1, packages.Count)
        let printedUnits = List[string](unitCount)
        for var unitIndex = 0; unitIndex < unitCount; unitIndex++ {
            let package_ string? = if packages.Count > 1 {
                packages[unitIndex]
            } else {
                default(string?)
            }
            let translator = CSharpToGSharpTranslator(
                packageFilter: package_,
                includeFileAttributes: unitIndex == 0,
                includeGlobalNamespace: unitIndex == 0
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            printedUnits.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)))
            for reported in context.Diagnostics {
                // The same document is translated once per package, so a
                // diagnostic about a construct outside every filter is raised
                // by every unit; report each distinct one once. Equal bridge
                // messages at different source spans are still distinct sites.
                if !diagnostics.Any(
                    (existing TranslationDiagnostic) -> string.Equals(
                        existing.Message,
                        reported.Message,
                        StringComparison.Ordinal
                    ) &&
                        (
                        reported.DiagnosticId != CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId ||
                            (
                            existing.DiagnosticId == reported.DiagnosticId && object.Equals(
                                existing.Location,
                                reported.Location
                            )
                        )
                    )
                ) {
                    diagnostics.Add(reported)
                }
            }
        }
        let printed = string.Join("\n" + UnitSeparator + "\n", printedUnits)
        let unitOffsets = [printedUnits.Count]int32
        for var i = 1; i < printedUnits.Count; i++ {
            unitOffsets[i] = unitOffsets[i - 1] + printedUnits[i - 1].Length + UnitSeparator.Length + 2
        }
        let unplaced = List[string]()
        let renaming = PredefinedRenaming.For(document, cleanSource)
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
        let placements = List[(Index int32, Length int32)]()
        for marked in markedTexts {
            let markedPackage = DeclaredPackageAt(document, marked.Start)
            let unitIndex = PackageUnitIndex(packages, markedPackage)
            if unitIndex < 0 {
                ReportUnplacedMarker(marked, 0, unplaced, diagnostics)
                continue
            }
            let searchable = printedUnits[unitIndex]
            let unitOffset = unitOffsets[unitIndex]
            let ordinal = OccurrenceOrdinal(document, cleanSource, marked.Text, marked.Start, packages, unitIndex)
            var length = marked.Text.Length
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
            let declarationOrdinal = DeclarationOrdinal(document, marked, packages, unitIndex)
            var index = if declarationOrdinal is {} d {
                NthDeclarationOccurrence(searchable, marked.Text, d)
            } else {
                -1
            }
            if index < 0 {
                if declarationOrdinal == nil {
                    // Issue #4191 (Copilot review of #4190): a NON-declaration
                    // marker is placed by ONE unified exact-or-bridged ordinal
                    // sequence, not by an exact-only search that falls back to
                    // a wholly separate tolerant-only search only when the
                    // exact search finds NOTHING. When translation inserts a
                    // `!!` bridge on only SOME occurrences of the marked text
                    // (e.g. a `do`-loop walk that needs it, alongside an
                    // unrelated, narrowed `while`-loop walk of the same text
                    // that stays exact), one occurrence "drops out" of the
                    // exact-match sequence while the other does not, so the
                    // exact-only ordinal computed from the C# source no longer
                    // lines up with the exact-only ordinal in the printed G# —
                    // and a plain exact search can then silently SUCCEED at
                    // the wrong occurrence, never even reaching the tolerant
                    // fallback below (which only runs once the exact search
                    // returns -1). `TryNullForgivingTolerantOccurrence`'s
                    // pattern already tolerates an optional `!!` after every
                    // identifier — an exact occurrence matches it too, with
                    // zero `!!`s — so using it here counts exact and bridged
                    // forms together, in the one order they actually appear
                    // in `printed`. `ordinal` itself (computed above via exact
                    // matching over `cleanSource`) is unaffected by this: the
                    // clean C# source never itself contains a `!!` bridge —
                    // that is purely a translation artifact — so its exact
                    // ordinal already agrees with what the tolerant matcher
                    // would compute there.
                    TryNullForgivingTolerantOccurrence(searchable, marked.Text, ordinal, out index, out length)
                } else {
                    index = NthOccurrence(searchable, marked.Text, ordinal)
                }
            }
            if index < 0 {
                // Issue #3797: retry against the ONE lexical rename translation
                // applies inside expression text — C#'s predefined type
                // keywords become G#'s width-bearing primitive names, so
                // `typeof(int) != type` prints as `typeof(int32) != type`.
                // The renamed candidate is computed from the marked region's
                // own `PredefinedTypeSyntax` nodes, never by text substitution,
                // so an identifier that merely contains `int` is untouched, and
                // its ordinal is measured in the equally renamed source so a
                // repeated marker still lands on the right occurrence.
                let renamed = renaming.Rename(marked)
                if !string.Equals(renamed.Text, marked.Text, StringComparison.Ordinal) {
                    let renamedOrdinal = OccurrenceOrdinal(document, renaming, renamed, packages, unitIndex)
                    index = NthOccurrence(searchable, renamed.Text, renamedOrdinal)
                    length = renamed.Text.Length
                }
            }
            if index < 0 &&
                TryNullForgivingTolerantOccurrence(
                searchable,
                marked.Text,
                ordinal,
                out var toleratedIndex,
                out var toleratedLength
            ) {
                index = toleratedIndex
                length = toleratedLength
            }
            if index < 0 && declarationOrdinal == nil {
                let renamed = renaming.Rename(marked)
                let candidate = renamed.Text
                let candidateOrdinal = ExpressionOrdinal(document, marked, packages, unitIndex)
                if candidateOrdinal >= 0 {
                    TryFormattingTolerantOccurrence(searchable, candidate, candidateOrdinal, out index, out length)
                }
            }
            if index < 0 {
                ReportUnplacedMarker(marked, ordinal, unplaced, diagnostics)
                continue
            }
            placements.Add((unitOffset + index, length))
        }
        let result = StringBuilder(printed)
        for (index, length) in placements.OrderByDescending((p(Index int32, Length int32)) -> p.Index) {
            result.Insert(index + length, "|]")
            result.Insert(index, "[|")
        }
        return SnippetTranslationResult(result.ToString(), diagnostics, unplaced)
    }

    /// When [`marked`](paramref) covers exactly the identifier a C#
    /// declaration is NAMED by, the number of same-named declarations earlier
    /// in the snippet; otherwise `null` (issue #3794).
    /// @param document The loaded snippet document.
    /// @param marked The marker.
    /// @param packages The emitted packages.
    /// @param unitIndex The unit containing the marker.
    /// @returns The declaration ordinal, or `null`.
    private func DeclarationOrdinal(
        document LoadedDocument,
        marked MarkedText,
        packages IReadOnlyList[string],
        unitIndex int32
    ) int32? {
        var ordinal = 0
        var isDeclarationName = false
        for token in document.GetRoot().DescendantTokens() {
            if !token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.IdentifierToken) || !string.Equals(
                token.ValueText,
                marked.Text,
                StringComparison.Ordinal
            ) ||
                !IsDeclarationName(token) ||
                !BelongsToUnit(document, token.SpanStart, packages, unitIndex) {
                continue
            }
            if token.Span.Start == marked.Start && token.Span.Length == marked.Text.Length {
                isDeclarationName = true
                break
            }
            ordinal++
        }
        return if isDeclarationName {
            ordinal
        } else {
            nil
        }
    }

    /// Whether [`token`](paramref) is the identifier that names its
    /// declaration — a field/local declarator, a property, a method, a type,
    /// a parameter, or an enum member.
    /// @param token The candidate identifier token.
    /// @returns True when the token names a declaration.
    private func IsDeclarationName(token Microsoft.CodeAnalysis.SyntaxToken) bool -> switch token.Parent {
        case declarator is VariableDeclaratorSyntax: declarator.Identifier == token
        case property is Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax: property.Identifier == token
        case method is MethodDeclarationSyntax: method.Identifier == token
        case type is BaseTypeDeclarationSyntax: type.Identifier == token
        case parameter is Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax: parameter.Identifier == token
        case member is EnumMemberDeclarationSyntax: member.Identifier == token
        default: false
    }

    /// The index of the [`ordinal`](paramref)-th (zero-based) occurrence
    /// of [`text`](paramref) in [`source`](paramref) that is spelled
    /// as a G# DECLARATION name — a whole word immediately preceded, on the
    /// same line, by a declaration keyword — or -1.
    /// @param source The printed G#.
    /// @param text The declaration name.
    /// @param ordinal The zero-based declaration occurrence to find.
    /// @returns The index, or -1.
    private func NthDeclarationOccurrence(source string, text string, ordinal int32) int32 {
        var seen = 0
        for var i = source.IndexOf(text, StringComparison.Ordinal); i >= 0; i = source.IndexOf(
            text,
            i + text.Length,
            StringComparison.Ordinal
        ) {
            if !IsWholeWord(source, i, text.Length) || !FollowsDeclarationKeyword(source, i) {
                continue
            }
            if seen == ordinal {
                return i
            }
            seen++
        }
        return -1
    }

    private func IsWholeWord(source string, index int32, length int32) bool -> (
        index == 0 || !IsIdentifierChar(source[index - 1])
    ) &&
        (index + length >= source.Length || !IsIdentifierChar(source[index + length]))

    private func IsIdentifierChar(c char) bool -> char.IsLetterOrDigit(c) || c == '_' || c == '$'

    // The G# keyword that introduces a declaration name, read backwards from
    // the name over the spaces that separate them. Modifiers (`private`,
    // `shared`) sit BEFORE the keyword, so only the immediately preceding word
    // matters.
    private func FollowsDeclarationKeyword(source string, index int32) bool {
        var end = index
        while end > 0 && source[end - 1] == ' ' {
            end--
        }
        var start = end
        while start > 0 && IsIdentifierChar(source[start - 1]) {
            start--
        }
        if start == end {
            return false
        }
        return switch source.Substring(start, end - start) {
            case "let" or
                "var" or
                "const" or
                "prop" or
                "func" or
                "class" or
                "struct" or
                "interface" or
                "enum" or
                "type" or
                "data": true
            default: false
        }
    }

    private func OccurrenceOrdinal(
        document LoadedDocument,
        source string,
        text string,
        start int32,
        packages IReadOnlyList[string],
        unitIndex int32
    ) int32 {
        var ordinal = 0
        for var i = source.IndexOf(text, StringComparison.Ordinal); i >= 0 && i < start; i = source.IndexOf(
            text,
            i + text.Length,
            StringComparison.Ordinal
        ) {
            if BelongsToUnit(document, i, packages, unitIndex) {
                ordinal++
            }
        }
        return ordinal
    }

    private func OccurrenceOrdinal(
        document LoadedDocument,
        renaming PredefinedRenaming,
        marked MarkedText,
        packages IReadOnlyList[string],
        unitIndex int32
    ) int32 {
        var ordinal = 0
        for var i = renaming.Source.IndexOf(marked.Text, StringComparison.Ordinal);
            i >= 0 &&
            i < marked.Start;
            i = renaming
            .Source
            .IndexOf(marked.Text, i + marked.Text.Length, StringComparison.Ordinal) {
            if BelongsToUnit(document, renaming.OriginalOffset(i), packages, unitIndex) {
                ordinal++
            }
        }
        return ordinal
    }

    private func DeclaredPackageAt(document LoadedDocument, offset int32) string {
        let declaration BaseNamespaceDeclarationSyntax? = document
            .GetRoot()
            .FindToken(offset)
            .Parent
            ?.AncestorsAndSelf()
            .OfType[BaseNamespaceDeclarationSyntax]()
            .FirstOrDefault()
        return if declaration != nil && document.SemanticModel.GetDeclaredSymbol(
            declaration
        ) is INamespaceSymbol symbol {
            symbol.ToDisplayString()
        } else {
            string.Empty
        }
    }

    private func ExpressionOrdinal(
        document LoadedDocument,
        marked MarkedText,
        packages IReadOnlyList[string],
        unitIndex int32
    ) int32 {
        let markedExpression Microsoft
            .CodeAnalysis
            .CSharp
            .Syntax
            .ExpressionSyntax? = document
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
            .FirstOrDefault(
            (
                expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ) -> expression.SpanStart == marked.Start &&
                expression
                .Span
                .Length == marked
                .Text
                .Length
        )
        if markedExpression == nil {
            return -1
        }
        let markedTokens = ExpressionTokenKey(document, markedExpression)
        return document
            .GetRoot()
            .DescendantNodes()
            .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
            .Where(
            (expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> expression.SpanStart < marked.Start
        )
            .Where(
            (expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> BelongsToUnit(
                document,
                expression.SpanStart,
                packages,
                unitIndex
            )
        )
            .Count(
            (expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax) -> string.Equals(
                ExpressionTokenKey(document, expression),
                markedTokens,
                StringComparison.Ordinal
            )
        )
    }

    private func ExpressionTokenKey(document LoadedDocument, expression Microsoft.CodeAnalysis.SyntaxNode) string {
        let tokens = List[string]()
        for token in expression.DescendantTokens() {
            if IsInExplicitDefault(token) {
                if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultKeyword) {
                    tokens.Add("default")
                }
                continue
            }
            if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullKeyword) {
                tokens.Add("nil")
            } else if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultKeyword) {
                tokens.Add("default")
            } else if token.Parent is PredefinedTypeSyntax type &&
                document
                .SemanticModel
                .GetTypeInfo(type)
                .Type is {} symbol &&
                CSharpTypeMapper.GetPredefinedName(symbol.SpecialType) is {} predefined {
                tokens.Add(predefined)
            } else {
                tokens.Add(token.Text)
            }
        }
        return string.Join("\u001F", tokens)
    }

    private func BelongsToUnit(
        document LoadedDocument,
        offset int32,
        packages IReadOnlyList[string],
        unitIndex int32
    ) bool {
        if packages.Count <= 1 {
            return true
        }
        let package_ = DeclaredPackageAt(document, offset)
        return string.Equals(package_, packages[unitIndex], StringComparison.Ordinal) ||
            (unitIndex == 0 && package_.Length == 0)
    }

    private func PackageUnitIndex(packages IReadOnlyList[string], $package string) int32 {
        if $package.Length == 0 {
            return 0
        }
        for var i = 0; i < packages.Count; i++ {
            if string.Equals(packages[i], $package, StringComparison.Ordinal) {
                return i
            }
        }
        return -1
    }

    private func ReportUnplacedMarker(
        marked MarkedText,
        ordinal int32,
        unplaced List[string],
        diagnostics List[TranslationDiagnostic]
    ) {
        unplaced.Add(marked.Text)
        diagnostics.Add(
            TranslationDiagnostic(
                "analyzer-snippet",
                "Marker text '${marked.Text}' does not survive translation verbatim (occurrence ${ordinal + 1} not found); re-place the [|…|] marker in the G# snippet by hand.",
                location: nil,
                TranslationSeverity.Warning
            ){DiagnosticId = SnippetDiagnosticId}
        )
    }

    /// Returns the index of the [`ordinal`](paramref)-th (zero-based)
    /// non-overlapping occurrence of [`text`](paramref), or -1.
    /// @param source The text to scan.
    /// @param text The occurrence text.
    /// @param ordinal The zero-based occurrence to find.
    /// @returns The index, or -1 when there are fewer occurrences.
    private func NthOccurrence(source string, text string, ordinal int32) int32 {
        var index = source.IndexOf(text, StringComparison.Ordinal)
        for var seen = 0; index >= 0 && seen < ordinal; seen++ {
            index = source.IndexOf(text, index + text.Length, StringComparison.Ordinal)
        }
        return index
    }

    /// Issue #4190: retries placement tolerating a `!!` RUNTIME
    /// null-assertion cs2gs inserts immediately after an identifier the
    /// marked text reads — e.g. a guarded reassignment walk,
    /// `current = current.BaseClass`, whose receiver's nullability
    /// cs2gs's flow-sensitive analysis cannot always prove narrowed (a
    /// `do`/`while` loop's post-test guard, in particular, narrows
    /// nothing the G# binder itself recognizes — see
    /// `StatementBinder.Loops.BindDoWhileStatementCore` — so the
    /// bridging `!!` is not merely conservative there; it is required
    /// for the translated G# to bind at all), prints as
    /// `current = current!!.BaseClass`. Unlike (cref:PredefinedRenaming)
    /// (a lexical rename computed from the marked region's own syntax), the
    /// `!!` decision depends on flow analysis of the FULL surrounding method
    /// body, invisible from inside the marked region alone — so instead of
    /// predicting the exact re-spelling, this searches for the marked text
    /// with an OPTIONAL `!!` tolerated after every identifier, keeping
    /// every other character an exact literal match. The same
    /// occurrence-ordinal counted over the UNMODIFIED marker text in the
    /// clean C# source (shared with the plain-match stage above) selects
    /// which tolerant match is the right one, so a repeated marker still
    /// lands on its own occurrence.
    /// @param printed The printed G#.
    /// @param markedText The marker's original C# text.
    /// @param ordinal The zero-based occurrence to find.
    /// @param index The matched span's start index, when found.
    /// @param length The matched span's length, when found.
    /// @returns True when a tolerant match was found.
    private func TryNullForgivingTolerantOccurrence(
        printed string,
        markedText string,
        ordinal int32,
        out index int32,
        out length int32
    ) bool {
        let pattern = Regex(BuildNullForgivingTolerantPattern(markedText), RegexOptions.None)
        var seen = 0
        for var match = pattern.Match(printed); match.Success; match = match.NextMatch() {
            if seen == ordinal {
                index = match.Index
                length = match.Length
                return true
            }
            seen++
        }
        index = -1
        length = 0
        return false
    }

    private func TryFormattingTolerantOccurrence(
        printed string,
        markedText string,
        ordinal int32,
        out index int32,
        out length int32
    ) bool {
        let expression Microsoft.CodeAnalysis.SyntaxNode = SyntaxFactory.ParseExpression(markedText)
        let pattern = StringBuilder()
        for token in expression.DescendantTokens() {
            if IsInExplicitDefault(token) && !token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultKeyword) {
                continue
            }
            if pattern.Length > 0 {
                pattern.Append("\\s*")
            }
            let text = token.Text
            if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.NullKeyword) {
                AppendIdentifierPattern(pattern, "nil")
            } else if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DefaultKeyword) {
                AppendIdentifierPattern(pattern, "default")
                pattern.Append("(?:\\s*\\((?>[^()]|\\((?<depth>)|\\)(?<-depth>))*(?(depth)(?!))\\))?")
            } else {
                if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.IdentifierToken) {
                    AppendIdentifierPattern(pattern, text)
                    pattern.Append("(?:!!)?")
                } else {
                    pattern.Append(Regex.Escape(text))
                    if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.CloseParenToken) || token.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.CloseBracketToken
                    ) {
                        pattern.Append("(?:!!)?")
                    }
                }
            }
        }
        let expressionSpans = GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SyntaxTree
            .Parse(printed)
            .Root
            .DescendantNodesAndSelf()
            .OfType[GSharp.Core.CodeAnalysis.Syntax.ExpressionSyntax]()
            .Select(
            (expression GSharp.Core.CodeAnalysis.Syntax.ExpressionSyntax) -> (
                expression.Span.Start,
                expression.Span.Length
            )
        )
            .ToHashSet()
        var seen = 0
        for var match = Regex.Match(printed, pattern.ToString()); match.Success; match = match.NextMatch() {
            if !expressionSpans.Contains((match.Index, match.Length)) ||
                (match.Index > 0 && printed[match.Index - 1] == '.') {
                continue
            }
            if seen++ == ordinal {
                index = match.Index
                length = match.Length
                return true
            }
        }
        index = -1
        length = 0
        return false
    }

    private func IsInExplicitDefault(token Microsoft.CodeAnalysis.SyntaxToken) bool -> token
        .Parent
        ?.AncestorsAndSelf()
        .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.DefaultExpressionSyntax]()
        .Any() == true

    private func AppendIdentifierPattern(pattern StringBuilder, identifier string) {
        pattern.Append("(?<![\\p{L}\\p{Nd}_$$])")
        pattern.Append(Regex.Escape(identifier))
        pattern.Append("(?![\\p{L}\\p{Nd}_$$])")
    }

    // Builds a regex that matches `text` literally except that an optional
    // `(?:!!)?` is tolerated immediately after every maximal identifier run —
    // the one place cs2gs's runtime null-assertion can be inserted into an
    // otherwise-verbatim expression.
    private func BuildNullForgivingTolerantPattern(text string) string {
        let pattern = StringBuilder(text.Length * 2)
        var i = 0
        while i < text.Length {
            if IsIdentifierChar(text[i]) {
                let start = i
                while i < text.Length && IsIdentifierChar(text[i]) {
                    i++
                }
                pattern.Append(Regex.Escape(text.Substring(start, i - start)))
                pattern.Append("(?:!!)?")
            } else {
                pattern.Append(Regex.Escape(text[i].ToString()))
                i++
            }
        }
        return pattern.ToString()
    }

    private func StripMarkers(source string, markedTexts List[MarkedText]) string {
        let result = StringBuilder(source.Length)
        let markStarts = Stack[int32]()
        for var i = 0; i < source.Length; i++ {
            if i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|' {
                markStarts.Push(result.Length)
                i++
                continue
            }
            if i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']' {
                if markStarts.Count > 0 {
                    let start = markStarts.Pop()
                    markedTexts.Add(MarkedText(result.ToString(start, result.Length - start), start))
                }
                i++
                continue
            }
            result.Append(source[i])
        }
        return result.ToString()
    }
}
