// <copyright file="Issue1886StaticGenericLocalFunctionTranslationTests.cs" company="GSharp">
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

/// Regression tests for issue #1886:
/// 1. A `static` local function's call site was translated as a class-member access
/// (`Fixture.Square(6)`, GS0158) instead of a direct call to its `let` binding (`Square(6)`) — Roslyn
/// reports a local function's `ContainingType` as the enclosing type even though it is not a sibling
/// type member.
/// 2. A generic local function (`T First<T>(a, b)`) could not be represented at all because G# function
/// literals had no way to declare type parameters (GS0113 on the body's `T`). cs2gs now emits the new
/// `let Name[T, ...] = func (...) ... { ... }` generic function-literal syntax.
open class Issue1886StaticGenericLocalFunctionTranslationTests {
    @Fact
    func StaticLocalFunction_CallSite_IsBareIdentifierCall_NotMemberAccess() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Fixture
    {
        public void M()
        {
            static int Square(int x) => x * x;
            System.Console.WriteLine(Square(6));
        }
    }
}`)
        Assert.Contains("Square(6)", printed)
        Assert.DoesNotContain("Fixture.Square", printed)
    }

    @Fact
    func GenericLocalFunction_TranslatesToGenericFunctionLiteralLetBinding() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Fixture
    {
        public void M()
        {
            T First<T>(T a, T b) => a;
            System.Console.WriteLine(First(1, 2));
            System.Console.WriteLine(First("x", "y"));
        }
    }
}`)
        Assert.Contains("let First[T]", printed)
        Assert.Contains("First(1, 2)", printed)
        Assert.DoesNotContain("Fixture.First", printed)
    }

    @Fact
    func GenericLocalFunction_MultipleTypeParameters_TranslatesAllOfThem() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Fixture
    {
        public void M()
        {
            string Combine<T, U>(T a, U b) => a.ToString() + b.ToString();
            System.Console.WriteLine(Combine(1, "y"));
        }
    }
}`)
        Assert.Contains("let Combine[T, U]", printed)
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
