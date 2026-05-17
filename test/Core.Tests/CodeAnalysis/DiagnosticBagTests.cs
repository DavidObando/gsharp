// <copyright file="DiagnosticBagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

public class DiagnosticBagTests
{
    [Fact]
    public void Report_Adds_Diagnostic_And_Is_Enumerable()
    {
        var bag = new DiagnosticBag();
        var location = MakeLocation("hello world");
        bag.ReportUnterminatedString(location);
        bag.ReportBadCharacter(location, '`');

        var diagnostics = bag.ToArray();
        Assert.Equal(2, diagnostics.Length);
        Assert.Contains(diagnostics, d => d.Message.Contains("Unterminated string"));
        Assert.Contains(diagnostics, d => d.Message.Contains("`"));
    }

    [Fact]
    public void AddRange_Copies_From_Source_Bag()
    {
        var location = MakeLocation("source");
        var source = new DiagnosticBag();
        source.ReportUnexpectedToken(location, SyntaxKind.PlusToken, SyntaxKind.NumberToken);
        source.ReportInvalidReturn(location);

        var target = new DiagnosticBag();
        target.AddRange(source);

        Assert.Equal(2, target.Count());
    }

    [Fact]
    public void Diagnostic_ToString_Returns_Message()
    {
        var location = MakeLocation("x");
        var d = new Diagnostic(location, "boom");
        Assert.Equal("boom", d.ToString());
        Assert.Equal(location, d.Location);
    }

    private static TextLocation MakeLocation(string text)
    {
        var source = SourceText.From(text);
        return new TextLocation(source, new TextSpan(0, text.Length));
    }
}
