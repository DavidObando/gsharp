// <copyright file="Issue3774CoalescingAssignmentAssertionTests.cs" company="GSharp">
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
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #3774 (sweep of the `EnsureNonNullAssertion` call sites,
/// generalized from #3771): C#'s `!` is ERASED at compile time, but G#'s
/// `!!` is a CHECKED assertion that THROWS on nil. Any site that emits
/// `!!` onto a value that can genuinely be nil at run time therefore adds a
/// throw the original program never had — invisible to the compiler, to
/// ILVerify, and to every binding-only assertion.
///
/// The site fixed here is the value-position `??=`
/// (`TranslateCoalescingAssignmentAsExpression`). The value of
/// `x ??= v` is nil exactly when `v` is, but the assertion's guard
/// asked only C#'s own annotations — which are empty in a nullable-OBLIVIOUS
/// compilation, so a same-project member the whole-program taint analysis
/// promoted to `T?` read as non-null and earned a `!!` anyway.
///
/// Two of the four tests EXECUTE the translated G# through the real
/// `gsc`, because this defect class is definitionally invisible to a
/// text-only assertion. The two "still asserts" tests are anti-vacuity guard
/// rails: they pass on `origin/main` too, and exist so a fix that simply
/// deleted the assertion could not pass this file.
open class Issue3774CoalescingAssignmentAssertionTests {
    /// The whole lowered construct is asserted, not a fragment: the #3771 agent
    /// caught its own first draft asserting a substring that main never emitted,
    /// so it passed vacuously. Here the exact conditional-expression form is
    /// pinned and the trailing `)!!` must be absent from it.
    @Fact
    func CoalescingAssignmentValue_DoesNotAssertAPromotedNullableRightHandSide() {
        let printed = TranslateOblivious(PromotedRightHandSideSource)
        Assert.Contains("let v string? = (if cache == nil { (cache = Make()) } else { cache })", printed)
        Assert.DoesNotContain("(if cache == nil { (cache = Make()) } else { cache })!!", printed)
    }

    /// The behavioural half. C# prints `nil`; on `origin/main` the
    /// translated G# throws a (cref:NullReferenceException) instead.
    @Fact
    func CoalescingAssignmentValue_YieldsNilInsteadOfThrowing() {
        let printed = TranslateOblivious(PromotedRightHandSideSource)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("nil", stdout.Trim())
    }

    /// Anti-vacuity guard rail (passes on `origin/main` as well): a
    /// right-hand side that genuinely cannot be nil keeps its faithful
    /// assertion, so the fix is a narrowing of the guard rather than a deletion.
    @Fact
    func CoalescingAssignmentValue_StillAssertsANonNullRightHandSide() {
        let printed = TranslateOblivious(NonNullRightHandSideSource)
        Assert.Contains("(if cache == nil { (cache = \"d\") } else { cache })!!", printed)
    }

    /// Anti-vacuity guard rail, behavioural half (passes on
    /// `origin/main` as well): the retained assertion still runs.
    @Fact
    func CoalescingAssignmentValue_NonNullRightHandSideStillRuns() {
        let printed = TranslateOblivious(NonNullRightHandSideSource)
        let stdout = CompileAndRun(printed, "C.Run()")
        Assert.Equal("d", stdout.Trim())
    }

    shared {
        private const PromotedRightHandSideSource string = `
using System;

namespace Demo
{
    public sealed class C
    {
        private static string cache;

        private static string Make()
        {
            return null;
        }

        public static void Run()
        {
            string v = (cache ??= Make());
            Console.WriteLine(v == null ? "nil" : v);
        }
    }
}`

        private const NonNullRightHandSideSource string = `
using System;

namespace Demo
{
    public sealed class C
    {
        private static string cache;

        public static void Run()
        {
            string v = (cache ??= "d");
            Console.WriteLine(v);
        }
    }
}`

        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
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

        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3774-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout + `

Translated G#:
` + printed)
            return stdout
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
