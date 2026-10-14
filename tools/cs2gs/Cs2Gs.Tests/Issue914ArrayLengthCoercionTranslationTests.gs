// <copyright file="Issue914ArrayLengthCoercionTranslationTests.cs" company="GSharp">
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

/// Translation tests for the array-creation length coercion defect discovered
/// migrating `Oahu.Decrypt` (issue #914). C# array-creation expressions
/// accept any integral length (`new T[uint]`, `new T[long]`, …), but
/// the native G# allocation form `[n]T` (issue #1272) takes an
/// `int32`; a non-`int32` numeric length must be coerced via the
/// conversion-call form (`int32(n)`) so the allocation binds.
open class Issue914ArrayLengthCoercionTranslationTests {
    /// A `uint` length is coerced to `int32` via the conversion-call
    /// form inside the native `[n]T` allocation.
    @Fact
    func ArrayCreation_UintLength_CoercesToInt32() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class S { public int X; }

    public class C
    {
        public S[] Make(uint n) => new S[n];
    }
}`)
        Assert.Contains("[int32(n)]S", printed)
    }

    /// A `long` length is likewise coerced to `int32`.
    @Fact
    func ArrayCreation_LongLength_CoercesToInt32() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public byte[] Make(long n) => new byte[n];
    }
}`)
        Assert.Contains("[int32(n)]uint8", printed)
    }

    /// An `int` length is already `int32`; no conversion call is added.
    @Fact
    func ArrayCreation_IntLength_NoCoercion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class S { public int X; }

    public class C
    {
        public S[] Make(int n) => new S[n];
    }
}`)
        Assert.Contains("[n]S", printed)
        Assert.DoesNotContain("int32(n)", printed)
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
