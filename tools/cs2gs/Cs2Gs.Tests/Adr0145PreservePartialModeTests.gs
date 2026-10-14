// <copyright file="Adr0145PreservePartialModeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0145 (§C/§D): the source-generator host back-translates
/// generator-produced C# (e.g. `partial class Foo { ...generated members... }`)
/// into G# `partial` parts that augment the user's own type. In preserve
/// mode, now also the cs2gs default (issue #3410), each `partial`
/// declaration translates standalone — no cross-part merge — and carries the
/// `partial` modifier onto the emitted G# type (ADR-0144). The legacy
/// issue #1910 merge mode remains available through
/// `preservePartialParts: false`.
open class Adr0145PreservePartialModeTests {
    @Fact
    func PreserveMode_GeneratedPart_EmitsStandalonePartialWithoutMerging() {
        // The "generated" part (Doubled) lives in one document; the user's own
        // part (_value) lives in a SECOND document. In preserve mode the
        // generated document must translate to a `partial class Foo` containing
        // ONLY its own member — no `_value` pulled in from the sibling part.
        let (generated, user) = TranslateBothInPreserveMode(("Foo.Generated.cs", `
namespace Demo
{
    public partial class Foo
    {
        public int Doubled => _value * 2;
    }
}`), ("Foo.cs", `
namespace Demo
{
    public partial class Foo
    {
        private int _value;
    }
}`))
        // The generated part is emitted as a standalone `partial` part: the
        // `partial` modifier sits immediately before the `class` keyword
        // (ADR-0144 §G).
        Assert.Contains("partial class Foo", generated)
        Assert.Contains("Doubled", generated)
        // No cross-part merge: the sibling part's `_value` FIELD declaration
        // (which prints with its `int32` type annotation, e.g.
        // `var _value int32`) must NOT leak in. The bare `_value` reference
        // inside the `Doubled` getter body (`_value * 2`) is a legitimate
        // cross-part symbol reference and is expected — it is only the merged
        // FIELD that must be absent.
        Assert.DoesNotContain("_value int32", generated)
    }

    @Fact
    func PreserveMode_UserPart_EmitsItsOwnStandalonePartial() {
        let (generated, user) = TranslateBothInPreserveMode(("Foo.Generated.cs", `
namespace Demo
{
    public partial class Foo
    {
        public int Doubled => _value * 2;
    }
}`), ("Foo.cs", `
namespace Demo
{
    public partial class Foo
    {
        private int _value;
    }
}`))
        // Translated independently, the user's part is its own `partial class
        // Foo` carrying only `_value` (the generated `Doubled` is not merged in).
        Assert.Contains("partial class Foo", user)
        Assert.Contains("_value int32", user)
        Assert.DoesNotContain("Doubled", user)
    }

    @Fact
    func LegacyMergeMode_SameTwoDocuments_MergesIntoOneNonPartialType() {
        // Control: the SAME two documents in legacy merge mode still merge into
        // ONE non-partial `class Foo` containing BOTH members (issue #1910
        // behavior, unchanged).
        let printed = TranslateFiles(preservePartialParts: false, ("Foo.Generated.cs", `
namespace Demo
{
    public partial class Foo
    {
        public int Doubled => _value * 2;
    }
}`), ("Foo.cs", `
namespace Demo
{
    public partial class Foo
    {
        private int _value;
    }
}`))
        let combined = string.Join(`
---
`, printed)
        // Exactly one declaration across both files, and it is NOT partial.
        Assert.Equal(1, CountOccurrences(combined, "class Foo"))
        Assert.DoesNotContain("partial", combined)
        // Both members land on the single merged declaration.
        Assert.Contains("Doubled", combined)
        Assert.Contains("_value", combined)
    }

    @Fact
    func PreserveMode_NonPartialType_EmitsNonPartial() {
        // `isPartial` is set ONLY when the C# declaration is `partial`; a plain
        // (non-partial) type stays non-partial even in preserve mode.
        let printed = TranslateFiles(preservePartialParts: true, ("Bar.cs", `
namespace Demo
{
    public class Bar
    {
        private int _value;
    }
}`)).Single()
        Assert.Contains("class Bar", printed)
        Assert.DoesNotContain("partial", printed)
    }

    @Fact
    func PreserveMode_ObliviousSourceField_RemainsNonNullable() {
        let printed = TranslateFiles(preservePartialParts: true, ("Bar.cs", `#nullable disable

namespace Demo;

public partial class Bar
{
    private readonly string name = "x";

    public string Read() => name;
}`)).Single()
        Assert.Contains("let name string = \"x\"", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("name string?", printed, StringComparison.Ordinal)
    }

    shared {
        private func TranslateBothInPreserveMode(
            generated(FileName string, Source string),
            user(FileName string, Source string)
        )(Generated string, User string) {
            let printed = TranslateFilesNamed(preservePartialParts: true, generated, user)
            let g = printed.Single((p(FileName string, Printed string)) -> p.FileName == generated.FileName).Printed
            let u = printed.Single((p(FileName string, Printed string)) -> p.FileName == user.FileName).Printed
            return (g, u)
        }

        private func TranslateFiles(preservePartialParts bool, files ...(FileName string, Source string)) IReadOnlyList[
            string
        ] {
            return TranslateFilesNamed(preservePartialParts, files).Select(
                (p(FileName string, Printed string)) -> p.Printed
            )
                .ToList()
        }

        private func TranslateFilesNamed(
            preservePartialParts bool,
            files ...(FileName string, Source string)
        ) IReadOnlyList[(FileName string, Printed string)] {
            let project = CSharpProjectLoader.LoadInMemory(files)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let printedFiles = List[(FileName string, Printed string)]()
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = CSharpToGSharpTranslator(preservePartialParts).TranslateDocument(document, context)
                let printed = GSharpPrinter.Print(unit)
                printedFiles.Add((Path.GetFileName(document.FilePath), printed))
            }
            TranslationTestValidation.AssertBinds(
                printedFiles.Select((file(FileName string, Printed string)) -> file.Printed).ToArray()
            )
            return printedFiles
        }

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }
    }
}
