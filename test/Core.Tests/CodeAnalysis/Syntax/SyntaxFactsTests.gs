// <copyright file="SyntaxFactsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Linq
import Xunit

open class SyntaxFactsTests {
    @Theory
    @InlineData("break", SyntaxKind(72))
    @InlineData("func", SyntaxKind(87))
    @InlineData("notAKeyword", SyntaxKind(68))
    func GetKeywordKind_ReturnsExpected(text string, expected SyntaxKind) {
        Assert.Equal(expected, SyntaxFacts.GetKeywordKind(text))
    }

    @Theory
    @InlineData("class", true)
    @InlineData("params", false)
    @InlineData("scoped", false)
    func IsReservedIdentifier_ReturnsExpected(text string, expected bool) {
        Assert.Equal(expected, SyntaxFacts.IsReservedIdentifier(text))
    }

    @Theory
    @InlineData("params", IdentifierNameContext(1))
    @InlineData("scoped", IdentifierNameContext(1))
    @InlineData("ref", IdentifierNameContext(1))
    @InlineData("out", IdentifierNameContext(1))
    @InlineData("in", IdentifierNameContext(1))
    @InlineData("scoped", IdentifierNameContext(2))
    @InlineData("ref", IdentifierNameContext(2))
    @InlineData("in", IdentifierNameContext(4))
    @InlineData("out", IdentifierNameContext(4))
    @InlineData("nameof", IdentifierNameContext(8))
    @InlineData("checked", IdentifierNameContext(8))
    @InlineData("unchecked", IdentifierNameContext(8))
    @InlineData("typeof", IdentifierNameContext(8))
    @InlineData("sizeof", IdentifierNameContext(8))
    @InlineData("init", IdentifierNameContext(8))
    @InlineData("when", IdentifierNameContext(16))
    @InlineData("and", IdentifierNameContext(16))
    @InlineData("or", IdentifierNameContext(16))
    @InlineData("not", IdentifierNameContext(16))
    @InlineData("event", IdentifierNameContext(32))
    @InlineData("prop", IdentifierNameContext(32))
    @InlineData("init", IdentifierNameContext(32))
    @InlineData("convenience", IdentifierNameContext(32))
    @InlineData("shared", IdentifierNameContext(32))
    @InlineData("delegate", IdentifierNameContext(32))
    @InlineData("unmanaged", IdentifierNameContext(32))
    @InlineData("stackalloc", IdentifierNameContext(64))
    @InlineData("base", IdentifierNameContext(64))
    func IsReservedIdentifier_ContextualSpellings_ReturnTrue(text string, context IdentifierNameContext) {
        Assert.True(SyntaxFacts.IsReservedIdentifier(text, context))
    }

    @Fact
    func GetEmittedIdentifier_ReservesLegalSourceNamesBeforeSuffixing() {
        let names[]string = []string{"params", "params_"}
        Assert.Equal("params__", SyntaxFacts.GetEmittedIdentifier("params", IdentifierNameContext.Parameter, names))
        Assert.Equal("params_", SyntaxFacts.GetEmittedIdentifier("params_", IdentifierNameContext.Parameter, names))
    }

    @Theory
    @InlineData(SyntaxKind(5), "+")
    @InlineData(SyntaxKind(87), "func")
    @InlineData(SyntaxKind(24), ":=")
    @InlineData(SyntaxKind(28), "..")
    func GetText_ReturnsExpected(kind SyntaxKind, expected string) {
        Assert.Equal(expected, SyntaxFacts.GetText(kind))
    }

    @Fact
    func GetText_Unknown_ReturnsNull() {
        Assert.Null(SyntaxFacts.GetText(SyntaxKind.IdentifierToken))
    }

    @Fact
    func GetText_RoundTripsThroughGetKeywordKind() {
        let keywordKinds = Enum.GetValues[SyntaxKind]().Where(
            (k SyntaxKind) -> k.ToString().EndsWith("Keyword", StringComparison.Ordinal) && k != SyntaxKind.TypeKeyword
        )
        for kind in keywordKinds {
            let text string? = SyntaxFacts.GetText(kind)
            Assert.NotNull(text)
            Assert.Equal(kind, SyntaxFacts.GetKeywordKind(text!!))
        }
    }

    @Fact
    func GetBinaryOperatorKinds_AreNonZeroPrecedence() {
        let ops = SyntaxFacts.GetBinaryOperatorKinds().ToArray()
        Assert.NotEmpty(ops)
        Assert.All(ops, (k SyntaxKind) -> Assert.True(SyntaxOperatorFacts.GetBinaryOperatorPrecedence(k) > 0))
    }

    @Fact
    func GetUnaryOperatorKinds_AreNonZeroPrecedence() {
        let ops = SyntaxFacts.GetUnaryOperatorKinds().ToArray()
        Assert.NotEmpty(ops)
        Assert.All(ops, (k SyntaxKind) -> Assert.True(SyntaxOperatorFacts.GetUnaryOperatorPrecedence(k) > 0))
    }
}
