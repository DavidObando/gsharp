// <copyright file="TextWriterExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.IO;
using Xunit;

namespace GSharp.Core.Tests.IO;

public class TextWriterExtensionsTests
{
    [Fact]
    public void WriteDiagnostics_MultiLineSpan_DoesNotThrow_AndRendersMessage()
    {
        var sourceText = SourceText.From("let x = foo(\r\n    bar,\r\n    baz)\r\n", "test.gs");

        // A span that starts on the first line and ends on the third line.
        var span = TextSpan.FromBounds(8, sourceText.Length - 2);
        var location = new TextLocation(sourceText, span);
        var diagnostic = new Diagnostic(location, "GS0159", DiagnosticSeverity.Error, "Cannot find function Run.");

        using var writer = new StringWriter();

        var exception = Record.Exception(() => writer.WriteDiagnostics(new[] { diagnostic }));

        Assert.Null(exception);
        Assert.Contains("error GS0159: Cannot find function Run.", writer.ToString());
    }

    [Fact]
    public void WriteDiagnostics_SingleLineSpan_RendersSnippet()
    {
        var sourceText = SourceText.From("let x = boom", "test.gs");
        var span = TextSpan.FromBounds(8, 12);
        var location = new TextLocation(sourceText, span);
        var diagnostic = new Diagnostic(location, "GS0001", DiagnosticSeverity.Error, "bad value");

        using var writer = new StringWriter();
        writer.WriteDiagnostics(new[] { diagnostic });

        var output = writer.ToString();
        Assert.Contains("let x = ", output);
        Assert.Contains("boom", output);
    }

    [Fact]
    public void WriteDiagnostics_SpanAtEndOfFile_DoesNotThrow()
    {
        var sourceText = SourceText.From("let x = 1\r\n", "test.gs");
        var span = new TextSpan(sourceText.Length, 0);
        var location = new TextLocation(sourceText, span);
        var diagnostic = new Diagnostic(location, "GS0002", DiagnosticSeverity.Error, "unexpected end of file");

        using var writer = new StringWriter();

        var exception = Record.Exception(() => writer.WriteDiagnostics(new[] { diagnostic }));

        Assert.Null(exception);
        Assert.Contains("unexpected end of file", writer.ToString());
    }

    [Fact]
    public void WriteDiagnostics_MixedWithLocationLessDiagnostic_DoesNotThrow()
    {
        // Issue #2144: a location-less diagnostic (default(TextLocation), so
        // Text == null) mixed with located ones must not make the location
        // sort throw "Failed to compare two elements in the array" (which the
        // compiler otherwise surfaces as GS9998, masking every diagnostic).
        var sourceText = SourceText.From("let x = boom", "test.gs");
        var located = new Diagnostic(
            new TextLocation(sourceText, TextSpan.FromBounds(8, 12)),
            "GS0001",
            DiagnosticSeverity.Error,
            "bad value");
        var locationLess = new Diagnostic(default, "GS9999", DiagnosticSeverity.Error, "no location here");

        using var writer = new StringWriter();

        var exception = Record.Exception(() => writer.WriteDiagnostics(new[] { located, locationLess }));

        Assert.Null(exception);
        var output = writer.ToString();
        Assert.Contains("bad value", output);
        Assert.Contains("no location here", output);
    }

    [Fact]
    public void TextLocation_CompareTo_IsTotalAndNullSafe()
    {
        // Issue #2144: CompareTo must never throw and must be a consistent
        // total order, even when either side is a default(TextLocation).
        var text = SourceText.From("abc", "a.gs");
        var located = new TextLocation(text, new TextSpan(0, 1));
        TextLocation none = default;

        Assert.Equal(0, none.CompareTo(default));
        Assert.True(none.CompareTo(located) < 0);
        Assert.True(located.CompareTo(none) > 0);
        Assert.Equal(0, located.CompareTo(located));
    }
}
