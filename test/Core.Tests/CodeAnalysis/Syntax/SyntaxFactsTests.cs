// <copyright file="SyntaxFactsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class SyntaxFactsTests
{
    [Theory]
    [InlineData("break", SyntaxKind.BreakKeyword)]
    [InlineData("func", SyntaxKind.FuncKeyword)]
    [InlineData("notAKeyword", SyntaxKind.IdentifierToken)]
    public void GetKeywordKind_ReturnsExpected(string text, SyntaxKind expected)
    {
        Assert.Equal(expected, SyntaxFacts.GetKeywordKind(text));
    }

    [Theory]
    [InlineData("class", true)]
    [InlineData("params", false)]
    [InlineData("scoped", false)]
    public void IsReservedIdentifier_ReturnsExpected(string text, bool expected)
    {
        Assert.Equal(expected, SyntaxFacts.IsReservedIdentifier(text));
    }

    [Theory]
    [InlineData("params", IdentifierNameContext.Parameter)]
    [InlineData("scoped", IdentifierNameContext.Parameter)]
    [InlineData("ref", IdentifierNameContext.Parameter)]
    [InlineData("out", IdentifierNameContext.Parameter)]
    [InlineData("in", IdentifierNameContext.Parameter)]
    [InlineData("scoped", IdentifierNameContext.Local)]
    [InlineData("ref", IdentifierNameContext.Local)]
    [InlineData("in", IdentifierNameContext.TypeParameter)]
    [InlineData("out", IdentifierNameContext.TypeParameter)]
    [InlineData("nameof", IdentifierNameContext.Invocation)]
    [InlineData("checked", IdentifierNameContext.Invocation)]
    [InlineData("unchecked", IdentifierNameContext.Invocation)]
    [InlineData("typeof", IdentifierNameContext.Invocation)]
    [InlineData("sizeof", IdentifierNameContext.Invocation)]
    [InlineData("make", IdentifierNameContext.Invocation)]
    [InlineData("init", IdentifierNameContext.Invocation)]
    [InlineData("when", IdentifierNameContext.Pattern)]
    [InlineData("and", IdentifierNameContext.Pattern)]
    [InlineData("or", IdentifierNameContext.Pattern)]
    [InlineData("event", IdentifierNameContext.Type)]
    [InlineData("prop", IdentifierNameContext.Type)]
    [InlineData("init", IdentifierNameContext.Type)]
    [InlineData("convenience", IdentifierNameContext.Type)]
    [InlineData("shared", IdentifierNameContext.Type)]
    [InlineData("delegate", IdentifierNameContext.Type)]
    [InlineData("unmanaged", IdentifierNameContext.Type)]
    [InlineData("stackalloc", IdentifierNameContext.Index)]
    [InlineData("base", IdentifierNameContext.Index)]
    public void IsReservedIdentifier_ContextualSpellings_ReturnTrue(
        string text,
        IdentifierNameContext context)
    {
        Assert.True(SyntaxFacts.IsReservedIdentifier(text, context));
    }

    [Fact]
    public void GetEmittedIdentifier_ReservesLegalSourceNamesBeforeSuffixing()
    {
        string[] names = { "params", "params_" };

        Assert.Equal(
            "params__",
            SyntaxFacts.GetEmittedIdentifier(
                "params",
                IdentifierNameContext.Parameter,
                names));
        Assert.Equal(
            "params_",
            SyntaxFacts.GetEmittedIdentifier(
                "params_",
                IdentifierNameContext.Parameter,
                names));
    }

    [Theory]
    [InlineData(SyntaxKind.PlusToken, "+")]
    [InlineData(SyntaxKind.FuncKeyword, "func")]
    [InlineData(SyntaxKind.ColonEqualsToken, ":=")]
    [InlineData(SyntaxKind.DotDotToken, "..")]
    public void GetText_ReturnsExpected(SyntaxKind kind, string expected)
    {
        Assert.Equal(expected, SyntaxFacts.GetText(kind));
    }

    [Fact]
    public void GetText_Unknown_ReturnsNull()
    {
        Assert.Null(SyntaxFacts.GetText(SyntaxKind.IdentifierToken));
    }

    [Fact]
    public void GetText_RoundTripsThroughGetKeywordKind()
    {
        var keywordKinds = Enum.GetValues<SyntaxKind>()
            .Where(k => k.ToString().EndsWith("Keyword", StringComparison.Ordinal));
        foreach (var kind in keywordKinds)
        {
            var text = SyntaxFacts.GetText(kind);
            Assert.NotNull(text);
            Assert.Equal(kind, SyntaxFacts.GetKeywordKind(text));
        }
    }

    [Fact]
    public void GetBinaryOperatorKinds_AreNonZeroPrecedence()
    {
        var ops = SyntaxFacts.GetBinaryOperatorKinds().ToArray();
        Assert.NotEmpty(ops);
        Assert.All(ops, k => Assert.True(SyntaxOperatorFacts.GetBinaryOperatorPrecedence(k) > 0));
    }

    [Fact]
    public void GetUnaryOperatorKinds_AreNonZeroPrecedence()
    {
        var ops = SyntaxFacts.GetUnaryOperatorKinds().ToArray();
        Assert.NotEmpty(ops);
        Assert.All(ops, k => Assert.True(SyntaxOperatorFacts.GetUnaryOperatorPrecedence(k) > 0));
    }
}
