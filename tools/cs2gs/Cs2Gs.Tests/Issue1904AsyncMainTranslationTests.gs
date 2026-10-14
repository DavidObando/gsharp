// <copyright file="Issue1904AsyncMainTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #1904: `async Task Main()` / `async Task<int> Main()`
/// must translate to G# top-level statements driven by the gsc-emitted
/// synchronous async-entry-point wrapper (see
/// `Issue1904AsyncEntryPointEmitTests` on the gsc side), NOT to a shape
/// that the CLR rejects at process start.
///
/// `Compilation.GetEntryPoint` only resolves when the compilation's
/// (cref:OutputKind) is (cref:OutputKind.ConsoleApplication), so
/// these tests pass that explicitly to
/// (cref:CSharpProjectLoader.LoadInMemory) (the default remains a
/// library, unchanged for every other test in this suite).
open class Issue1904AsyncMainTranslationTests {
    @Fact
    func AsyncTaskMain_NoArgs_LowersToTopLevelAwaitStatements() {
        let rendered = Render(`
using System;
using System.Threading.Tasks;

internal static class Program
{
    private static async Task Main()
    {
        Console.WriteLine("start");
        await Task.Delay(1);
        Console.WriteLine("end");
    }
}
`)
        Assert.Contains("await Task.Delay(1)", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(\"start\")", rendered, StringComparison.Ordinal)
        Assert.Contains("Console.WriteLine(\"end\")", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("func Main", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AsyncTaskIntMain_ReturnStatement_LowersToTopLevelReturn() {
        let rendered = Render(`
using System;
using System.Threading.Tasks;

internal static class Program
{
    private static async Task<int> Main()
    {
        await Task.Delay(1);
        return 7;
    }
}
`)
        Assert.Contains("await Task.Delay(1)", rendered, StringComparison.Ordinal)
        Assert.Contains("return 7", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func AsyncTaskMain_StringArgsParameter_LowersToImplicitArgsIdentifier() {
        // Main's `string[]` parameter can be named anything; G# top-level
        // statements only ever expose the fixed implicit `args` (ADR-0066 D1),
        // so a renamed parameter must be substituted to `args` in the body.
        let rendered = Render(`
using System;
using System.Threading.Tasks;

internal static class Program
{
    private static async Task Main(string[] arguments)
    {
        Console.WriteLine(arguments.Length);
        await Task.Delay(1);
    }
}
`)
        Assert.Contains("args.Length", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("arguments", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Program.cs", source)},
                outputKind: OutputKind.ConsoleApplication
            )
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            // The entry-type hoist itself always logs an Info diagnostic (T3 /
            // ADR-0115 §B.1) — only reject Warning/Unsupported here.
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
