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
}
