// <copyright file="Issue4653FileHeaderTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4653: a C# file's header comment (license, copyright) stays at the
/// top of the translated G# file with its text unchanged. Preprocessor lines
/// after it are still dropped, and gsfmt keeps the result stable.
/// @remarks Discrimination witness (ADR-0154): without `leadingComments:
/// FileHeader.GetLines(root)` in `TranslateDocument`, every test that
/// expects a header fails because the output starts at `package`. Without
/// the header skip in `AttachSourceComments`,
/// (cref:GlobalNamespaceFile_HeaderIsPrintedOnce) fails with the header
/// printed twice.
open class Issue4653FileHeaderTranslationTests {
    @Fact
    func CopyrightHeader_IsKeptAbovePackage() {
        let printed = Translate(
            "// <copyright file=\"Probe.cs\" company=\"GSharp\">\n" +
                "// Copyright (C) GSharp Authors. All rights reserved.\n" +
                "// </copyright>\n" +
                "\n" +
                "using System;\n" +
                "\n" +
                "namespace Demo;\n" +
                "\n" +
                "public static class Probe\n" +
                "{\n" +
                "    public static int Value() => Math.Abs(-3);\n" +
                "}\n"
        )
        Assert.StartsWith(
            "// <copyright file=\"Probe.cs\" company=\"GSharp\">\n" +
                "// Copyright (C) GSharp Authors. All rights reserved.\n" +
                "// </copyright>\n" +
                "\n" +
                "package Demo\n",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func HeaderSpacingAndBlockComments_AreKept_WithTrailingWhitespaceTrimmed() {
        let printed = Translate(
            "//------------------------------------------------------------\n" +
                "//\n" +
                "//   Licensed under the MIT License.   \n" +
                "/* Second paragraph,\n" +
                " * spread over lines.\n" +
                " */\n" +
                "using System;\n" +
                "namespace Demo { public static class Probe { public static int Value() => 1; } }\n"
        )
        Assert.StartsWith(
            "//------------------------------------------------------------\n" +
                "//\n" +
                "//   Licensed under the MIT License.\n" +
                "/* Second paragraph,\n" +
                " * spread over lines.\n" +
                " */\n" +
                "\n" +
                "package Demo\n",
            printed,
            StringComparison.Ordinal
        )
    }

    @Fact
    func CarriageReturnOnlyHeader_IsSplitIntoLines() {
        let printed = PrintUnformatted(
            "// line one\r// line two\r\rusing System;\rnamespace Demo;\r" +
                "public static class Probe { public static int Value() => 1; }\r"
        )
        Assert.StartsWith(`// line one
// line two

package Demo
`, printed, StringComparison.Ordinal)
        Assert.DoesNotContain("\r", printed, StringComparison.Ordinal)
    }

    @Fact
    func MixedLineEndingHeader_IsNormalizedToNewlines() {
        let printed = PrintUnformatted(
            "// a\r\n// b\r// c\n/* d\r\n * e\r */\r\n\r\nusing System;\r\nnamespace Demo;\r\n" +
                "public static class Probe { public static int Value() => 1; }\r\n"
        )
        Assert.StartsWith(`// a
// b
// c
/* d
 * e
 */

package Demo
`, printed, StringComparison.Ordinal)
        Assert.DoesNotContain("\r", printed, StringComparison.Ordinal)
    }

    @Fact
    func UnicodeLineSeparatorsInTheHeader_AreLineBreaks() {
        // C# also ends a line at U+0085, U+2028 and U+2029.
        let printed = PrintUnformatted(`// a // b/* c  d */  using System;
namespace Demo;
` + "public static class Probe { public static int Value() => 1; }\n")
        Assert.StartsWith(`// a
// b
/* c
 d */

package Demo
`, printed, StringComparison.Ordinal)
        Assert.DoesNotContain(" ", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(" ", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("", printed, StringComparison.Ordinal)
    }

    @Fact
    func IndentedHeader_KeepsTheIndentationOfEveryLine() {
        let printed = PrintUnformatted(`    // first
    // second

using System;
namespace Demo;
` + "public static class Probe { public static int Value() => 1; }\n")
        Assert.StartsWith(`    // first
    // second

package Demo
`, printed, StringComparison.Ordinal)
    }

    @Fact
    func PreprocessorLinesAfterTheHeader_AreDropped() {
        let printed = Translate(
            "// Header line.\n" +
                "#nullable enable\n" +
                "#pragma warning disable CS0168\n" +
                "#region Usings\n" +
                "using System;\n" +
                "#endregion\n" +
                "namespace Demo;\n" +
                "public static class Probe { public static int Value() => 1; }\n"
        )
        Assert.StartsWith(`// Header line.

package Demo
`, printed, StringComparison.Ordinal)
        Assert.DoesNotContain("#", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("region", printed, StringComparison.Ordinal)
    }

    @Fact
    func GlobalNamespaceFile_HeaderIsPrintedOnce() {
        let printed = Translate(
            "// Header line.\n" +
                "\n" +
                "// About the class.\n" +
                "public static class Probe\n" +
                "{\n" +
                "    public static int Value() => 1;\n" +
                "}\n"
        )
        Assert.StartsWith("// Header line.\n", printed, StringComparison.Ordinal)
        Assert.Equal(1, Occurrences(printed, "// Header line."))
        Assert.Equal(1, Occurrences(printed, "// About the class."))
        Assert.True(
            printed.IndexOf("// About the class.", StringComparison.Ordinal) > printed.IndexOf(
                "// Header line.",
                StringComparison.Ordinal
            ),
            printed
        )
    }

    @Fact
    func CommentDirectlyAboveTheFirstDeclaration_StaysOnTheDeclaration() {
        let printed = Translate(
            "// About the class.\n" +
                "public static class Probe\n" +
                "{\n" +
                "    public static int Value() => 1;\n" +
                "}\n"
        )
        // Not a file header: it belongs to the class, as before #4653.
        Assert.Equal(1, Occurrences(printed, "// About the class."))
        Assert.Matches("// About the class\\.\n(@\\w+\\n)*[a-z ]*class Probe", printed)
    }

    @Fact
    func CommentDirectlyAboveAFileLevelAttribute_IsTheHeader() {
        let printed = Translate(
            "// Header line.\n" +
                "[assembly: System.CLSCompliant(false)]\n" +
                "namespace Demo;\n" +
                "public static class Probe { public static int Value() => 1; }\n"
        )
        // A file-level attribute list carries no comments of its own, so the
        // run above it is the header rather than being dropped.
        Assert.StartsWith(`// Header line.

package Demo
`, printed, StringComparison.Ordinal)
        Assert.Equal(1, Occurrences(printed, "// Header line."))
    }

    @Fact
    func BlankLineHoldingOnlySpaces_EndsTheHeader() {
        let printed = Translate(
            "// Header line.\n" +
                "   \n" +
                "// About the class.\n" +
                "public static class Probe\n" +
                "{\n" +
                "    public static int Value() => 1;\n" +
                "}\n"
        )
        Assert.StartsWith(`// Header line.

`, printed, StringComparison.Ordinal)
        Assert.Equal(1, Occurrences(printed, "// About the class."))
        Assert.DoesNotContain("// Header line.\n// About the class.", printed, StringComparison.Ordinal)
    }

    @Fact
    func BlankLinesBeforeTheFirstComment_DoNotDropTheHeader() {
        let printed = Translate(`

// Licensed to the authors.

using System;
namespace Demo;
public static class Probe { public static int Value() => 1; }
`)
        // Nothing else carries a comment in the first token's leading trivia,
        // so treating it as no header would drop it.
        Assert.StartsWith(`// Licensed to the authors.

package Demo
`, printed, StringComparison.Ordinal)
    }

    @Fact
    func FileStartingWithADocComment_HasNoHeader() {
        let printed = Translate(
            "/// <summary>The probe.</summary>\n" +
                "public static class Probe\n" +
                "{\n" +
                "    public static int Value() => 1;\n" +
                "}\n"
        )
        Assert.StartsWith("///", printed, StringComparison.Ordinal)
        Assert.Equal(1, Occurrences(printed, "The probe."))
    }

    @Fact
    func FileWithoutLeadingComments_IsUnchanged() {
        let printed = Translate(`using System;
namespace Demo;
public static class Probe { public static int Value() => 1; }
`)
        Assert.StartsWith("package Demo\n", printed, StringComparison.Ordinal)
    }

    @Fact
    func DocumentSplitIntoPackages_EveryUnitKeepsTheHeader() {
        const source = "// Licensed to the authors.\n" +
            "\n" +
            "namespace First { public static class A { public static int X() => 1; } }\n" +
            "namespace Second { public static class B { public static int Y() => 2; } }\n"
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Split.cs", source)})
        let document = Assert.Single(project.Documents)
        let packages = CSharpToGSharpTranslator.GetDeclaredPackages(document)
        Assert.Equal(2, packages.Count)
        for var unitIndex = 0; unitIndex < packages.Count; unitIndex++ {
            let translator = CSharpToGSharpTranslator(
                packageFilter: packages[unitIndex],
                includeFileAttributes: unitIndex == 0,
                includeGlobalNamespace: unitIndex == 0
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            Assert.StartsWith(`// Licensed to the authors.

package ` + packages[unitIndex] + "\n", printed, StringComparison.Ordinal)
        }
    }

    shared {
        // The printer's own output, before gsfmt (which would also normalize line
        // endings and hide a header split wrongly): what `--no-format` emits.
        private func PrintUnformatted(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            let roundTrip = GSharpRoundTrip.Validate(printed)
            Assert.True(roundTrip.Success, string.Join("\n", roundTrip.Errors) + `

` + printed)
            // The pipeline formats every file with gsfmt; the header must survive
            // it unchanged, and formatting must be idempotent.
            let once = GSharpFormatter.Format(SourceText.From(printed, "Probe.gs"))
            Assert.True(
                once.Diagnostics.IsEmpty,
                string.Join("; ", once.Diagnostics.Select((d Diagnostic) -> d.Message))
            )
            let formatted = once.Text!!.ToString()
            let twice = GSharpFormatter.Format(SourceText.From(formatted, "Probe.gs"))
            Assert.Equal(formatted, twice.Text!!.ToString())
            return formatted
        }

        private func Occurrences(text string, value string) int32 {
            var count = 0
            for var at = text.IndexOf(value, StringComparison.Ordinal); at >= 0; at = text.IndexOf(
                value,
                at + value.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }
    }
}
