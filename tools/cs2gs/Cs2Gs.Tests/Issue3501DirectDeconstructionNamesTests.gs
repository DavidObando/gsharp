// <copyright file="Issue3501DirectDeconstructionNamesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3501 (__decon retirement): a single-variable declaration element of
/// a C# deconstruction assignment binds its REAL name directly in the native
/// G# `let (…)` — no structural temp plus re-declaration — when the local is
/// never reassigned and its declared type matches the deconstructed element.
open class Issue3501DirectDeconstructionNamesTests {
    @Fact
    func TypedAndVarSingleElements_BindDirectly() {
        let printed = Translate(`public class Runner
{
    private (int, string) RunDotnet(string[] args) => (0, "ok");

    public bool Probe()
    {
        (int probeExit, _) = this.RunDotnet(new[] { "tool", "run" });
        var ok = probeExit == 0;
        if (!ok)
        {
            (int restoreExit, _) = this.RunDotnet(new[] { "tool", "restore" });
            ok = restoreExit == 0;
        }

        (var a, var b) = this.RunDotnet(new[] { "x" });
        return ok && a == 0 && b.Length > 0;
    }
}`)
        Assert.Contains("let (probeExit, _) = this.RunDotnet", printed, StringComparison.Ordinal)
        Assert.Contains("let (restoreExit, _) = this.RunDotnet", printed, StringComparison.Ordinal)
        Assert.Contains("let (a, b) = this.RunDotnet", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func WideningTypedElement_KeepsTheTemp() {
        // `long total` widens the int element — direct binding would change
        // the local's type, so the temp + re-declaration stays.
        let printed = Translate(`public class Runner
{
    private (int, string) RunDotnet(string[] args) => (0, "ok");

    public long Probe()
    {
        (long total, _) = this.RunDotnet(new[] { "x" });
        return total;
    }
}`)
        Assert.Contains("let (totalValue, _) = this.RunDotnet", printed, StringComparison.Ordinal)
        Assert.Contains("let total", printed, StringComparison.Ordinal)
        Assert.Contains("totalValue", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
            )
            return rendered
        }
    }
}
