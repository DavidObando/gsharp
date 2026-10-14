// <copyright file="Issue1910PartialTypeMergeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Regression tests for issue #1910: a C# `partial` class/struct/
/// interface declared across MULTIPLE files/declarations previously
/// translated each part independently, emitting one complete, duplicate G#
/// type declaration per part (`GS0102 'Ledger' is already declared`,
/// then `GS0159` for members landing on the wrong declaration). Partial
/// The legacy merge mode performs that translation-time merge: every part
/// shares one
/// (cref:Microsoft.CodeAnalysis.INamedTypeSymbol) (with multiple
/// `DeclaringSyntaxReferences`), so the translator now groups all parts
/// by symbol and merges their members into ONE G# type declaration, emitted
/// once at the first ("primary") declaration; every other part translates to
/// nothing of its own (ADR-0115 / grid app G06).
open class Issue1910PartialTypeMergeTranslationTests {
    @Fact
    func PartialClass_SplitAcrossTwoFiles_MergesIntoOneDeclaration() {
        let printed = TranslateFiles(("Part1.cs", `
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
}`), ("Part2.cs", `
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
}`))
        let combined = string.Join(`
---
`, printed)
        // The type is declared exactly once, across both translated files.
        Assert.Equal(1, CountOccurrences(combined, "class Ledger"))
        // Every member — regardless of which file/part declared it — ends up
        // on the single merged declaration.
        Assert.Contains("_balance", combined)
        Assert.Contains("func Deposit(", combined)
        Assert.Contains("func Withdraw(", combined)
        Assert.Contains("func Balance(", combined)
    }

    @Fact
    func PartialClass_SplitAcrossThreeDeclarationsInOneFile_MergesIntoOneDeclaration() {
        let printed = TranslateFiles(("Snippet.cs", `
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
}`)).Single()
        Assert.Equal(1, CountOccurrences(printed, "class Ledger"))
        Assert.Contains("func Deposit(", printed)
        Assert.Contains("func Withdraw(", printed)
        Assert.Contains("func Balance(", printed)
    }

    @Fact
    func PartialClass_AttributesOnBothParts_AreMergedOntoSingleDeclaration() {
        let printed = TranslateFiles(("Part1.cs", `
using System;

namespace Demo
{
    [Obsolete("old")]
    public partial class Ledger
    {
        private int _balance;
    }
}`), ("Part2.cs", `
using System;

namespace Demo
{
    [Serializable]
    public partial class Ledger
    {
        public void Deposit(int amount)
        {
            _balance = _balance + amount;
        }
    }
}`)).Single((p string) -> p.Contains("class Ledger"))
        // Both parts' type-level attributes must survive onto the single
        // merged declaration (issue #1910 gap 1) — Roslyn's
        // `symbol.GetAttributes()` already merges them; the translator must
        // not read only the primary part's own `AttributeLists`.
        Assert.Contains("Obsolete", printed)
        Assert.Contains("Serializable", printed)
        Assert.Equal(1, CountOccurrences(printed, "class Ledger"))
    }

    @Fact
    func PartialClass_UnsafeOnNonPrimaryPart_IsPreserved() {
        let printed = TranslateFiles(("Part1.cs", `
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
}`), ("Part2.cs", `
namespace Demo
{
    public unsafe partial class Ledger
    {
        public void Withdraw(int amount)
        {
            _balance = _balance - amount;
        }
    }
}`)).Single((p string) -> p.Contains("class Ledger"))
        // `unsafe` on the SECOND (non-primary) part must still mark the
        // merged G# type unsafe (issue #1910 gap 2) — C# allows `unsafe` on
        // any partial declaration, not just the primary one.
        Assert.Contains("unsafe", printed)
    }

    @Fact
    func PartialClass_UsingOnlyOnNonPrimaryPartFile_ResolvesInMergedOutput() {
        let printed = TranslateFiles(("Part1.cs", `
namespace Demo
{
    public partial class Ledger
    {
        private int _balance;
    }
}`), ("Part2.cs", `
using System.Text;

namespace Demo
{
    public partial class Ledger
    {
        public string Describe()
        {
            var builder = new StringBuilder();
            builder.Append(_balance);
            return builder.ToString();
        }
    }
}`))
        let primaryFile = printed[0]
        // `System.Text` is only `using`d in Part2.cs (the non-primary part),
        // yet `Describe`'s body — merged into the primary declaration in
        // Part1.cs's output — references `StringBuilder` by its short name.
        // The primary file's import block must union in Part2.cs's `using`s
        // so the merged output resolves (issue #1910 gap 3).
        Assert.Contains("StringBuilder", primaryFile)
        Assert.Contains("import System.Text", primaryFile)
        // Round-trip already validated in TranslateFiles; also confirm the
        // type is still declared exactly once.
        Assert.Equal(1, CountOccurrences(primaryFile, "class Ledger"))
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }

        private func TranslateFiles(files ...(FileName string, Source string)) IReadOnlyList[string] {
            let project = CSharpProjectLoader.LoadInMemory(files)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let printedFiles = List[string]()
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = CSharpToGSharpTranslator(preservePartialParts: false).TranslateDocument(document, context)
                let printed = GSharpPrinter.Print(unit)
                let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
                Assert.True(
                    result!!.Success,
                    "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
                )
                printedFiles.Add(printed)
            }
            return printedFiles
        }
    }
}
