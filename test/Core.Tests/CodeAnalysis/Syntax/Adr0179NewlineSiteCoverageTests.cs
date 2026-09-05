// <copyright file="Adr0179NewlineSiteCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public sealed class Adr0179NewlineSiteCoverageTests
{
    [Fact]
    public void ParserNewlineSensitiveSites_AreExplicitlyInventoried()
    {
        string syntaxDirectory = Path.Combine(FindRepositoryRoot(), "src", "Core", "CodeAnalysis", "Syntax");
        string[] actual = Directory.EnumerateFiles(syntaxDirectory, "Parser*.cs")
            .Where(path => Path.GetFileName(path) != "Parser.cs")
            .SelectMany(path => File.ReadLines(path).Select(line => (Path: path, Line: line.Trim())))
            .Where(item => item.Line.Contains("IsCurrentOnNewLineAfter(", StringComparison.Ordinal)
                || item.Line.Contains("IsTokenOnNewLineAfter(", StringComparison.Ordinal)
                || item.Line.Contains("GetLineIndex(", StringComparison.Ordinal))
            .Select(item => Path.GetFileName(item.Path) + ":" + item.Line)
            .OrderBy(site => site, StringComparer.Ordinal)
            .ToArray();

        string[] expected =
        {
            "Parser.Expressions.Creation.cs:&& !IsTokenOnNewLineAfter(Current, call.CloseParenthesisToken)",
            "Parser.Expressions.Creation.cs:&& !IsTokenOnNewLineAfter(Peek(1), Current);",
            "Parser.Expressions.Creation.cs:&& !IsTokenOnNewLineAfter(Peek(1), Current))",
            "Parser.Expressions.Creation.cs:if (IsTokenOnNewLineAfter(Peek(pos), Peek(pos - 1)))",
            "Parser.Expressions.Literals.cs:&& IsTokenOnNewLineAfter(continuation, closeBrace))",
            "Parser.Expressions.cs:&& !IsCurrentOnNewLineAfter(current))",
            "Parser.Expressions.cs:&& !IsCurrentOnNewLineAfter(left))",
            "Parser.Expressions.cs:if (Current.Kind == SyntaxKind.StarToken && IsCurrentOnNewLineAfter(left))",
            "Parser.Expressions.cs:if (IsCurrentOnNewLineAfter(dotDotToken))",
            "Parser.Patterns.cs:|| IsTokenOnNewLineAfter(Current, trialType)",
            "Parser.Patterns.cs:return !IsTokenOnNewLineAfter(token, precedingNode);",
            "Parser.Statements.cs:&& syntaxTree.Text.GetLineIndex(Peek(1).Span.Start) == keywordLine)",
            "Parser.Statements.cs:var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);",
            "Parser.Statements.cs:var currentLine = syntaxTree.Text.GetLineIndex(Current.Span.Start);",
            "Parser.Statements.cs:var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);",
            "Parser.Statements.cs:var keywordLine = syntaxTree.Text.GetLineIndex(keyword.Span.Start);",
        };

        Assert.Equal(expected.OrderBy(site => site, StringComparer.Ordinal), actual);
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate GSharp.sln.");
    }
}
