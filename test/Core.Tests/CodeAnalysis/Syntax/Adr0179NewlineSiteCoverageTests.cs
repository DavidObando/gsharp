// <copyright file="Adr0179NewlineSiteCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public sealed class Adr0179NewlineSiteCoverageTests
{
    // Issue #4656: one newline-sensitive call, with its arguments and any
    // leading negation. Matching the CALL rather than the trimmed line makes the
    // inventory the same in C# (`&& !IsTokenOnNewLineAfter(a, b))`) and in G#
    // (`!IsTokenOnNewLineAfter(a, b) &&`): only the surrounding syntax differs.
    private static readonly Regex NewlineSensitiveCall = new(
        @"!?\b(?:IsCurrentOnNewLineAfter|IsTokenOnNewLineAfter|GetLineIndex)\((?:[^()]|\([^()]*\))*\)",
        RegexOptions.Compiled);

    [Fact]
    public void ParserNewlineSensitiveSites_AreExplicitlyInventoried()
    {
        string[] actual = TestSource.SourceFilesMatching("Parser*", SearchOption.TopDirectoryOnly, "src/Core/CodeAnalysis/Syntax")
            .Where(path => Path.GetFileNameWithoutExtension(path) != "Parser")
            .SelectMany(path => File.ReadLines(path)
                .Where(line => !line.TrimStart().StartsWith("//", StringComparison.Ordinal))
                .SelectMany(line => NewlineSensitiveCall.Matches(line).Select(match => match.Value))
                .Select(call => Path.GetFileNameWithoutExtension(path) + ": " + call))
            .OrderBy(site => site, StringComparer.Ordinal)
            .ToArray();

        string[] expected =
        {
            "Parser.Expressions.Creation: !IsTokenOnNewLineAfter(Current, call.CloseParenthesisToken)",
            "Parser.Expressions.Creation: !IsTokenOnNewLineAfter(Peek(1), Current)",
            "Parser.Expressions.Creation: !IsTokenOnNewLineAfter(Peek(1), Current)",
            "Parser.Expressions.Creation: IsTokenOnNewLineAfter(Peek(pos), Peek(pos - 1))",
            "Parser.Expressions.Literals: IsTokenOnNewLineAfter(continuation, closeBrace)",
            "Parser.Expressions: !IsCurrentOnNewLineAfter(current)",
            "Parser.Expressions: !IsCurrentOnNewLineAfter(left)",
            "Parser.Expressions: IsCurrentOnNewLineAfter(dotDotToken)",
            "Parser.Expressions: IsCurrentOnNewLineAfter(left)",
            "Parser.Patterns: !IsTokenOnNewLineAfter(token, precedingNode)",
            "Parser.Patterns: IsTokenOnNewLineAfter(Current, trialType)",
            "Parser.Statements: GetLineIndex(Current.Span.Start)",
            "Parser.Statements: GetLineIndex(Current.Span.Start)",
            "Parser.Statements: GetLineIndex(Peek(1).Span.Start)",
            "Parser.Statements: GetLineIndex(keyword.Span.Start)",
            "Parser.Statements: GetLineIndex(keyword.Span.Start)",
        };

        Assert.Equal(expected.OrderBy(site => site, StringComparer.Ordinal), actual);
    }
}
