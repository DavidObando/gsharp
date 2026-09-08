// <copyright file="GSharpFormatterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

public sealed class GSharpFormatterTests
{
    [Fact]
    public void Format_UsesCanonicalLayout()
    {
        const string input = "package Z\nimport Zed\nimport Alpha\nfunc add(a int32,b int32)int32{\nreturn a+b\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            "package Z\n\nimport Alpha\nimport Zed\n\nfunc add(a int32, b int32) int32 {\n"
                + "    return a + b\n"
                + "}\n",
            result.Text!.ToString());
    }

    [Fact]
    public void Format_IsIdempotent()
    {
        const string input = "func run(){\nvar x=1\nif x>0{\nConsole.WriteLine(x)\n}\n}\n";

        FormatResult once = GSharpFormatter.Format(SourceText.From(input));
        FormatResult twice = GSharpFormatter.Format(once.Text!);

        Assert.Empty(once.Diagnostics);
        Assert.Empty(twice.Diagnostics);
        Assert.Equal(once.Text!.ToString(), twice.Text!.ToString());
        Assert.False(twice.Changed);
    }

    [Fact]
    public void Format_WrapsComposableExpressionShapes()
    {
        string arguments = string.Join(", ", Enumerable.Range(0, 30).Select(index => $"value{index}"));
        string input = $"func run() {{\nConsole.WriteLine({arguments})\n}}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.All(
            result.Text!.ToString().Split('\n'),
            line => Assert.True(line.Length <= 120, "Line exceeded the canonical width: " + line));
        Assert.Contains("\n        value0,\n        value1,", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_KeepsArrayElementTypeAdjacent()
    {
        const string input = "let values=[3]int32{1,2,3}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Equal("let values = [3]int32{1, 2, 3}\n", result.Text!.ToString());
    }

    [Fact]
    public void Format_KeepsMagicTypesAndConditionalIndexAdjacent()
    {
        const string input =
            "func use(ch chan[int32], values map[string,int32], items sequence[int32], xs []int32){\n"
            + "let first=xs?[0]\n"
            + "}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("chan[int32]", result.Text!.ToString(), StringComparison.Ordinal);
        Assert.Contains("map[string, int32]", result.Text!.ToString(), StringComparison.Ordinal);
        Assert.Contains("sequence[int32]", result.Text!.ToString(), StringComparison.Ordinal);
        Assert.Contains("xs?[0]", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_PreservesImportOrderWhenLocalNamesCollide()
    {
        const string input =
            "package Demo\n"
            + "import X = System.Math\n"
            + "import X = System.Console\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);
        Assert.True(
            formatted.IndexOf("System.Math", StringComparison.Ordinal)
                < formatted.IndexOf("System.Console", StringComparison.Ordinal));
    }

    [Fact]
    public void Format_PreservesImportOrderWhenACommentSitsInTheImportBlock()
    {
        const string input =
            "package Demo\n"
            + "import b.x\n"
            + "import a.y // only for y\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);
        Assert.Contains("import a.y // only for y", formatted, StringComparison.Ordinal);
        Assert.True(
            formatted.IndexOf("import b.x", StringComparison.Ordinal)
                < formatted.IndexOf("import a.y", StringComparison.Ordinal));
    }

    [Fact]
    public void Format_PreservesImportOrderWhenACommentIntroducesTheImportBlock()
    {
        const string input =
            "package Demo\n"
            + "\n"
            + "// only for x\n"
            + "import b.x\n"
            + "import a.y\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);
        Assert.True(
            formatted.IndexOf("import b.x", StringComparison.Ordinal)
                < formatted.IndexOf("import a.y", StringComparison.Ordinal));
    }

    [Fact]
    public void Format_KeepsBlockCommentsInline()
    {
        const string input = "func main() {\nlet a = /* why */ 1\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("let a = /* why */ 1", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_DoesNotSplitPayloadEnumDeclarationHead()
    {
        const string input = "enum Shape { Circle(r float64); Square(s float64); Empty }\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.StartsWith("enum Shape {", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_PreservesNewlineSensitiveReturn()
    {
        const string input = "func value() int32 {\nreturn\n42\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("return\n    42", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_InsertsMemberBlankLineBeforeDocumentationTrivia()
    {
        const string input = "class Widget {\nfunc A() { }\n/// Documents B.\nfunc B() { }\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("    func A() { }\n\n    /// Documents B.", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_PreservesOneBlankLineAfterCommentBlock()
    {
        const string input = "// File heading.\n\npackage Demo\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Equal("// File heading.\n\npackage Demo\n", result.Text!.ToString());
    }

    [Fact]
    public void Format_ParseFailureReturnsDiagnostics()
    {
        FormatResult result = GSharpFormatter.Format(SourceText.From("func broken( {\n"));

        Assert.Null(result.Text);
        Assert.NotEmpty(result.Diagnostics);
        Assert.False(result.Changed);
    }

    [Fact]
    public void FormatRange_OnlyReturnsEditsForIntersectingLines()
    {
        const string input = "func first(){\nreturn 1\n}\n\nfunc second(){\nreturn 2\n}\n";
        int secondStart = input.IndexOf("func second", StringComparison.Ordinal);

        FormatResult result = GSharpFormatter.Format(
            SourceText.From(input),
            new TextSpan(secondStart, input.Length - secondStart));
        string applied = ApplyEdits(input, result.Edits);

        Assert.Equal(applied, result.Text!.ToString());
        Assert.StartsWith("func first(){\nreturn 1\n}\n", applied, StringComparison.Ordinal);
        Assert.Contains("func second() {\n    return 2\n}", applied, StringComparison.Ordinal);
    }

    [Fact]
    public void FormatRange_DoesNotCoalesceAnAdjacentLineOutsideTheRange()
    {
        const string input = "func run() {\nvar x = 1\nvar y = 2\n}\n";
        int start = input.IndexOf("var x", StringComparison.Ordinal);

        FormatResult result = GSharpFormatter.Format(
            SourceText.From(input),
            new TextSpan(start, "var x = 1".Length));
        string applied = ApplyEdits(input, result.Edits);

        Assert.Contains("\n    var x = 1\n", applied, StringComparison.Ordinal);
        Assert.Contains("\nvar y = 2\n", applied, StringComparison.Ordinal);
    }

    // ADR-0179 phase 6. These formatter defects made gsfmt reject its own output
    // on the migrated tree, which is invisible in normal use: the formatter
    // falls soft and hands the caller the unformatted text, so the symptom is
    // "wrapping did not happen here" rather than a crash.
    [Fact]
    public void Format_KeepsNullConditionalInvocationTightAgainstItsArgumentList()
    {
        const string input = "func run(onBound ((int32) -> void)?) {\nonBound?(1)\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("onBound?(1)", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_KeepsNullableConversionCallTightAgainstItsArgumentList()
    {
        const string input = "func run(n int32) {\nlet widened = int32?(n)\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("int32?(n)", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_SpacesANullableTypeMarkerAwayFromAFollowingEquals()
    {
        const string input = "func run() {\nlet root string?=nil\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("let root string? = nil", result.Text!.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("string?=", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_KeepsTheNullableSliceMarkerTightAgainstItsElementType()
    {
        // `[]?int32` puts the marker INSIDE the type clause, so the rule cannot
        // simply be "always space after a nullable `?`".
        const string input = "func run(values []?int32) {\nlet first = values?[0]\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("[]?int32", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_KeepsDoubleLogicalNegationFromFusingIntoNullAssertion()
    {
        const string input = "func run() {\nlet on = true\nlet doubled = ! !on\n}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));

        Assert.Empty(result.Diagnostics);
        Assert.Contains("let doubled = ! !on", result.Text!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Format_KeepsACollectionInitializersFirstElementOnTheBraceLine()
    {
        string arguments = string.Join(", ", Enumerable.Range(0, 20).Select(index => $"argument{index}"));
        string input = $"func run(capacity int32) {{\nlet items = List[int32](capacity){{buildElement({arguments})}}\n}}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);

        // A newline immediately after the brace demotes this single nonliteral
        // initializer to a call followed by an unrelated block statement.
        Assert.Contains("){buildElement(", formatted, StringComparison.Ordinal);
    }

    [Fact]
    public void Format_BreaksAfterACollectionInitializerBraceWhenUnambiguous()
    {
        string elements = string.Join(", ", Enumerable.Range(0, 20).Select(index => $"element{index}"));
        string input = $"func run(capacity int32) {{\nlet items = List[int32](capacity){{{elements}}}\n}}\n";

        FormatResult result = GSharpFormatter.Format(SourceText.From(input));
        string formatted = result.Text!.ToString();

        Assert.Empty(result.Diagnostics);
        Assert.Contains("){\n        element0,", formatted, StringComparison.Ordinal);
        Assert.All(
            formatted.Split('\n'),
            line => Assert.True(line.Length <= 120, "Line exceeded the canonical width: " + line));
    }

    [Fact]
    public void Samples_RoundTripAndRemainIdempotent()
    {
        string root = FindRepositoryRoot();
        foreach (string path in Directory.EnumerateFiles(
            Path.Combine(root, "samples"),
            "*.gs",
            SearchOption.TopDirectoryOnly))
        {
            string input = File.ReadAllText(path);
            FormatResult once = GSharpFormatter.Format(SourceText.From(input, path));
            Assert.True(
                once.Diagnostics.IsEmpty,
                path + ": " + string.Join(Environment.NewLine, once.Diagnostics));

            FormatResult twice = GSharpFormatter.Format(once.Text!);
            Assert.True(
                twice.Diagnostics.IsEmpty,
                path + ": " + string.Join(Environment.NewLine, twice.Diagnostics));
            Assert.Equal(once.Text!.ToString(), twice.Text!.ToString());
        }
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

    private static string ApplyEdits(string source, System.Collections.Immutable.ImmutableArray<TextEdit> edits)
    {
        foreach (TextEdit edit in edits.OrderByDescending(item => item.Span.Start))
        {
            source = source.Substring(0, edit.Span.Start)
                + edit.NewText
                + source.Substring(edit.Span.End);
        }

        return source;
    }
}
