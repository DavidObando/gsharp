// <copyright file="Issue2202SwitchExpressionObliviousPromotionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #2202: in a nullable-<em>oblivious</em>
/// compilation, (cref:ObliviousNullabilityAnalyzer)'s `ResolveSources`
/// / `IsDirectlyNullable` walk had no case at all for a C# switch
/// <em>expression</em> (`x switch { ... }`), unlike the ternary conditional
/// expression it already handled. A switch expression whose arms include a
/// literal `null`/`default` fallback, or an otherwise nullable-tainted
/// arm, is itself nullable — a function/property whose body is (or forwards) such
/// a switch expression must be emitted `T?` or gsc reports GS0179 "not all
/// code paths return a value"/GS0156 at the call site. This mirrors the existing
/// ternary handling (issue #2157) but for the switch-expression syntax shape.
open class Issue2202SwitchExpressionObliviousPromotionTranslationTests {
    @Fact
    func Oblivious_SwitchExpression_WithNullDefaultArm_RendersNullableReturn() {
        // The `_ => null` fallback arm makes the whole switch expression (and
        // therefore the method's inferred/declared return) nullable.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Base { }

    public class A : Base { }

    public class B : Base
    {
        public Base Inner;
    }

    public static class Extensions
    {
        public static Base Get(this Base common)
        {
            return common switch
            {
                A a => a,
                B b => b.Inner,
                _ => null,
            };
        }
    }
}`)
        Assert.Contains("Base?", printed)
    }

    @Fact
    func Oblivious_SwitchExpression_WithTaintedNullableArm_RendersNullableReturn() {
        // No literal `null` arm here — one arm forwards `b.Inner`, a field that
        // is directly assigned `null` elsewhere in the same compilation and is
        // therefore already tainted `Base?` by the whole-program taint analysis;
        // the switch expression itself must inherit that taint.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Base { }

    public class A : Base { }

    public class B : Base
    {
        public Base Inner;

        public void Clear()
        {
            Inner = null;
        }
    }

    public static class Extensions
    {
        public static Base Get(this Base common)
        {
            return common switch
            {
                A a => a,
                B b => b.Inner,
                _ => common,
            };
        }
    }
}`)
        Assert.Contains("Base?", printed)
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
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
