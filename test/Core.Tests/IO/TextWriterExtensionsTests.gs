// <copyright file="TextWriterExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.IO

import System.IO
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.IO
import Xunit

open class TextWriterExtensionsTests {
    @Fact
    func WriteDiagnostics_MultiLineSpan_DoesNotThrow_AndRendersMessage() {
        let sourceText = SourceText.From("let x = foo(\r\n    bar,\r\n    baz)\r\n", "test.gs")
        // A span that starts on the first line and ends on the third line.
        let span = TextSpan.FromBounds(8, sourceText.Length - 2)
        let location = TextLocation(sourceText, span)
        let diagnostic = Diagnostic(location, "GS0159", DiagnosticSeverity.Error, "Cannot find function Run.")
        using let writer = StringWriter()
        let exception = Record.Exception(() -> DiagnosticWriter.WriteDiagnostics(writer, []Diagnostic{diagnostic}))
        Assert.Null(exception)
        Assert.Contains("error GS0159: Cannot find function Run.", writer.ToString())
    }

    @Fact
    func WriteDiagnostics_SingleLineSpan_RendersSnippet() {
        let sourceText = SourceText.From("let x = boom", "test.gs")
        let span = TextSpan.FromBounds(8, 12)
        let location = TextLocation(sourceText, span)
        let diagnostic = Diagnostic(location, "GS0001", DiagnosticSeverity.Error, "bad value")
        using let writer = StringWriter()
        DiagnosticWriter.WriteDiagnostics(writer, []Diagnostic{diagnostic})
        let output = writer.ToString()
        Assert.Contains("let x = ", output)
        Assert.Contains("boom", output)
    }

    @Fact
    func DiagnosticWriter_WriteDiagnostics_RendersThroughStableType() {
        let diagnostic = Diagnostic(
            default(TextLocation),
            "GS9999",
            DiagnosticSeverity.Error,
            "stable diagnostic entry point"
        )
        using let writer = StringWriter()
        DiagnosticWriter.WriteDiagnostics(writer, []Diagnostic{diagnostic})
        Assert.Contains("error GS9999: stable diagnostic entry point", writer.ToString())
    }

    @Fact
    func WriteDiagnostics_SpanAtEndOfFile_DoesNotThrow() {
        let sourceText = SourceText.From("let x = 1\r\n", "test.gs")
        let span = TextSpan(sourceText.Length, 0)
        let location = TextLocation(sourceText, span)
        let diagnostic = Diagnostic(location, "GS0002", DiagnosticSeverity.Error, "unexpected end of file")
        using let writer = StringWriter()
        let exception = Record.Exception(() -> DiagnosticWriter.WriteDiagnostics(writer, []Diagnostic{diagnostic}))
        Assert.Null(exception)
        Assert.Contains("unexpected end of file", writer.ToString())
    }

    @Fact
    func WriteDiagnostics_MixedWithLocationLessDiagnostic_DoesNotThrow() {
        // Issue #2144: a location-less diagnostic (default(TextLocation), so
        // Text == null) mixed with located ones must not make the location
        // sort throw "Failed to compare two elements in the array" (which the
        // compiler otherwise surfaces as GS9998, masking every diagnostic).
        let sourceText = SourceText.From("let x = boom", "test.gs")
        let located = Diagnostic(
            TextLocation(sourceText, TextSpan.FromBounds(8, 12)),
            "GS0001",
            DiagnosticSeverity.Error,
            "bad value"
        )
        let locationLess = Diagnostic(default(TextLocation), "GS9999", DiagnosticSeverity.Error, "no location here")
        using let writer = StringWriter()
        let exception = Record.Exception(
            () -> DiagnosticWriter.WriteDiagnostics(writer, []Diagnostic{located, locationLess})
        )
        Assert.Null(exception)
        let output = writer.ToString()
        Assert.Contains("bad value", output)
        Assert.Contains("no location here", output)
    }

    @Fact
    func TextLocation_CompareTo_IsTotalAndNullSafe() {
        // Issue #2144: CompareTo must never throw and must be a consistent
        // total order, even when either side is a default(TextLocation).
        let text = SourceText.From("abc", "a.gs")
        var located = TextLocation(text, TextSpan(0, 1))
        var none = default(TextLocation)
        Assert.Equal(0, none.CompareTo(default(TextLocation)))
        Assert.True(none.CompareTo(located) < 0)
        Assert.True(located.CompareTo(none) > 0)
        Assert.Equal(0, located.CompareTo(located))
    }
}
