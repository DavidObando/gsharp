// <copyright file="Issue1885LockStatementTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Regression tests for issue #1885: a C# `lock (expr) { … }` statement
/// used to lower to a hand-rolled `Monitor.Enter`/try-finally/
/// `Monitor.Exit` sequence that referenced `Monitor` without ever
/// emitting `import System.Threading`, so the translated G# failed to
/// compile with GS0157. G# now has a first-class `lock` keyword with the
/// same semantics, so the translator emits it directly and no import is
/// needed at all.
open class Issue1885LockStatementTranslationTests {
    @Fact
    func LockStatement_TranslatesToGSharpLockKeyword_NotMonitorCalls() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Counter
    {
        private readonly object gate = new object();
        private int value;

        public void Increment()
        {
            lock (gate)
            {
                value = value + 1;
            }
        }
    }
}`)
        // The G# `lock` keyword is emitted directly — no Monitor.Enter/Exit
        // hand-lowering, and (critically) no import of System.Threading is
        // needed since `lock` is a language construct, not a library call.
        Assert.Contains("lock gate {", printed)
        Assert.DoesNotContain("Monitor", printed)
        Assert.DoesNotContain("System.Threading", printed)
    }

    /// Any reference-type target — not just a field literally named `Gate`
    /// — must translate. Locking on a freshly allocated local object (a common
    /// dedicated-lock-object idiom) exercises a non-field target.
    @Fact
    func LockStatement_OnLocalObjectTarget_Translates() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Worker
    {
        public void Run()
        {
            object sync = new object();
            lock (sync)
            {
                System.Console.WriteLine("in lock");
            }
        }
    }
}`)
        Assert.Contains("lock sync {", printed)
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
