// <copyright file="Issue717ColonEqualsRemovedParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #717 / ADR-0077 — the legacy short variable-declaration operator
/// `:=` has been removed. The lexer still tokenises the operator so the
/// parser can surface a single high-quality `GS0305` diagnostic at the
/// offending span instead of cascading into a thicket of follow-on parse
/// errors. These tests pin down both the diagnostic surface and the
/// recovery behaviour (every removed form should produce exactly one
/// `GS0305` diagnostic and let the rest of the file bind cleanly).
open class Issue717ColonEqualsRemovedParserTests {
    @Fact
    func StandaloneShortVariableDeclaration_ReportsGS0305() {
        const source = `package P
func main() {
    x := 1
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("':=' short variable declaration has been removed", d.Message)
        Assert.Contains("let x = …", d.Message)
        Assert.Contains("var x = …", d.Message)
        Assert.Contains("ADR-0077", d.Message)
    }

    @Fact
    func StandaloneShortVariableDeclaration_SpanCoversColonEqualsToken() {
        // `x := 1` — the `:=` token sits at column 5 (1-based) of line 3.
        const source = `package P
func main() {
    x := 1
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        let location = d.Location
        Assert.Equal(":=", location.Text!!.ToString(location.Span))
    }

    @Fact
    func MultipleShortVariableDeclarations_EmitOneDiagnosticPerSite_NoCascade() {
        const source = `package P
func main() {
    a := 1
    b := 2
    c := 3
    var s = a + b + c
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        Assert.Equal(3, diagnostics.Length)
        // Recovery binds each as a `var`, so the trailing `var s = …` line
        // has every name in scope and produces no further parser diagnostics.
        let tree = SyntaxTree.Parse(source)
        let nonGS0305 = tree.Diagnostics.Where((d Diagnostic) -> d.Id != DiagnosticId).ToArray()
        Assert.Empty(nonGS0305)
    }

    @Fact
    func NestedInBlock_ReportsGS0305() {
        const source = `package P
func main() {
    {
        x := 1
    }
}`
        Assert.Single(ColonEqualsDiagnostics(source))
    }

    @Fact
    func NestedInLambdaBody_ReportsGS0305() {
        const source = `package P
func main() {
    let f = (n int32) -> {
        x := n + 1
        x
    }
    var y = f(2)
}`
        Assert.Single(ColonEqualsDiagnostics(source))
    }

    @Fact
    func NestedInFunctionBody_ReportsGS0305() {
        const source = `package P
func inner() {
    x := 1
}
func main() {
    inner()
}`
        Assert.Single(ColonEqualsDiagnostics(source))
    }

    @Fact
    func MultiTargetShortDeclaration_ReportsGS0305() {
        const source = `package P
func main() {
    a, b := 1, 2
    var s = a + b
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("':=' short variable declaration has been removed", d.Message)
        // Recovery treats the operator as `=` and leaves a well-formed
        // multi-assignment tree; binding may report undefined targets separately.
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics.Where((x Diagnostic) -> x.Id != DiagnosticId))
    }

    @Fact
    func ForRangeWithColonEquals_ReportsGS0305() {
        const source = `package P
func main() {
    let xs = [1, 2, 3]
    for v := range xs {
        var s = v + 1
    }
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("for v in", d.Message)
    }

    @Fact
    func ForKVRangeWithColonEquals_ReportsGS0305() {
        const source = `package P
func main() {
    let xs = [10, 20, 30]
    for i, v := range xs {
        var s = i + v
    }
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("for i, v in", d.Message)
    }

    @Fact
    func ForEllipsisWithColonEquals_ReportsGS0305() {
        const source = `package P
func main() {
    for i := 0 ... 3 {
        var s = i
    }
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("for i in lo ... hi", d.Message)
    }

    @Fact
    func ForClauseInitWithColonEquals_ReportsGS0305() {
        const source = `package P
func main() {
    for i := 0; i < 3; i++ {
        var s = i
    }
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("let i = …", d.Message)
        Assert.Contains("var i = …", d.Message)
    }

    @Fact
    func IfInitWithColonEquals_ReportsGS0305() {
        const source = `package P
func main() {
    if x := 1; x > 0 {
        var y = x
    }
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        Assert.Single(diagnostics)
    }

    @Fact
    func AwaitForRangeWithColonEquals_ReportsGS0305() {
        const source = `package P
import System.Collections.Generic
async func main() {
    await for v := range Stream() {
        var s = v
    }
}
async func Stream() async sequence[int32] {
    yield 1
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("await for v in", d.Message)
    }

    @Fact
    func SelectCaseBindWithColonEquals_ReportsGS0305() {
        const source = `package P
func main() {
    let ch = chan(int32)(1)
    go func () {
        ch <- 1
    }()
    select {
        case v := <-ch {
            var s = v
        }
    }
}`
        let diagnostics = ColonEqualsDiagnostics(source)
        let d = Assert.Single(diagnostics)
        Assert.Contains("case let v = <-ch", d.Message)
    }

    @Fact
    func CanonicalForms_DoNotReportGS0305() {
        const source = `package P
func main() {
    let x = 1
    var y = 2
    let xs = [1, 2, 3]
    for v in xs {
        var s = v
    }
    for i in 0 ... 3 {
        var s = i
    }
    for var k = 0; k < 3; k++ {
        var s = k
    }
    if var z = 1; z > 0 {
        var s = z
    }
}`
        Assert.Empty(ColonEqualsDiagnostics(source))
    }

    @Fact
    func LexerStillTokenisesColonEquals_SoDiagnosticsTargetTheToken() {
        // Confirm the lexer still emits a ColonEqualsToken even though the
        // parser hard-rejects every use. Without this guarantee the parser
        // diagnostic would degrade to a generic "unexpected `:`" error.
        let tokens = SyntaxTree
            .ParseTokens(":=")
            .Where((t SyntaxToken) -> t.Kind != SyntaxKind.EndOfFileToken && t.Kind != SyntaxKind.WhitespaceToken)
            .ToArray()
        let token = Assert.Single(tokens)
        Assert.Equal(SyntaxKind.ColonEqualsToken, token.Kind)
        Assert.Equal(":=", token.Text)
    }

    shared {
        private const DiagnosticId string = "GS0305"

        private func ColonEqualsDiagnostics(source string)[]Diagnostic {
            let tree = SyntaxTree.Parse(source)
            return tree.Diagnostics.Where((d Diagnostic) -> d.Id == DiagnosticId).ToArray()
        }
    }
}
