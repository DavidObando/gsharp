// <copyright file="Issue1272ArrayAllocationTranslationTests.cs" company="GSharp">
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

/// Issue #1272: a C# array creation with no initializer (`new T[n]`) must
/// translate to the native G# zero-initialised allocation form `[n]T`
/// rather than the BCL call `System.GC.AllocateArray[T](n)`. The
/// `new T[]{…}` initializer form is unaffected and keeps mapping to the
/// slice literal `[]T{…}`.
open class Issue1272ArrayAllocationTranslationTests {
    /// A constant-length allocation `new int[8]` maps to `[8]int32`.
    @Fact
    func ArrayCreation_ConstantLength_EmitsNativeAllocation() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int[] Make() => new int[8];
    }
}`)
        Assert.Contains("[8]int32", printed)
        Assert.DoesNotContain("AllocateArray", printed)
    }

    /// A runtime-length allocation `new int[n]` maps to `[n]int32`.
    @Fact
    func ArrayCreation_RuntimeLength_EmitsNativeAllocation() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int[] Make(int n) => new int[n];
    }
}`)
        Assert.Contains("[n]int32", printed)
        Assert.DoesNotContain("AllocateArray", printed)
    }

    /// The initializer form `new T[]{…}` still maps to the slice literal
    /// `[]T{…}` (unchanged by issue #1272).
    @Fact
    func ArrayCreation_WithInitializer_RemainsSliceLiteral() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int[] Make() => new int[]{ 1, 2, 3 };
    }
}`)
        Assert.Contains("[]int32{1, 2, 3}", printed)
        Assert.DoesNotContain("AllocateArray", printed)
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
