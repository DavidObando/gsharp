// <copyright file="Adr0145PreservePartialModeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0145 (§C/§D): the source-generator host back-translates
/// generator-produced C# (e.g. <c>partial class Foo { ...generated members... }</c>)
/// into G# <c>partial</c> parts that augment the user's own type. This requires
/// the OPPOSITE of the default cs2gs-migration behavior (issue #1910), which
/// merges every C# <c>partial</c> part into ONE non-partial G# type emitted
/// once. In the opt-in "preserve partial parts" mode
/// (<c>new CSharpToGSharpTranslator(preservePartialParts: true)</c>), each
/// <c>partial</c> declaration translates standalone — no cross-part merge — and
/// carries the <c>partial</c> modifier onto the emitted G# type (ADR-0144). The
/// default mode must remain byte-for-byte identical to today.
/// </summary>
public class Adr0145PreservePartialModeTests
{
    [Fact]
    public void PreserveMode_GeneratedPart_EmitsStandalonePartialWithoutMerging()
    {
        // The "generated" part (Doubled) lives in one document; the user's own
        // part (_value) lives in a SECOND document. In preserve mode the
        // generated document must translate to a `partial class Foo` containing
        // ONLY its own member — no `_value` pulled in from the sibling part.
        (string generated, string user) = TranslateBothInPreserveMode(
            ("Foo.Generated.cs", @"
namespace Demo
{
    public partial class Foo
    {
        public int Doubled => _value * 2;
    }
}"),
            ("Foo.cs", @"
namespace Demo
{
    public partial class Foo
    {
        private int _value;
    }
}"));

        // The generated part is emitted as a standalone `partial` part: the
        // `partial` modifier sits immediately before the `class` keyword
        // (ADR-0144 §G).
        Assert.Contains("partial class Foo", generated);
        Assert.Contains("Doubled", generated);

        // No cross-part merge: the sibling part's `_value` FIELD declaration
        // (which prints with its `int32` type annotation, e.g.
        // `var _value int32`) must NOT leak in. The bare `_value` reference
        // inside the `Doubled` getter body (`_value * 2`) is a legitimate
        // cross-part symbol reference and is expected — it is only the merged
        // FIELD that must be absent.
        Assert.DoesNotContain("_value int32", generated);
    }

    [Fact]
    public void PreserveMode_UserPart_EmitsItsOwnStandalonePartial()
    {
        (string generated, string user) = TranslateBothInPreserveMode(
            ("Foo.Generated.cs", @"
namespace Demo
{
    public partial class Foo
    {
        public int Doubled => _value * 2;
    }
}"),
            ("Foo.cs", @"
namespace Demo
{
    public partial class Foo
    {
        private int _value;
    }
}"));

        // Translated independently, the user's part is its own `partial class
        // Foo` carrying only `_value` (the generated `Doubled` is not merged in).
        Assert.Contains("partial class Foo", user);
        Assert.Contains("_value int32", user);
        Assert.DoesNotContain("Doubled", user);
    }

    [Fact]
    public void DefaultMode_SameTwoDocuments_StillMergeIntoOneNonPartialType()
    {
        // Control: the SAME two documents in DEFAULT mode must still merge into
        // ONE non-partial `class Foo` containing BOTH members (issue #1910
        // behavior, unchanged).
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: false,
            ("Foo.Generated.cs", @"
namespace Demo
{
    public partial class Foo
    {
        public int Doubled => _value * 2;
    }
}"),
            ("Foo.cs", @"
namespace Demo
{
    public partial class Foo
    {
        private int _value;
    }
}"));

        string combined = string.Join("\n---\n", printed);

        // Exactly one declaration across both files, and it is NOT partial.
        Assert.Equal(1, CountOccurrences(combined, "class Foo"));
        Assert.DoesNotContain("partial", combined);

        // Both members land on the single merged declaration.
        Assert.Contains("Doubled", combined);
        Assert.Contains("_value", combined);
    }

    [Fact]
    public void PreserveMode_NonPartialType_EmitsNonPartial()
    {
        // `isPartial` is set ONLY when the C# declaration is `partial`; a plain
        // (non-partial) type stays non-partial even in preserve mode.
        string printed = TranslateFiles(
            preservePartialParts: true,
            ("Bar.cs", @"
namespace Demo
{
    public class Bar
    {
        private int _value;
    }
}")).Single();

        Assert.Contains("class Bar", printed);
        Assert.DoesNotContain("partial", printed);
    }

    [Fact]
    public void ForcedPartialFile_NonPartialSource_EmitsPartial()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("MainWindow.axaml.cs", "namespace Demo { public class MainWindow { } }") });
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        var translator = new CSharpToGSharpTranslator(
            forcedPartialFilePaths: new[] { document.FilePath });

        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));

        Assert.Contains("partial class MainWindow", printed);
    }

    private static (string Generated, string User) TranslateBothInPreserveMode(
        (string FileName, string Source) generated,
        (string FileName, string Source) user)
    {
        IReadOnlyList<(string FileName, string Printed)> printed =
            TranslateFilesNamed(preservePartialParts: true, generated, user);
        string g = printed.Single(p => p.FileName == generated.FileName).Printed;
        string u = printed.Single(p => p.FileName == user.FileName).Printed;
        return (g, u);
    }

    private static IReadOnlyList<string> TranslateFiles(
        bool preservePartialParts,
        params (string FileName, string Source)[] files)
    {
        return TranslateFilesNamed(preservePartialParts, files).Select(p => p.Printed).ToList();
    }

    private static IReadOnlyList<(string FileName, string Printed)> TranslateFilesNamed(
        bool preservePartialParts,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var printedFiles = new List<(string FileName, string Printed)>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator(preservePartialParts).TranslateDocument(document, context);

            string printed = GSharpPrinter.Print(unit);
            RoundTripResult result = GSharpRoundTrip.Validate(printed);
            Assert.True(
                result.Success,
                "Translated G# must round-trip. Errors:\n" +
                    string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
            printedFiles.Add((System.IO.Path.GetFileName(document.FilePath), printed));
        }

        return printedFiles;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }
}
