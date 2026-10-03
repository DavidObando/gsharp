// <copyright file="Issue4653FileHeaderTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Formatting;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4653: a C# file's header comment (license, copyright) stays at the
/// top of the translated G# file with its text unchanged. Preprocessor lines
/// after it are still dropped, and gsfmt keeps the result stable.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): without <c>leadingComments:
/// FileHeader.GetLines(root)</c> in <c>TranslateDocument</c>, every test that
/// expects a header fails because the output starts at <c>package</c>. Without
/// the header skip in <c>AttachSourceComments</c>,
/// <see cref="GlobalNamespaceFile_HeaderIsPrintedOnce"/> fails with the header
/// printed twice.
/// </remarks>
public class Issue4653FileHeaderTranslationTests
{
    [Fact]
    public void CopyrightHeader_IsKeptAbovePackage()
    {
        string printed = Translate(
            "// <copyright file=\"Probe.cs\" company=\"GSharp\">\n"
            + "// Copyright (C) GSharp Authors. All rights reserved.\n"
            + "// </copyright>\n"
            + "\n"
            + "using System;\n"
            + "\n"
            + "namespace Demo;\n"
            + "\n"
            + "public static class Probe\n"
            + "{\n"
            + "    public static int Value() => Math.Abs(-3);\n"
            + "}\n");

        Assert.StartsWith(
            "// <copyright file=\"Probe.cs\" company=\"GSharp\">\n"
            + "// Copyright (C) GSharp Authors. All rights reserved.\n"
            + "// </copyright>\n"
            + "\n"
            + "package Demo\n",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void HeaderSpacingAndBlockComments_AreKept_WithTrailingWhitespaceTrimmed()
    {
        string printed = Translate(
            "//------------------------------------------------------------\n"
            + "//\n"
            + "//   Licensed under the MIT License.   \n"
            + "/* Second paragraph,\n"
            + " * spread over lines.\n"
            + " */\n"
            + "using System;\n"
            + "namespace Demo { public static class Probe { public static int Value() => 1; } }\n");

        Assert.StartsWith(
            "//------------------------------------------------------------\n"
            + "//\n"
            + "//   Licensed under the MIT License.\n"
            + "/* Second paragraph,\n"
            + " * spread over lines.\n"
            + " */\n"
            + "\n"
            + "package Demo\n",
            printed,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CarriageReturnOnlyHeader_IsSplitIntoLines()
    {
        string printed = PrintUnformatted(
            "// line one\r// line two\r\rusing System;\rnamespace Demo;\r"
            + "public static class Probe { public static int Value() => 1; }\r");

        Assert.StartsWith("// line one\n// line two\n\npackage Demo\n", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\r", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MixedLineEndingHeader_IsNormalizedToNewlines()
    {
        string printed = PrintUnformatted(
            "// a\r\n// b\r// c\n/* d\r\n * e\r */\r\n\r\nusing System;\r\nnamespace Demo;\r\n"
            + "public static class Probe { public static int Value() => 1; }\r\n");

        Assert.StartsWith("// a\n// b\n// c\n/* d\n * e\n */\n\npackage Demo\n", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\r", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void UnicodeLineSeparatorsInTheHeader_AreLineBreaks()
    {
        // C# also ends a line at U+0085, U+2028 and U+2029.
        string printed = PrintUnformatted(
            "// a\u2028// b\u0085/* c\u2029 d */\u2029\u2029using System;\nnamespace Demo;\n"
            + "public static class Probe { public static int Value() => 1; }\n");

        Assert.StartsWith("// a\n// b\n/* c\n d */\n\npackage Demo\n", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\u2028", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\u2029", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\u0085", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void IndentedHeader_KeepsTheIndentationOfEveryLine()
    {
        string printed = PrintUnformatted(
            "    // first\n    // second\n\nusing System;\nnamespace Demo;\n"
            + "public static class Probe { public static int Value() => 1; }\n");

        Assert.StartsWith("    // first\n    // second\n\npackage Demo\n", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void PreprocessorLinesAfterTheHeader_AreDropped()
    {
        string printed = Translate(
            "// Header line.\n"
            + "#nullable enable\n"
            + "#pragma warning disable CS0168\n"
            + "#region Usings\n"
            + "using System;\n"
            + "#endregion\n"
            + "namespace Demo;\n"
            + "public static class Probe { public static int Value() => 1; }\n");

        Assert.StartsWith("// Header line.\n\npackage Demo\n", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("#", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("region", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GlobalNamespaceFile_HeaderIsPrintedOnce()
    {
        string printed = Translate(
            "// Header line.\n"
            + "\n"
            + "// About the class.\n"
            + "public static class Probe\n"
            + "{\n"
            + "    public static int Value() => 1;\n"
            + "}\n");

        Assert.StartsWith("// Header line.\n", printed, StringComparison.Ordinal);
        Assert.Equal(1, Occurrences(printed, "// Header line."));
        Assert.Equal(1, Occurrences(printed, "// About the class."));
        Assert.True(
            printed.IndexOf("// About the class.", StringComparison.Ordinal)
                > printed.IndexOf("// Header line.", StringComparison.Ordinal),
            printed);
    }

    [Fact]
    public void CommentDirectlyAboveTheFirstDeclaration_StaysOnTheDeclaration()
    {
        string printed = Translate(
            "// About the class.\n"
            + "public static class Probe\n"
            + "{\n"
            + "    public static int Value() => 1;\n"
            + "}\n");

        // Not a file header: it belongs to the class, as before #4653.
        Assert.Equal(1, Occurrences(printed, "// About the class."));
        Assert.Matches("// About the class\\.\n(@\\w+\\n)*[a-z ]*class Probe", printed);
    }

    [Fact]
    public void CommentDirectlyAboveAFileLevelAttribute_IsTheHeader()
    {
        string printed = Translate(
            "// Header line.\n"
            + "[assembly: System.CLSCompliant(false)]\n"
            + "namespace Demo;\n"
            + "public static class Probe { public static int Value() => 1; }\n");

        // A file-level attribute list carries no comments of its own, so the
        // run above it is the header rather than being dropped.
        Assert.StartsWith("// Header line.\n\npackage Demo\n", printed, StringComparison.Ordinal);
        Assert.Equal(1, Occurrences(printed, "// Header line."));
    }

    [Fact]
    public void BlankLineHoldingOnlySpaces_EndsTheHeader()
    {
        string printed = Translate(
            "// Header line.\n"
            + "   \n"
            + "// About the class.\n"
            + "public static class Probe\n"
            + "{\n"
            + "    public static int Value() => 1;\n"
            + "}\n");

        Assert.StartsWith("// Header line.\n\n", printed, StringComparison.Ordinal);
        Assert.Equal(1, Occurrences(printed, "// About the class."));
        Assert.DoesNotContain("// Header line.\n// About the class.", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void BlankLinesBeforeTheFirstComment_DoNotDropTheHeader()
    {
        string printed = Translate(
            "\n\n// Licensed to the authors.\n\nusing System;\nnamespace Demo;\npublic static class Probe { public static int Value() => 1; }\n");

        // Nothing else carries a comment in the first token's leading trivia,
        // so treating it as no header would drop it.
        Assert.StartsWith("// Licensed to the authors.\n\npackage Demo\n", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void FileStartingWithADocComment_HasNoHeader()
    {
        string printed = Translate(
            "/// <summary>The probe.</summary>\n"
            + "public static class Probe\n"
            + "{\n"
            + "    public static int Value() => 1;\n"
            + "}\n");

        Assert.StartsWith("///", printed, StringComparison.Ordinal);
        Assert.Equal(1, Occurrences(printed, "The probe."));
    }

    [Fact]
    public void FileWithoutLeadingComments_IsUnchanged()
    {
        string printed = Translate(
            "using System;\nnamespace Demo;\npublic static class Probe { public static int Value() => 1; }\n");

        Assert.StartsWith("package Demo\n", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DocumentSplitIntoPackages_EveryUnitKeepsTheHeader()
    {
        const string source =
            "// Licensed to the authors.\n"
            + "\n"
            + "namespace First { public static class A { public static int X() => 1; } }\n"
            + "namespace Second { public static class B { public static int Y() => 2; } }\n";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Split.cs", source) });
        LoadedDocument document = Assert.Single(project.Documents);
        IReadOnlyList<string> packages = CSharpToGSharpTranslator.GetDeclaredPackages(document);
        Assert.Equal(2, packages.Count);

        for (int unitIndex = 0; unitIndex < packages.Count; unitIndex++)
        {
            var translator = new CSharpToGSharpTranslator(
                packageFilter: packages[unitIndex],
                includeFileAttributes: unitIndex == 0,
                includeGlobalNamespace: unitIndex == 0);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));
            Assert.StartsWith(
                "// Licensed to the authors.\n\npackage " + packages[unitIndex] + "\n",
                printed,
                StringComparison.Ordinal);
        }
    }

    // The printer's own output, before gsfmt (which would also normalize line
    // endings and hide a header split wrongly): what `--no-format` emits.
    private static string PrintUnformatted(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(roundTrip.Success, string.Join("\n", roundTrip.Errors) + "\n\n" + printed);

        // The pipeline formats every file with gsfmt; the header must survive
        // it unchanged, and formatting must be idempotent.
        FormatResult once = GSharpFormatter.Format(SourceText.From(printed, "Probe.gs"));
        Assert.True(once.Diagnostics.IsEmpty, string.Join("; ", once.Diagnostics.Select(d => d.Message)));
        string formatted = once.Text.ToString();
        FormatResult twice = GSharpFormatter.Format(SourceText.From(formatted, "Probe.gs"));
        Assert.Equal(formatted, twice.Text.ToString());
        return formatted;
    }

    private static int Occurrences(string text, string value)
    {
        int count = 0;
        for (int at = text.IndexOf(value, StringComparison.Ordinal);
            at >= 0;
            at = text.IndexOf(value, at + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
