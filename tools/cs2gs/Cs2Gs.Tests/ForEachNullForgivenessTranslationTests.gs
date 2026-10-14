// <copyright file="ForEachNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Translator-fidelity tests for `foreach` over a nullable receiver. G#
/// smart-casts narrow only LOCAL variables, not field/property chains, so a
/// declared-nullable (or #1072-promoted) field iterated inside a null guard —
/// which C# flow analysis proves non-null — must be rendered with an explicit
/// `!!` on the iterable, otherwise gsc rejects `for x in field` with
/// GS0116 ("is not indexable"). A plainly non-null iterable keeps no assertion.
open class ForEachNullForgivenessTranslationTests {
    @Fact
    func ForEachOverNullCheckedField_AssertsIterable() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        private uint[]? offsets;
        public void Sum()
        {
            if (offsets != null)
            {
                foreach (var o in offsets)
                {
                    System.Console.WriteLine(o);
                }
            }
        }
    }
}`)
        // The field is promoted to a nullable array and the guarded iteration
        // asserts non-null on the iterable.
        Assert.Contains("for o in offsets!!", printed)
    }

    @Fact
    func ForEachOverNonNullField_NoAssertion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        private uint[] offsets = new uint[4];
        public void Sum()
        {
            foreach (var o in offsets)
            {
                System.Console.WriteLine(o);
            }
        }
    }
}`)
        Assert.Contains("for o in offsets ", printed)
        Assert.DoesNotContain("offsets!!", printed)
    }

    @Fact
    func NullCheckedFieldAsArgument_AssertsArgument() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        private string? text;
        private static int Len(string s) => s.Length;
        public int M()
        {
            if (text == null)
            {
                return 0;
            }
            else
            {
                return Len(text);
            }
        }
    }
}`)
        // The `string?` field is flow-proven non-null in the else branch and is
        // passed to a `string` parameter, so the argument carries `!!`.
        Assert.Contains("Len(text!!)", printed)
    }

    @Fact
    func NullCheckedFieldInNameOf_NotAsserted() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class C
    {
        private string? text;
        public string M()
        {
            if (text == null)
            {
                return string.Empty;
            }
            else
            {
                return nameof(text) + text.Length;
            }
        }
    }
}`)
        // cs2gs constant-folds C# nameof before identifier allocation or
        // null-forgiveness can change its source-level string value.
        Assert.Contains("\"text\"", printed)
        Assert.DoesNotContain("nameof(", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
