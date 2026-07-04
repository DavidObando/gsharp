// <copyright file="Issue1910PartialTypeMergeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Regression tests for issue #1910: a C# <c>partial</c> class/struct/
/// interface declared across MULTIPLE files/declarations previously
/// translated each part independently, emitting one complete, duplicate G#
/// type declaration per part (<c>GS0102 'Ledger' is already declared</c>,
/// then <c>GS0159</c> for members landing on the wrong declaration). Partial
/// merging must happen at translation time: every part shares one
/// <see cref="Microsoft.CodeAnalysis.INamedTypeSymbol"/> (with multiple
/// <c>DeclaringSyntaxReferences</c>), so the translator now groups all parts
/// by symbol and merges their members into ONE G# type declaration, emitted
/// once at the first ("primary") declaration; every other part translates to
/// nothing of its own (ADR-0115 / grid app G06).
/// </summary>
public class Issue1910PartialTypeMergeTranslationTests
{
    [Fact]
    public void PartialClass_SplitAcrossTwoFiles_MergesIntoOneDeclaration()
    {
        IReadOnlyList<string> printed = TranslateFiles(
            ("Part1.cs", @"
namespace Demo
{
    public partial class Ledger
    {
        private int _balance;

        public void Deposit(int amount)
        {
            _balance = _balance + amount;
        }
    }
}"),
            ("Part2.cs", @"
namespace Demo
{
    public partial class Ledger
    {
        public void Withdraw(int amount)
        {
            _balance = _balance - amount;
        }

        public int Balance()
        {
            return _balance;
        }
    }
}"));

        string combined = string.Join("\n---\n", printed);

        // The type is declared exactly once, across both translated files.
        Assert.Equal(1, CountOccurrences(combined, "class Ledger"));

        // Every member — regardless of which file/part declared it — ends up
        // on the single merged declaration.
        Assert.Contains("_balance", combined);
        Assert.Contains("func Deposit(", combined);
        Assert.Contains("func Withdraw(", combined);
        Assert.Contains("func Balance(", combined);
    }

    [Fact]
    public void PartialClass_SplitAcrossThreeDeclarationsInOneFile_MergesIntoOneDeclaration()
    {
        string printed = TranslateFiles(
            ("Snippet.cs", @"
namespace Demo
{
    public partial class Ledger
    {
        private int _balance;

        public void Deposit(int amount)
        {
            _balance = _balance + amount;
        }
    }

    public partial class Ledger
    {
        public void Withdraw(int amount)
        {
            _balance = _balance - amount;
        }
    }

    public partial class Ledger
    {
        public int Balance()
        {
            return _balance;
        }
    }
}")).Single();

        Assert.Equal(1, CountOccurrences(printed, "class Ledger"));
        Assert.Contains("func Deposit(", printed);
        Assert.Contains("func Withdraw(", printed);
        Assert.Contains("func Balance(", printed);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, System.StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private static IReadOnlyList<string> TranslateFiles(params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(System.Environment.NewLine, project.ErrorDiagnostics));

        var printedFiles = new List<string>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

            string printed = GSharpPrinter.Print(unit);
            RoundTripResult result = GSharpRoundTrip.Validate(printed);
            Assert.True(
                result.Success,
                "Translated G# must round-trip. Errors:\n" +
                    string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
            printedFiles.Add(printed);
        }

        return printedFiles;
    }
}
