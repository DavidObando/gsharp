// <copyright file="Issue3804ThisReceiverInDataRowTheoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit

/// Issue #3804: the last translate-stage wall in the self-migration corpus was
/// not an unsupported construct at all — it was cs2gs crashing. Issue #3726's
/// data-row promotion looks a parameter up by ordinal in the attribute's value
/// array, and guarded only the UPPER bound:
/// ```
/// || parameter.Ordinal >= row.Values.Length) { continue; }
/// if (row.Values[parameter.Ordinal].IsNull)
/// ```
/// Roslyn models `this` as an `IParameterSymbol` on the enclosing
/// method whose `Ordinal` is <b>-1</b>, and the semantic model hands back
/// exactly that symbol for a `this` expression. So any `this.…`
/// receiver inside a method carrying a data-row-shaped attribute indexed at -1
/// and took the whole Translate stage down with an
/// (cref:System.IndexOutOfRangeException) — reported by the gate as
/// "translation-unsupported", with no file and no line.
///
/// The receiver is not a row column, so the fix is to answer "no promotion" for
/// a negative ordinal, without weakening the #3726 rule for the real columns —
/// which the second and third tests here pin.
open class Issue3804ThisReceiverInDataRowTheoryTests {
    @Fact
    func AThisReceiverInsideADataRowTheory_TranslatesInsteadOfCrashing() {
        // The minimal reduction of test/Interpreter.Tests' crash: a theory
        // whose body reaches through `this`. Translating at all is the
        // assertion that matters — before the fix this call threw
        // IndexOutOfRangeException out of the translator.
        let printed = Translate(`
namespace Demo
{
    public class ProgramTests
    {
        private readonly string name = "n";

        [Theory]
        [InlineData("a")]
        public void Check(string text)
        {
            System.Console.WriteLine(this.name.Length + text.Length);
        }
    }
}`, out var declarations)
        Assert.Contains("Check(text string)", printed)
        Assert.Contains("this.name", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func AThisReceiverDoesNotSuppressTheNullColumnPromotion() {
        // The guard must answer only for the receiver. The declared parameters
        // still line up with the row, so #3726's promotion has to survive it:
        // column 0 carries a null and column 1 never does.
        let printed = Translate(`
namespace Demo
{
    public class ProgramTests
    {
        private readonly string name = "n";

        [Theory]
        [InlineData(null, "a")]
        [InlineData("b", "c")]
        public void Check(string maybe, string always)
        {
            System.Console.WriteLine(this.name + maybe + always);
        }
    }
}`, out var declarations)
        Assert.Contains("Check(maybe string?, always string)", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func AThisReceiverIsNeverPromotedByAWiderRow() {
        // The receiver's -1 is not "the last column" either: a row wide enough
        // to cover every declared parameter must not make `this` itself
        // nullable through some wrap-around reading of the ordinal.
        let printed = Translate(`
namespace Demo
{
    public class ProgramTests
    {
        private readonly string name = "n";

        [Theory]
        [InlineData(null, null)]
        public void Check(string first, string second)
        {
            System.Console.WriteLine(this.name.Length + (first ?? second ?? "").Length);
        }
    }
}`, out var declarations)
        Assert.Contains("Check(first string?, second string?)", printed)
        Assert.DoesNotContain("this!!", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    shared {
        // The same stand-in for xunit's `[InlineData]` used by the #3726 tests: the
        // shape the rule keys off is a `params object[]` constructor, not the name.
        private const DataAttributeDeclarations string = `
using System;

namespace Demo
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    public sealed class InlineDataAttribute : Attribute
    {
        public InlineDataAttribute(params object[] data)
        {
            this.Data = data;
        }

        public object[] Data { get; }
    }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class TheoryAttribute : Attribute
    {
    }
}`

        // Returns the printed consumer file, and hands back the printed attribute
        // declarations too so callers can bind the pair.
        private func Translate(source string, out printedDeclarations string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Attributes.cs", DataAttributeDeclarations), ("Tests.cs", source)}
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics)
            )
            printedDeclarations = Print(project, 0)
            return Print(project, 1)
        }

        private func Print(project LoadedCSharpProject, documentIndex int32) string {
            let document = project.Documents[documentIndex]
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
