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

    [Fact]
    public void Format_MultiStatementBody_KeepsOneStatementPerLine()
    {
        // Exact repro from issue #1660.
        const string input = "func foo() {\nvar x = 1\nvar y = 2\n}\n";
        var expected = "func foo () {\n  var x = 1\n  var y = 2\n}\n";

        var result = FormattingEngine.Format(input);

        Assert.Equal(expected, result);
    }

    [Fact]
    public void Format_ClosingBrace_AlwaysOnOwnLine()
    {
        const string input = "func foo() {\nvar x = 1\n}\n";
        var result = FormattingEngine.Format(input);

        Assert.DoesNotContain("1}", result);
        Assert.Contains("\n}\n", result);
    }

    [Theory]
    [InlineData("if true {\nvar a = 1\nvar b = 2\n}\n")]
    [InlineData("scope {\nvar a = 1\nvar b = 2\n}\n")]
    [InlineData("try {\nvar a = 1\nvar b = 2\n}\n")]
    public void Format_NestedBlockKinds_PreserveStatementLines(string body)
    {
        var input = "func foo() {\n" + body + "}\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("    var a = 1", result);
        Assert.Contains("    var b = 2", result);
        Assert.DoesNotContain("var a = 1 var b = 2", result);
    }

    [Fact]
    public void Format_DeeplyNestedBlocks_IndentEachDepth()
    {
        const string input = "func foo() {\nif true {\nif true {\nvar x = 1\n}\n}\n}\n";
        var result = FormattingEngine.Format(input);

        Assert.Contains("      var x = 1", result); // three levels deep, 2-space indent
    }

    [Fact]
    public void Format_HonorsFourSpaceIndentOption()
    {
        const string input = "func foo() {\nvar x = 1\n}\n";
        var result = FormattingEngine.Format(input, "    ");

        Assert.Contains("    var x = 1", result);
    }

    [Fact]
    public void Format_HonorsTabIndentOption()
    {
        const string input = "func foo() {\nvar x = 1\n}\n";
        var result = FormattingEngine.Format(input, "\t");

        Assert.Contains("\tvar x = 1", result);
    }

    [Fact]
    public void Format_IsIdempotent()
    {
        const string input = "func foo() {\nvar x = 1\nvar y = 2\nif true {\nvar z = 3\n}\n}\n";
        var once = FormattingEngine.Format(input);
        var twice = FormattingEngine.Format(once);

        Assert.Equal(once, twice);
    }
}
