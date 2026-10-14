// <copyright file="Issue2202NullGuardNarrowedFieldForgivenessTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #2202: a plain null-check guard —
/// `if (F == null) {…} else { …F… }`, `if (F != null) { …F… }`, and the
/// ternary equivalents `F == null ? A : …F…` / `F != null ? …F… : A` —
/// narrows a nullable field/property `F` to non-null on the guarded branch.
/// gsc (by design, Kotlin-style smart casts) narrows only LOCALS, never
/// fields/properties, so the guarded read is rejected (GS0155/GS0156) unless
/// cs2gs inserts an explicit `F!!`. This generalizes the lazy-singleton
/// guard heuristic (issue #2164) to a plain null-check guard that does not
/// assign to the field.
open class Issue2202NullGuardNarrowedFieldForgivenessTranslationTests {
    @Fact
    func EqualsNullGuard_ElseBranch_AssertsNonNullFieldUse() {
        // `if (F == null) {...} else { return F; }` — F is provably non-null in
        // the else branch.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            if (F == null)
            {
                return "default";
            }
            else
            {
                return F;
            }
        }
    }
}`)
        Assert.Contains("return F!!", printed)
    }

    @Fact
    func IsNullGuard_ElseBranch_AssertsNonNullFieldUse() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            if (F is null)
            {
                return "default";
            }
            else
            {
                return F;
            }
        }
    }
}`)
        Assert.Contains("return F!!", printed)
    }

    @Fact
    func NotEqualsNullGuard_ThenBranch_AssertsNonNullFieldUse() {
        // `if (F != null) { return F; }` — F is provably non-null in the then
        // branch.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            if (F != null)
            {
                return F;
            }

            return "default";
        }
    }
}`)
        Assert.Contains("return F!!", printed)
    }

    @Fact
    func Ternary_NullCheck_WhenFalseArm_AssertsNonNullFieldUse() {
        // `F == null ? "0" : F` — F is provably non-null in the when-false
        // arm, and the whole conditional flows into `int.Parse(string)`, a
        // non-null metadata parameter, so the arm must be asserted.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public int Get()
        {
            return int.Parse(F == null ? "0" : F);
        }
    }
}`)
        Assert.Contains("F!!", printed)
    }

    @Fact
    func Ternary_NullCheck_IntoWidenedReturn_StaysBare() {
        // The same guarded arm returned from a method the whole-program taint
        // widens to `string?` (it returns the tainted F): the arm's effective
        // target is that nullable return, so it needs no assertion.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Get()
        {
            return F == null ? "default" : F;
        }
    }
}`)
        Assert.Contains("func Get() string?", printed)
        Assert.DoesNotContain("F!!", printed)
    }

    @Fact
    func Ternary_NonNullCheck_WhenTrueArm_AssertsNonNullFieldUse() {
        // `F != null ? F : "0"` — F is provably non-null in the when-true
        // arm, which flows into the non-null `int.Parse(string)` parameter.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public int Get()
        {
            return int.Parse(F != null ? F : "0");
        }
    }
}`)
        Assert.Contains("F!!", printed)
    }

    @Fact
    func UnguardedFieldUse_IsNotAsserted() {
        // `F` is null-tainted (via the null-check in Guarded()), but Unguarded()
        // reads it with no dominating guard — asserting `!!` there would not be
        // provably safe, so it must stay bare (and fails to compile downstream,
        // which is the expected/documented remaining gap, not this pass's job).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Holder
    {
        public string F { get; set; }

        public string Guarded()
        {
            if (F == null)
            {
                return "default";
            }
            else
            {
                return F;
            }
        }

        public string Unguarded()
        {
            return F;
        }
    }
}`)
        Assert.Contains("return F!!", printed)
        let unguardedIndex = printed.IndexOf("func Unguarded()", StringComparison.Ordinal)
        Assert.True(unguardedIndex >= 0)
        let unguardedBody = printed.Substring(unguardedIndex)
        Assert.DoesNotContain("!!", unguardedBody)
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
