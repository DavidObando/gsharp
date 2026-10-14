// <copyright file="Issue805MapTypeClauseSpellingParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #805 / ADR-0104 — the legacy Go-flavored map type-clause
/// spelling `map[K]V` has been removed. The canonical G# spelling
/// is `map[K,V]` with both type arguments inside the brackets,
/// separated by a comma. The parser still recognizes the legacy shape
/// long enough to emit a span-accurate (cref:DiagnosticId)
/// diagnostic ("did you mean `map[K,V]`?") so the file does not
/// cascade into a thicket of follow-on parse errors.
open class Issue805MapTypeClauseSpellingParserTests {
    // --- canonical `map[K,V]` is accepted in every type-clause slot ---
    @Theory
    @InlineData("var m map[string,int32] = map[string,int32]{\"a\": 1}")
    @InlineData("let m = map[string,int32]{\"a\": 1}")
    @InlineData("let m = map[int32,string]{1: \"one\"}")
    @InlineData("let m = map[string,string?]{}")
    @InlineData("let m map[string,int32]? = nil")
    @InlineData("let m sequence[map[string,int32]] = nil")
    @InlineData("let m = map[string,async sequence[int32]]{}")
    func CanonicalSpelling_IsAcceptedInAllTypeClauseSlots(statement string) {
        let source = (`package P
func main() {
    ` + "$statement" + `
}`)
        let diagnostics = AllParserDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func CanonicalSpelling_InFunctionSignatures_NoDiagnostics() {
        const source = `package P

func makeIndex() map[string,int32] {
    return map[string,int32]{"a": 1}
}

func sum(m map[string,int32]) int32 {
    return 0
}`
        Assert.Empty(AllParserDiagnostics(source))
    }

    @Fact
    func CanonicalSpelling_InReceiverClause_NoDiagnostics() {
        const source = `package P

func (self map[K,V]) CountKeys[K, V]() int32 {
    return 0
}`
        Assert.Empty(AllParserDiagnostics(source))
    }

    // --- legacy `map[K]V` is rejected with GS0366 ---
    @Fact
    func LegacySpelling_InLocalDeclaration_ReportsGS0366() {
        const source = `package P
func main() {
    var m = map[string]int32{"a": 1}
}`
        let diagnostics = LegacyMapDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("'map[K]V' type-clause spelling has been removed", d.Message)
        Assert.Contains("map[string,int32]", d.Message)
        Assert.Contains("ADR-0104", d.Message)
    }

    @Fact
    func LegacySpelling_DiagnosticSpan_CoversWholeShape() {
        // `map[string]int32` is the full offending shape; the diagnostic
        // span must run from `map` through the value type so an IDE
        // quick-fix can replace the whole construct in one edit.
        const source = `package P
func main() {
    var m = map[string]int32{"a": 1}
}`
        let d = Assert.Single(LegacyMapDiagnostics(source))
        let spanText = d.Location.Text!!.ToString(d.Location.Span)
        Assert.Equal("map[string]int32", spanText)
    }

    @Fact
    func LegacySpelling_InReturnType_ReportsGS0366() {
        const source = `package P
func makeIndex() map[string]int32 {
    return map[string,int32]{}
}`
        let diagnostics = LegacyMapDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("map[string,int32]", d.Message)
    }

    @Fact
    func LegacySpelling_InParameterType_ReportsGS0366() {
        const source = `package P
func sum(m map[string]int32) int32 {
    return 0
}`
        let d = Assert.Single(LegacyMapDiagnostics(source))
        Assert.Contains("map[string,int32]", d.Message)
    }

    @Fact
    func LegacySpelling_InReceiverClause_ReportsGS0366() {
        const source = `package P
func (self map[K]V) CountKeys[K, V]() int32 {
    return 0
}`
        let d = Assert.Single(LegacyMapDiagnostics(source))
        Assert.Contains("map[K,V]", d.Message)
    }

    @Fact
    func LegacySpelling_InFieldDeclaration_ReportsGS0366() {
        const source = `package P
class Counter {
    var bins map[string]int32 = map[string,int32]{}
}`
        let d = Assert.Single(LegacyMapDiagnostics(source))
        Assert.Contains("map[string,int32]", d.Message)
    }

    @Fact
    func LegacySpelling_InNestedTypeClause_ReportsGS0366() {
        const source = `package P
func main() {
    let m sequence[map[string]int32] = nil
}`
        let d = Assert.Single(LegacyMapDiagnostics(source))
        Assert.Contains("map[string,int32]", d.Message)
    }

    // --- mixed forms in same file: multiple diagnostics, no cascades ---
    @Fact
    func MixedForms_EmitOneDiagnosticPerLegacySite_NoCascade() {
        const source = `package P

func legacyReturn() map[string]int32 {
    return map[string,int32]{}
}

func legacyParam(m map[string]int32) int32 {
    return 0
}

func main() {
    var a = map[string,int32]{"a": 1}
    var b = map[int32]string{1: "one"}
    var c = map[string,string]{}
    var d = map[string]string?{}
}`
        let diagnostics = LegacyMapDiagnostics(source)
        // Four legacy occurrences: legacyReturn return type, legacyParam
        // parameter type, the `map[int32]string` literal, and the
        // `map[string]string?` literal.
        Assert.Equal(4, diagnostics.Length)
        // No cascade: the parser recovers each legacy shape into the
        // canonical bound form, so no other parser diagnostics fire.
        let tree = SyntaxTree.Parse(source)
        let nonGS0366 = tree.Diagnostics.Where((d Diagnostic) -> d.Id != DiagnosticId).ToArray()
        Assert.Empty(nonGS0366)
    }

    @Fact
    func MixedForms_EveryDiagnosticCarriesItsOwnReplacement() {
        const source = `package P
func main() {
    var a = map[string]int32{"a": 1}
    var b = map[K]V{}
}`
        let diagnostics = LegacyMapDiagnostics(source)
        Assert.Equal(2, diagnostics.Length)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("map[string,int32]"))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("map[K,V]"))
    }

    shared {
        private const DiagnosticId string = "GS0366"

        private func LegacyMapDiagnostics(source string)[]Diagnostic {
            let tree = SyntaxTree.Parse(source)
            return tree.Diagnostics.Where((d Diagnostic) -> d.Id == DiagnosticId).ToArray()
        }

        private func AllParserDiagnostics(source string)[]Diagnostic {
            let tree = SyntaxTree.Parse(source)
            return tree.Diagnostics.ToArray()
        }
    }
}
