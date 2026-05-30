// <copyright file="FormattingEngineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class FormattingEngineTests
{
    [Fact]
    public void Format_IndentsFunctionBody()
    {
        const string input = "func add(a int32, b int32) int32 {\nreturn a + b\n}\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("  return", result);
    }

    [Fact]
    public void Format_PreservesComments()
    {
        const string input = "// a comment\nvar x = 1\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("// a comment", result);
    }

    [Fact]
    public void Format_EndsWithNewline()
    {
        const string input = "var x = 1";
        var result = FormattingEngine.Format(input);

        Assert.EndsWith("\n", result);
    }

    [Fact]
    public void Format_HandlesNestedBraces()
    {
        const string input = "func foo() {\nif true {\nvar x = 1\n}\n}\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("    var x", result); // double indent
    }

    [Fact]
    public void Format_EmptySource_ReturnsNewline()
    {
        var result = FormattingEngine.Format(string.Empty);

        // Empty source should just produce empty or newline
        Assert.True(result.Length <= 1 || result == "\n" || result == "\r\n" || result == string.Empty);
    }

    [Fact]
    public void Format_SpacesAroundOperators()
    {
        const string input = "var x=1+2\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("= 1 + 2", result);
    }

    [Fact]
    public void Format_NoSpaceAfterDot()
    {
        const string input = "import System\nConsole.WriteLine(\"hi\")\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("Console.WriteLine", result);
        Assert.DoesNotContain("Console .WriteLine", result);
        Assert.DoesNotContain("Console. WriteLine", result);
    }
}
