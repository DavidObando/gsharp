// <copyright file="Issue2382TopLevelStatementsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #2382: cs2gs translates native C# top-level statements
/// (`GlobalStatementSyntax` — no enclosing class/method syntax at all, as
/// opposed to an explicit `Main` method hoisted by
/// `CSharpToGSharpTranslator.DeclarationVisitor.TranslateEntryType`,
/// which issue #1904's tests already cover) directly to G# native top-level
/// statements (ADR-0066): the implicit `args` binding, top-level
/// `await`, a top-level `return`, ordinary declarations/control
/// flow, and top-level local functions — hoisted to a genuine top-level
/// `func` sibling when capture-free (unlocking unrestricted forward/
/// mutual reference, unlike a `let` binding) or kept as an ordered
/// `let` binding when a sibling top-level local (or the implicit
/// `args`) is captured.
///
/// The Oahu trigger is `tools/Oahu.Diagnostics/Program.cs`: top-level
/// statements that reference `args`, a top-level `await` + a
/// top-level `return` of an awaited call, and a trailing
/// `static void RenderPretty(DiagnosticReport report)` local function
/// with no captures. (cref:TopLevelStatements_AsyncAwaitWithIntReturn_MatchesOahuDiagnosticsShape)
/// models that exact combined shape (generalized to an async, int-returning
/// hoisted helper for a stronger regression) end-to-end through the real
/// `gsc`.
open class Issue2382TopLevelStatementsTranslationTests {
    @Fact
    func SimpleSyncProgram_LowersToTopLevelStatements() {
        let printed = Render(`
using System;

Console.WriteLine("hello");
`)
        Assert.Contains("Console.WriteLine(\"hello\")", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Main", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("class Program", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("hello", stdout.Trim())
    }

    @Fact
    func ReturnInt_LowersToTopLevelReturn() {
        let printed = Render(`
return 42;
`)
        Assert.Contains("return 42", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, _) = CompileAndRunProgram(printed)
        Assert.Equal(42, exit)
    }

    @Fact
    func ImplicitArgs_UsesArgsIdentifierDirectly() {
        let printed = Render(`
using System;

Console.WriteLine(args.Length);
`)
        Assert.Contains("args.Length", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("0", stdout.Trim())
    }

    @Fact
    func TopLevelAwait_LowersToTopLevelAwaitStatement() {
        let printed = Render(`
using System;
using System.Threading.Tasks;

await Task.Delay(1);
Console.WriteLine("done");
`)
        Assert.Contains("await Task.Delay(1)", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("done", stdout.Trim())
    }

    @Fact
    func AsyncAwaitWithIntReturn_MatchesOahuDiagnosticsShape() {
        // Models the exact combined Oahu.Diagnostics/Program.cs shape: a
        // top-level `await`, a top-level `return` of an awaited call — called
        // BEFORE its own declaration (mirrors `RenderPretty` appearing after
        // its call site) — through a `static` (therefore always capture-free,
        // issue #2382) async top-level local function.
        let printed = Render(`
using System;
using System.Threading.Tasks;

Console.WriteLine("before");
await Task.Delay(1);
return await ComputeAsync();

static async Task<int> ComputeAsync()
{
    await Task.Delay(1);
    return 5;
}
`)
        // The static local function must be hoisted to a genuine sibling
        // top-level `func` (forward-referenceable), never a `let` binding.
        Assert.DoesNotContain("let ComputeAsync", printed, StringComparison.Ordinal)
        Assert.Contains("async func ComputeAsync()", printed, StringComparison.Ordinal)
        Assert.Contains("await Task.Delay(1)", printed, StringComparison.Ordinal)
        Assert.Contains("return await ComputeAsync()", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(5, exit)
        Assert.Equal("before", stdout.Trim())
    }

    @Fact
    func CaptureFreeStaticLocalFunction_HoistsToTopLevelFuncNotLetBinding() {
        // Mirrors Oahu.Diagnostics' trailing `static void RenderPretty(...)`:
        // called before its own textual declaration, referencing only its own
        // parameter (no sibling top-level local, no `args`).
        let printed = Render(`
using System;

Greet("world");

static void Greet(string name)
{
    Console.WriteLine($"Hello, {name}!");
}
`)
        Assert.DoesNotContain("let Greet", printed, StringComparison.Ordinal)
        Assert.Contains("func Greet(name string)", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("Hello, world!", stdout.Trim())
    }

    @Fact
    func NonStaticButActuallyCaptureFreeLocalFunction_IsAlsoHoisted() {
        // Exercises the body-walk branch of `IsTopLevelLocalFunctionCaptureFree`
        // (not just the `static`-modifier fast path): a NON-static local
        // function that nonetheless references no sibling top-level local and
        // no `args` must still be hoisted to a top-level `func`.
        let printed = Render(`
using System;

Console.WriteLine(Square(6));

int Square(int n) => n * n;
`)
        Assert.DoesNotContain("let Square", printed, StringComparison.Ordinal)
        Assert.Contains("func Square(n int32)", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("36", stdout.Trim())
    }

    @Fact
    func MutuallyReferencingCaptureFreeLocalFunctions_HoistToIndependentlyOrderedFuncs() {
        // Two `static` top-level local functions calling EACH OTHER — a
        // mutual/forward reference. Issue #4219 later taught gsc to support
        // exactly this shape for a consecutive run of non-generic
        // function-literal `let`s too (see Cs2Gs.Tests.
        // LocalFunctionHoistTranslationTests.
        // Issue2231MutualRecursionNowSupportedByGscLetBindings) — but this
        // translator still doesn't emit that form for a recursive C# local
        // function. Hoisting to genuine top-level `func`s (pre-declared in
        // binding scope regardless of textual order, ADR-0066) is this
        // translator's own, independent fix for the capture-free case.
        let printed = Render(`
using System;

Console.WriteLine(IsEven(4));

static bool IsEven(int n) => n == 0 || IsOdd(n - 1);

static bool IsOdd(int n) => n != 0 && IsEven(n - 1);
`)
        Assert.DoesNotContain("let IsEven", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let IsOdd", printed, StringComparison.Ordinal)
        Assert.Contains("func IsEven(n int32)", printed, StringComparison.Ordinal)
        Assert.Contains("func IsOdd(n int32)", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("True", stdout.Trim())
    }

    @Fact
    func MixedCapturingAndCleanLookingMutualRecursion_BothUseNullableSchemeNotHoisted() {
        // Copilot review follow-up on PR #4200 (issue #4197's widening of
        // `RegisterCapturingRecursiveLocalFunctions`): `IsTopLevelLocalFunctionCaptureFree`
        // only inspects a CANDIDATE's own body for a captured sibling local/
        // `args` — it has no idea whether the candidate CALLS another
        // top-level local function that itself stays behind as a
        // statement-local `let`/nullable-var (because THAT one genuinely
        // captures). Here `A` captures the sibling top-level local `seed`;
        // `B` looks capture-free in isolation (it only calls `A`, never
        // `seed`/`args` itself) but is mutually recursive with `A`.
        // <para>
        // Before the fix: `B` alone was hoisted to an independent top-level
        // `func` whose body referenced the bare name `A` — but `A` is a
        // statement-scoped `let` (or, once part of a group, a nullable
        // `var`), never a sibling `func`, so nothing actually declares `A`
        // from `B`'s perspective. `A` itself, edge-severed from the SCC by
        // `B`'s removal, was no longer recognized as recursive at all and
        // fell back to a plain (non-nullable, unregistered) `let` binding.
        // Depending on statement order this manifests anywhere from a
        // fragile accidental pass to an outright runtime
        // <c>NullReferenceException</c> (confirmed while diagnosing this
        // fix: invoking `B` before `A`'s `let` has executed crashes, since
        // `A` is still unassigned).
        // </para>
        // <para>
        // After the fix: the per-function hoist set is shrunk to a fixed
        // point (a candidate that calls a non-hoisted sibling drops out too),
        // so neither `A` nor `B` is hoisted — both flow into the (#4197-
        // widened) capturing-recursive registration pass together, which
        // recognizes the genuine 2-cycle and lowers both to the #3399
        // nullable-function-local scheme under their REAL names.
        // </para>
        let printed = Render(`
using System;

int seed = 3;

bool A(int n) => n <= 0 ? seed > 0 : B(n - 1);
bool B(int n) => n <= 0 ? false : A(n - 1);

Console.WriteLine(B(5));
`)
        Assert.DoesNotContain("func A(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func B(", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__local_", printed, StringComparison.Ordinal)
        Assert.Contains("var A", printed, StringComparison.Ordinal)
        Assert.Contains("var B", printed, StringComparison.Ordinal)
        Assert.Contains("A!!(", printed, StringComparison.Ordinal)
        Assert.Contains("B!!(", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("True", stdout.Trim())
    }

    @Fact
    func CapturingLocalFunction_StaysOrderedLetBinding() {
        // `Greet` reads `greeting`, a sibling top-level local — it must NOT be
        // hoisted to an independent top-level `func` (it has no implicit
        // access to a sibling top-level statement's local from there); it
        // keeps the pre-existing ordered `let`-binding closure form.
        let printed = Render(`
using System;

var greeting = "hello";

void Greet()
{
    Console.WriteLine(greeting);
}

Greet();
`)
        Assert.Contains("let Greet", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Greet(", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("hello", stdout.Trim())
    }

    @Fact
    func CapturingLocalFunctionCalledBeforeDeclaration_HoistsOrderedLetBindingAboveUse() {
        // Generalizes issue #2231's existing in-method-body hoist test to the
        // top-level-statement sequence: `Helper` is used before its textual
        // declaration and captures `seed` (a sibling top-level local) — the
        // `let Helper` binding must land above the use but below `let seed`.
        let printed = Render(`
using System;

int seed = 5;
int result = Helper();

int Helper()
{
    return seed + 1;
}

Console.WriteLine(result);
`)
        let seedIndex = printed.IndexOf("let seed", StringComparison.Ordinal)
        let declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal)
        let useIndex = printed.IndexOf("Helper()", StringComparison.Ordinal)
        Assert.True(seedIndex >= 0 && declIndex >= 0 && useIndex >= 0, "All three should be present.\n" + printed)
        Assert.True(seedIndex < declIndex, "`let Helper` must not be hoisted above `let seed`.\n" + printed)
        Assert.True(declIndex < useIndex, "`let Helper` must still be hoisted above its first use.\n" + printed)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("6", stdout.Trim())
    }

    @Fact
    func GenericCaptureFreeLocalFunction_HoistsToTopLevelGenericFunc() {
        let printed = Render(`
using System;

Console.WriteLine(Identity(42));

static T Identity<T>(T value) => value;
`)
        Assert.DoesNotContain("let Identity", printed, StringComparison.Ordinal)
        Assert.Contains("Identity[T]", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("42", stdout.Trim())
    }

    @Fact
    func MixedWithExplicitMain_TopLevelStatementsWinAsEntryPoint() {
        // ADR-0066 D6 / C# CS7022 (a warning, not an error): a compilation
        // with BOTH top-level statements and an explicit Main-shaped method
        // anywhere still compiles — the synthesized top-level entry point
        // wins and the explicit method becomes an ordinary, never-invoked
        // static method. cs2gs must not double-hoist or crash on this shape.
        let printed = Render(`
using System;

Console.WriteLine("top-level ran");

static class OtherEntry
{
    static void Main(string[] args)
    {
        Console.WriteLine("explicit Main ran");
    }
}
`, allowNonInfoDiagnostics: true)
        Assert.Contains("Console.WriteLine(\"top-level ran\")", printed, StringComparison.Ordinal)
        Assert.Contains("Main", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        // Only the top-level statement runs; the explicit (now-orphaned)
        // `OtherEntry.Main` is never invoked by anything.
        Assert.Equal("top-level ran", stdout.Trim())
    }

    @Fact
    func MultipleFiles_CoexistsWithNamespaceTypeDeclaredInAnotherFile() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Program.cs", `
using System;
using Demo;

Console.WriteLine(Greeter.Greet("Ada"));
`), ("Greeter.cs", `
namespace Demo
{
    public static class Greeter
    {
        public static string Greet(string name) => $"Hi, {name}";
    }
}
`)}, outputKind: OutputKind.ConsoleApplication)
        Assert.True(
            project.BoundWithoutErrors,
            "inline multi-file source should bind with no C# errors: " + string.Join(
                Environment.NewLine,
                project.ErrorDiagnostics
            )
        )
        Assert.Equal(2, project.Documents.Count)
        let translator = CSharpToGSharpTranslator()
        let printedFiles = List[string]()
        for document in project.Documents {
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = translator.TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
            )
            printedFiles.Add(GSharpPrinter.Print(unit))
        }
        let programPrinted = printedFiles[0]
        let greeterPrinted = printedFiles[1]
        Assert.Contains("Console.WriteLine(Greeter.Greet(\"Ada\"))", programPrinted, StringComparison.Ordinal)
        Assert.Contains("class Greeter", greeterPrinted, StringComparison.Ordinal)
        for printed in printedFiles {
            AssertRoundTripParses(printed)
        }
        let (exit, stdout) = CompileAndRunProgram(printedFiles.ToArray())
        Assert.Equal(0, exit)
        Assert.Equal("Hi, Ada", stdout.Trim())
    }

    shared {
        private func AssertRoundTripParses(printed string) {
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "CompileAndRunProgram binds the complete emitted file set after per-file parse checks."
            )
            Assert.True(
                result.Success,
                "Translated G# must round-trip-parse. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + printed
            )
        }

        private func Render(source string, allowNonInfoDiagnostics bool = false) string {
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
            if !allowNonInfoDiagnostics {
                // The top-level-statements hoist itself always logs an Info
                // diagnostic (issue #2382, mirroring T3/ADR-0115 §B.1) — only
                // reject a genuine Warning/Unsupported here.
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
                )
            }
            return GSharpPrinter.Print(unit)
        }

        /// Compiles a translated top-level G# PROGRAM (already includes its own
        /// entry statements — unlike `LocalFunctionHoistTranslationTests
        /// .CompileAndRun`, no extra call expression needs to be appended)
        /// with the real `gsc` and runs it, returning the process exit code
        /// and captured stdout+stderr.
        private func CompileAndRunProgram(printedFiles ...string)(Exit int32, Stdout string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2382-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPaths = List[string]()
            for var i = 0; i < printedFiles.Length; i++ {
                let gsPath = Path.Combine(workDir, "Program$i.gs")
                File.WriteAllText(gsPath, printedFiles[i])
                gsPaths.Add(gsPath)
            }
            let dllPath = Path.Combine(workDir, "Program.dll")
            let quotedSources = string.Join(" ", gsPaths.Select((p string) -> "\"$p\""))
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" $quotedSources")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated top-level program with zero errors. Output:\n" + compileOut + `

Translated G#:
` + string.Join(`
---
`, printedFiles)
            )
            return RunDotnet("\"$dllPath\"")
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
