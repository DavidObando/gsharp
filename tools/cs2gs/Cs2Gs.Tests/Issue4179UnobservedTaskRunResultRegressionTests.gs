// <copyright file="Issue4179UnobservedTaskRunResultRegressionTests.cs" company="GSharp">
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

/// Issue #4179 (split from #4129, umbrella #3501): 48 of #4129's test-parity
/// failures for the migrated `test/Compiler.Tests` app all funneled
/// through the SAME line, `Issue2891TryRegionFlowEmitTests.cs` /
/// `Issue2906ExhaustiveSwitchReturnEmitTests.cs`'s shared
/// `CompileVerifyLoadAndRun` helper:
/// ```
/// var execution = Task.Run(
/// () => entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() }));
/// Assert.True(execution.Wait(TimeSpan.FromSeconds(10)), $"{name} execution timed out");
/// ```
///
/// `test/Compiler.Tests.csproj` has no `<Nullable>` element, so
/// it compiles nullable-OBLIVIOUS ((cref:NullableContextOptions.Disable))
/// — the only mode `IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult`
/// (issue #3644/#4046) operates in. That heuristic assumed EVERY runtime lambda
/// handed to a generic call (`Task.Run<TResult>` included) sits under
/// a non-null delegate-return CONTRACT the surrounding oblivious C# implicitly
/// trusted, so it force-asserted the reflection-nullable
/// `MethodInfo.Invoke(...)` result with `!!` — a G# RUNTIME null
/// check (`MethodBodyEmitter.EmitUnary`: "`!!` is a runtime
/// null-assertion"), unlike C#'s purely compile-time postfix `!`. Since
/// `MethodInfo.Invoke` legitimately returns `null` for
/// every void-returning method — which `<Main>$` always is — and
/// nothing downstream ever reads `execution`'s wrapped value (only
/// `.Wait(...)`, which never touches it), the assertion threw a
/// (cref:NullReferenceException) the instant the snippet's own emitted
/// entry point ran, wrapped by `Task.Run`'s (cref:AggregateException)
/// — exactly the symptom the issue reports, on EVERY row of the two affected
/// theories (the shape is shared by all of them; it has nothing to do with any
/// individual snippet's switch/try/goto shape).
///
/// Fix: `Task.Run`/`Task.Factory.StartNew`'s `TResult` is chosen
/// SOLELY to carry the delegate's completion value back to whoever later reads
/// `.Result` or awaits it — unlike a LINQ selector (`Select`,
/// `Where`, ...), whose downstream enumeration DOES observe every
/// projected element (the #3644 `PrepareTemporaryBuildProps` shape, which
/// must keep asserting and does — see the negative-guard tests below). When
/// nothing in scope ever unwraps the `Task<TResult>`,
/// `LambdaResultFeedsUnobservedTaskRun` now recognizes the idiom and
/// leaves the lambda result bare, matching the original C#'s own inferred
/// `Task<object?>`.
class Issue4179UnobservedTaskRunResultRegressionTests {
    /// The exact shared-helper shape (issue #4179): a reflection
    /// `MethodInfo.Invoke(...)` call — nullable per its BCL-annotated
    /// signature — as the sole body of a lambda passed to `Task.Run`,
    /// observed afterward only through `.Wait(...)`. Must NOT assert.
    @Fact
    func TaskRun_ReflectionInvokeObservedOnlyThroughWait_StaysBare() {
        let printed = TranslateOblivious(`
using System;
using System.Reflection;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run(MethodInfo entry)
        {
            var execution = Task.Run(() => entry.Invoke(null, null));
            bool completed = execution.Wait(TimeSpan.FromSeconds(10));
            Console.WriteLine(completed);
        }
    }
}`)
        Assert.Contains("entry.Invoke(nil, nil)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("entry.Invoke(nil, nil)!!", printed, StringComparison.Ordinal)
    }

    /// Issue #4111 (a subset of #4179's 48 rows: the "AcceptedFiniteShape_
    /// VerifiesLoadsAndRuns — 30 rows" line item): the REAL
    /// `CompileVerifyLoadAndRun` helper does not pass a bare
    /// `null` as `MethodInfo.Invoke`'s second argument —
    /// it passes a conditional (ternary) expression,
    /// `entry.GetParameters().Length == 0 ? null : new object[] { ... }`.
    /// The positive test above only pins the bare-`null`
    /// shape, so a future regression in how
    /// `LambdaResultFeedsUnobservedTaskRun` handles a non-trivial
    /// argument expression at the call site would not be caught by it. This
    /// test pins the actual shape verbatim, closing that gap.
    ///
    /// Issue #4112 is the REMAINING 18 of #4179's 48 rows, and this one test
    /// covers those too — the four line items
    /// `ExhaustiveSwitch_VerifiesLoadsAndRuns` (11 rows),
    /// `ExhaustiveSwitchStatement_UnmatchedValueFallsThrough` (5), and
    /// `ExhaustiveEnum_UnnamedRuntimeValue_ThrowsDefensively` /
    /// `ExhaustiveEnum_UnnamedValueWithFixedReturn_ThrowsDefensively`
    /// (1 each), so 30 + 18 = 48. They live in a SECOND test class, but no
    /// second test is needed here: the faulting line in
    /// `Issue2906ExhaustiveSwitchReturnEmitTests.cs` (lines 364-366) is
    /// BYTE-IDENTICAL to the `Issue2891TryRegionFlowEmitTests.cs` line
    /// (644-646) reproduced verbatim below, so the assertion already pins
    /// both. The two `CompileVerifyLoadAndRun` helpers do differ
    /// elsewhere — Issue2906 takes two optional `IlVerifier` parameters,
    /// Issue2891 wraps `Emit` in `try`/`catch`, they format
    /// diagnostics differently, and they use different temporary-assembly name
    /// prefixes — but every one of those is surrounding context this heuristic
    /// never inspects: it keys on the lambda result flowing into an unobserved
    /// `Task.Run`, and that expression is common to both.
    /// Recorded here because #4112's title blames gsc's
    /// exhaustive-switch emit path, which #4182 exonerated by running all 46
    /// snippet bodies from both files under a self-hosted gsc.
    @Fact
    func TaskRun_ReflectionInvokeWithConditionalArgumentObservedOnlyThroughWait_StaysBare() {
        let printed = TranslateOblivious(`
using System;
using System.Reflection;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run(MethodInfo entry)
        {
            var execution = Task.Run(
                () => entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() }));
            bool completed = execution.Wait(TimeSpan.FromSeconds(10));
            Console.WriteLine(completed);
        }
    }
}`)
        Assert.Contains("entry.Invoke(", printed, StringComparison.Ordinal)
        Assert.Contains("GetParameters().Length == 0", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(")!!", printed, StringComparison.Ordinal)
    }

    /// The general shape underlying #4179, without reflection: ANY
    /// nullable-returning call as an unobserved `Task.Run` lambda result
    /// must stay bare, not just `MethodInfo.Invoke`.
    @Fact
    func TaskRun_LocalNullableMethodObservedOnlyThroughWait_StaysBare() {
        let printed = TranslateOblivious(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run()
        {
            var execution = Task.Run(() => GetNullableObject());
            execution.Wait(TimeSpan.FromSeconds(10));
        }

        private static object GetNullableObject() => null;
    }
}`)
        Assert.Contains("GetNullableObject()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetNullableObject()!!", printed, StringComparison.Ordinal)
    }

    /// The `Task.Factory.StartNew` sibling of
    /// (cref:TaskRun_LocalNullableMethodObservedOnlyThroughWait_StaysBare).
    /// `Task.Factory.StartNew` is a meaningfully different call shape than
    /// `Task.Run` — a different containing type (`TaskFactory`, reached
    /// through the `Task.Factory` static property rather than a direct
    /// static method call) resolving to a distinct, heavily-overloaded method
    /// group — so this exercises `IsTaskRunEntryPoint`'s `"TaskFactory"`
    /// branch, which no prior test in this file touched.
    @Fact
    func TaskFactoryStartNew_LocalNullableMethodObservedOnlyThroughWait_StaysBare() {
        let printed = TranslateOblivious(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run()
        {
            var execution = Task.Factory.StartNew(() => GetNullableObject());
            execution.Wait(TimeSpan.FromSeconds(10));
        }

        private static object GetNullableObject() => null;
    }
}`)
        Assert.Contains("GetNullableObject()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GetNullableObject()!!", printed, StringComparison.Ordinal)
    }

    /// Precision guard: when the `Task.Run` result IS later unwrapped via
    /// `.Result`, the assertion must still fire — #4179's fix is scoped to
    /// values that are genuinely never observed, not to `Task.Run` as a
    /// blanket exemption.
    @Fact
    func TaskRun_ResultReadFromLocal_StillAssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run()
        {
            var execution = Task.Run(() => GetNullableObject());
            object value = execution.Result;
            Console.WriteLine(value);
        }

        private static object GetNullableObject() => null;
    }
}`)
        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal)
    }

    /// The `Task.Factory.StartNew` sibling of
    /// (cref:TaskRun_ResultReadFromLocal_StillAssertsNonNull): proves the
    /// exemption is properly scoped for this call shape too, not just
    /// permissive — when the `StartNew` result IS unwrapped via
    /// `.Result`, the assertion must still fire.
    @Fact
    func TaskFactoryStartNew_ResultReadFromLocal_StillAssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run()
        {
            var execution = Task.Factory.StartNew(() => GetNullableObject());
            object value = execution.Result;
            Console.WriteLine(value);
        }

        private static object GetNullableObject() => null;
    }
}`)
        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal)
    }

    /// Precision guard: a fluent `.Result` directly off `Task.Run(...)`
    /// (no intermediate local) must still assert.
    @Fact
    func TaskRun_FluentResult_StillAssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static void Run()
        {
            object value = Task.Run(() => GetNullableObject()).Result;
            Console.WriteLine(value);
        }

        private static object GetNullableObject() => null;
    }
}`)
        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal)
    }

    /// Precision guard: an awaited `Task.Run(...)` must still assert —
    /// `await` unwraps the value just as surely as `.Result` does.
    @Fact
    func TaskRun_Awaited_StillAssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.Threading.Tasks;

namespace Demo
{
    public static class Runner
    {
        public static async Task RunAsync()
        {
            object value = await Task.Run(() => GetNullableObject());
            Console.WriteLine(value);
        }

        private static object GetNullableObject() => null;
    }
}`)
        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal)
    }

    /// Regression guard: #3644's own motivating shape — a LINQ selector
    /// (generic, inferred `TResult`, exactly like `Task.Run`) whose
    /// projected elements ARE observed by the downstream enumeration — must be
    /// completely unaffected by #4179's fix. `LambdaResultFeedsUnobservedTaskRun`
    /// is scoped to `Task.Run`/`Task.Factory.StartNew` specifically and
    /// never even inspects a `Select` call.
    @Fact
    func Select_FlatAnnotatedBclValue_StillAssertsNonNull() {
        let printed = TranslateOblivious(`
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Demo
{
    public static class Props
    {
        public static void Prepare(IEnumerable<string> generatedProjectPaths)
        {
            foreach (string projectDirectory in generatedProjectPaths
                .Select(path => Path.GetDirectoryName(Path.GetFullPath(path)))
                .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                Consume(projectDirectory);
            }
        }

        private static void Consume(string directory)
        {
            Console.WriteLine(directory);
        }
    }
}`)
        Assert.Contains("Path.GetDirectoryName(Path.GetFullPath(path))!!", printed, StringComparison.Ordinal)
    }

    /// The functional proof that the FIXED shape actually runs cleanly under
    /// the real `gsc.dll` emitter, and — for anti-vacuity — that the OLD
    /// (buggy) shape genuinely throws the reported symptom rather than merely
    /// "looking different" in printed text. Both programs are hand-written G#
    /// (not re-derived from the translator) mirroring exactly what
    /// (cref:TaskRun_ReflectionInvokeObservedOnlyThroughWait_StaysBare)
    /// proves the translator now emits (bare) versus emitted before this fix
    /// (`!!`): a reflection `Invoke` of a VOID method (so the result
    /// is genuinely null) wrapped in `Task.Run` and observed only through
    /// `.Wait(...)` — precisely `CompileVerifyLoadAndRun`'s shape.
    @Fact
    func SelfHostedShape_BareVersionRunsCleanly_BangBangVersionThrowsNre() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let (bareExit, bareOutput) = CompileAndRun(compiler, BareSource)
        Assert.True(bareExit == 0, "the bare (fixed) shape must run cleanly. Output:\n" + bareOutput)
        Assert.Contains("done", bareOutput, StringComparison.Ordinal)
        let (buggyExit, buggyOutput) = CompileAndRun(compiler, BangBangSource)
        Assert.True(
            buggyExit != 0 && buggyOutput.Contains("NullReferenceException", StringComparison.Ordinal),
            "the reverted (!!-asserted) shape must reproduce the reported NullReferenceException. Output:\n" +
                buggyOutput
        )
    }

    /// The `Task.Factory.StartNew` sibling of
    /// (cref:SelfHostedShape_BareVersionRunsCleanly_BangBangVersionThrowsNre),
    /// proving `IsTaskRunEntryPoint`'s `"TaskFactory"` branch holds up
    /// under the real emitter/runtime, not just in printed-text assertions.
    @Fact
    func SelfHostedShape_StartNew_BareVersionRunsCleanly_BangBangVersionThrowsNre() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let (bareExit, bareOutput) = CompileAndRun(compiler, StartNewBareSource)
        Assert.True(bareExit == 0, "the bare (fixed) shape must run cleanly. Output:\n" + bareOutput)
        Assert.Contains("done", bareOutput, StringComparison.Ordinal)
        let (buggyExit, buggyOutput) = CompileAndRun(compiler, StartNewBangBangSource)
        Assert.True(
            buggyExit != 0 && buggyOutput.Contains("NullReferenceException", StringComparison.Ordinal),
            "the reverted (!!-asserted) shape must reproduce the reported NullReferenceException. Output:\n" +
                buggyOutput
        )
    }

    shared {
        private const StartNewBareSource string = `package Issue4179.StartNewBare

import System
import System.Reflection
import System.Threading.Tasks

class Runner {
    shared {
        func VoidMethod() {
        }

        func Main() {
            let entry = Runner().GetType().GetMethod(
                "VoidMethod",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let execution = Task.Factory.StartNew(() -> entry.Invoke(nil, nil))
            let completed = execution.Wait(TimeSpan.FromSeconds(10))
            Console.WriteLine(if completed { "done" } else { "timed-out" })
        }
    }
}`

        private const StartNewBangBangSource string = `package Issue4179.StartNewBangBang

import System
import System.Reflection
import System.Threading.Tasks

class Runner {
    shared {
        func VoidMethod() {
        }

        func Main() {
            let entry = Runner().GetType().GetMethod(
                "VoidMethod",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let execution = Task.Factory.StartNew(() -> entry.Invoke(nil, nil)!!)
            let completed = execution.Wait(TimeSpan.FromSeconds(10))
            Console.WriteLine(if completed { "done" } else { "timed-out" })
        }
    }
}`

        private const BareSource string = `package Issue4179.Bare

import System
import System.Reflection
import System.Threading.Tasks

class Runner {
    shared {
        func VoidMethod() {
        }

        func Main() {
            let entry = Runner().GetType().GetMethod(
                "VoidMethod",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let execution = Task.Run(() -> entry.Invoke(nil, nil))
            let completed = execution.Wait(TimeSpan.FromSeconds(10))
            Console.WriteLine(if completed { "done" } else { "timed-out" })
        }
    }
}`

        private const BangBangSource string = `package Issue4179.BangBang

import System
import System.Reflection
import System.Threading.Tasks

class Runner {
    shared {
        func VoidMethod() {
        }

        func Main() {
            let entry = Runner().GetType().GetMethod(
                "VoidMethod",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )!!
            let execution = Task.Run(() -> entry.Invoke(nil, nil)!!)
            let completed = execution.Wait(TimeSpan.FromSeconds(10))
            Console.WriteLine(if completed { "done" } else { "timed-out" })
        }
    }
}`

        private func CompileAndRun(compiler string?, source string)(Exit int32, Output string) {
            let workDir = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4179UnobservedTaskRunResultRegressionTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Program.gs")
                let dllPath = Path.Combine(workDir, "Program.dll")
                File.WriteAllText(gsPath, source)
                let (compileExit, compileOutput) = RunDotnet(
                    "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
                )
                Assert.True(compileExit == 0, "gsc must compile the self-hosted-shape probe. Output:\n" + compileOutput)
                return RunDotnet("\"$dllPath\"")
            } finally {
                TryDelete(workDir)
            }
        }

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

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
