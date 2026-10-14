// <copyright file="LocalExplicitTypePreservationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for preserving the explicit declared type of a C#
/// local that has an initializer of a different natural type (an implicit
/// conversion). cs2gs normally relies on G# inference for an initialized local,
/// but when the developer wrote an explicit type that widens the initializer
/// (e.g. `long startSample = 0;` where `0` is `int`), G# would
/// re-infer the narrower natural type and later operations such as
/// `startSample += sum/* int64 */` fail with GS0129. The type clause must be
/// preserved so the binding keeps the developer's intended type. When the
/// declared type and the initializer's natural type match, the clause is omitted
/// (idiomatic inference). The #1072 nullability promotion still applies.
open class LocalExplicitTypePreservationTests {
    @Fact
    func LongLocalInitializedFromIntLiteral_PreservesInt64Type() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public long F()
        {
            long startSample = 0;
            startSample += 1L;
            return startSample;
        }
    }
}`)
        Assert.Contains("var startSample int64 = 0", printed)
    }

    @Fact
    func IntLocalInitializedFromIntLiteral_OmitsTypeClause() {
        // Declared type matches the initializer's natural type: rely on inference.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int F()
        {
            int x = 0;
            x += 1;
            return x;
        }
    }
}`)
        Assert.Contains("var x = 0", printed)
        Assert.DoesNotContain("var x int32 = 0", printed)
    }

    @Fact
    func DoubleLocalInitializedFromIntLiteral_PreservesFloat64Type() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public double F()
        {
            double ratio = 1;
            return ratio;
        }
    }
}`)
        Assert.Contains("let ratio float64 =", printed)
    }

    @Fact
    func NullableReferenceLocalInitializedFromConcrete_PreservesNullableInterfaceType() {
        // The declared type (IBox) differs from the initializer's natural type
        // (Box), so the explicit type is preserved; because the local is later
        // null-assigned it is also promoted to nullable (#1072).
        let printed = TranslateUnit(`
namespace Demo
{
    public interface IBox { }
    public class Box : IBox { }
    public class C
    {
        public void F()
        {
            IBox b = new Box();
            b = null!;
            System.Console.WriteLine(b);
        }
    }
}`)
        Assert.Contains("b IBox?", printed)
    }

    @Fact
    func ForLoopHeader_StillTranslates() {
        // For-loop initializers also route through TranslateLocalDeclaration; the
        // declared type matches the literal's natural type so the header stays
        // idiomatic.
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public int F()
        {
            int total = 0;
            for (int i = 0; i < 3; i++)
            {
                total += i;
            }
            return total;
        }
    }
}`)
        Assert.Contains("for var i = 0", printed)
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
