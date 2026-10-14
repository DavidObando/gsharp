// <copyright file="Issue4239ImplicitTopLevelLocalMutatedByLocalFunctionTests.cs" company="GSharp">
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

/// Issue #4239: a native C# top-level-statements program's implicit local
/// (`int value = 0;`) that is only ever written from INSIDE a sibling
/// local function's body was emitted as an immutable G# `let` binding,
/// because `TranslateTopLevelProgram` (unlike every other body owner —
/// see `TranslateBody`) never set `DocumentTranslationState
/// .CurrentBodyScope` before translating the entry statements. With that
/// scope left `null`, `IsLocalReassigned`'s underlying
/// `IsSymbolReassigned` walk short-circuited to `false`
/// on the null scope, so the write buried inside the local function's body
/// was never seen — the local was always bound `let`, and gsc correctly
/// rejected the local function's assignment against it with GS0127.
///
/// The fix sets `CurrentBodyScope` to the compilation-unit root (every
/// global statement, and everything nested inside them — including a local
/// function's own body — is a descendant of it) for the whole entry-point
/// translation, exactly mirroring how `TranslateBody` scopes an
/// ordinary method/constructor/lambda/local-function body to itself.
open class Issue4239ImplicitTopLevelLocalMutatedByLocalFunctionTests {
    @Fact
    func ImplicitLocalMutatedByLocalFunction_EmitsMutableBindingAndRuns() {
        // Exact repro from the issue.
        let printed = Render(`
int value = 0;
void Update() { value = 1; }
Update();
System.Console.WriteLine(value);
`)
        Assert.Contains("var value", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let value", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("1", stdout.Trim())
    }

    @Fact
    func ImplicitLocalMutatedByLambda_EmitsMutableBindingAndRuns() {
        // Same root cause, different capture vector: the write lives inside a
        // lambda body assigned to a sibling top-level local, rather than
        // inside a local function's block body.
        let printed = Render(`
using System;

int value = 0;
Action update = () => { value = 2; };
update();
Console.WriteLine(value);
`)
        Assert.Contains("var value", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let value", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("2", stdout.Trim())
    }

    @Fact
    func ImplicitLocalMutatedByNestedExpressionInLocalFunction_EmitsMutableBinding() {
        // The write is not a bare `value = ...;` statement but buried inside a
        // nested expression (a compound assignment used as a sub-expression),
        // still reachable only via the local-function body walk.
        let printed = Render(`
using System;

int total = 0;
void Add(int amount) { Console.WriteLine(total += amount); }
Add(3);
Add(4);
Console.WriteLine(total);
`)
        Assert.Contains("var total", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let total", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal(`3
7
7`, stdout.Trim().Replace("\r\n", "\n"))
    }

    @Fact
    func ImplicitLocalReadOnlyByLocalFunction_StaysImmutableBinding() {
        // Control: a sibling local function that only READS the captured
        // top-level local must keep the immutable `let` binding — the fix
        // must not widen mutability analysis, only correct it.
        let printed = Render(`
using System;

int value = 41;
void Print() { Console.WriteLine(value + 1); }
Print();
`)
        Assert.Contains("let value", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("var value", printed, StringComparison.Ordinal)
        AssertRoundTripParses(printed)
        let (exit, stdout) = CompileAndRunProgram(printed)
        Assert.Equal(0, exit)
        Assert.Equal("42", stdout.Trim())
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
        /// entry statements) with the real `gsc` and runs it, returning the
        /// process exit code and captured stdout+stderr.
        private func CompileAndRunProgram(printedFiles ...string)(Exit int32, Stdout string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4239-e2e", Guid.NewGuid().ToString("N"))
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
