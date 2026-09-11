// <copyright file="Issue4179UnobservedTaskRunResultRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4179 (split from #4129, umbrella #3501): 48 of #4129's test-parity
/// failures for the migrated <c>test/Compiler.Tests</c> app all funneled
/// through the SAME line, <c>Issue2891TryRegionFlowEmitTests.cs</c> /
/// <c>Issue2906ExhaustiveSwitchReturnEmitTests.cs</c>'s shared
/// <c>CompileVerifyLoadAndRun</c> helper:
/// <code>
/// var execution = Task.Run(
///     () => entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty&lt;string&gt;() }));
/// Assert.True(execution.Wait(TimeSpan.FromSeconds(10)), $"{name} execution timed out");
/// </code>
/// <para>
/// <c>test/Compiler.Tests.csproj</c> has no <c>&lt;Nullable&gt;</c> element, so
/// it compiles nullable-OBLIVIOUS (<see cref="NullableContextOptions.Disable"/>)
/// — the only mode <c>IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult</c>
/// (issue #3644/#4046) operates in. That heuristic assumed EVERY runtime lambda
/// handed to a generic call (<c>Task.Run&lt;TResult&gt;</c> included) sits under
/// a non-null delegate-return CONTRACT the surrounding oblivious C# implicitly
/// trusted, so it force-asserted the reflection-nullable
/// <c>MethodInfo.Invoke(...)</c> result with <c>!!</c> — a G# RUNTIME null
/// check (<c>MethodBodyEmitter.EmitUnary</c>: "`!!` is a runtime
/// null-assertion"), unlike C#'s purely compile-time postfix <c>!</c>. Since
/// <c>MethodInfo.Invoke</c> legitimately returns <see langword="null"/> for
/// every void-returning method — which <c>&lt;Main&gt;$</c> always is — and
/// nothing downstream ever reads <c>execution</c>'s wrapped value (only
/// <c>.Wait(...)</c>, which never touches it), the assertion threw a
/// <see cref="NullReferenceException"/> the instant the snippet's own emitted
/// entry point ran, wrapped by <c>Task.Run</c>'s <see cref="AggregateException"/>
/// — exactly the symptom the issue reports, on EVERY row of the two affected
/// theories (the shape is shared by all of them; it has nothing to do with any
/// individual snippet's switch/try/goto shape).
/// </para>
/// <para>
/// Fix: <c>Task.Run</c>/<c>Task.Factory.StartNew</c>'s <c>TResult</c> is chosen
/// SOLELY to carry the delegate's completion value back to whoever later reads
/// <c>.Result</c> or awaits it — unlike a LINQ selector (<c>Select</c>,
/// <c>Where</c>, ...), whose downstream enumeration DOES observe every
/// projected element (the #3644 <c>PrepareTemporaryBuildProps</c> shape, which
/// must keep asserting and does — see the negative-guard tests below). When
/// nothing in scope ever unwraps the <c>Task&lt;TResult&gt;</c>,
/// <c>LambdaResultFeedsUnobservedTaskRun</c> now recognizes the idiom and
/// leaves the lambda result bare, matching the original C#'s own inferred
/// <c>Task&lt;object?&gt;</c>.
/// </para>
/// </summary>
public sealed class Issue4179UnobservedTaskRunResultRegressionTests
{
    /// <summary>
    /// The exact shared-helper shape (issue #4179): a reflection
    /// <c>MethodInfo.Invoke(...)</c> call — nullable per its BCL-annotated
    /// signature — as the sole body of a lambda passed to <c>Task.Run</c>,
    /// observed afterward only through <c>.Wait(...)</c>. Must NOT assert.
    /// </summary>
    [Fact]
    public void TaskRun_ReflectionInvokeObservedOnlyThroughWait_StaysBare()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("entry.Invoke(nil, nil)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("entry.Invoke(nil, nil)!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Issue #4111 (a subset of #4179's 48 rows: the "AcceptedFiniteShape_
    /// VerifiesLoadsAndRuns — 30 rows" line item): the REAL
    /// <c>CompileVerifyLoadAndRun</c> helper does not pass a bare
    /// <see langword="null"/> as <c>MethodInfo.Invoke</c>'s second argument —
    /// it passes a conditional (ternary) expression,
    /// <c>entry.GetParameters().Length == 0 ? null : new object[] { ... }</c>.
    /// The positive test above only pins the bare-<see langword="null"/>
    /// shape, so a future regression in how
    /// <c>LambdaResultFeedsUnobservedTaskRun</c> handles a non-trivial
    /// argument expression at the call site would not be caught by it. This
    /// test pins the actual shape verbatim, closing that gap.
    /// <para>
    /// Issue #4112 is the REMAINING 18 of #4179's 48 rows, and this one test
    /// covers those too — the four line items
    /// <c>ExhaustiveSwitch_VerifiesLoadsAndRuns</c> (11 rows),
    /// <c>ExhaustiveSwitchStatement_UnmatchedValueFallsThrough</c> (5), and
    /// <c>ExhaustiveEnum_UnnamedRuntimeValue_ThrowsDefensively</c> /
    /// <c>ExhaustiveEnum_UnnamedValueWithFixedReturn_ThrowsDefensively</c>
    /// (1 each), so 30 + 18 = 48. They live in a SECOND test class, but no
    /// second test is needed here: the faulting line in
    /// <c>Issue2906ExhaustiveSwitchReturnEmitTests.cs</c> (lines 364-366) is
    /// BYTE-IDENTICAL to the <c>Issue2891TryRegionFlowEmitTests.cs</c> line
    /// (644-646) reproduced verbatim below, so the assertion already pins
    /// both. The two <c>CompileVerifyLoadAndRun</c> helpers do differ
    /// elsewhere — Issue2906 takes two optional <c>IlVerifier</c> parameters,
    /// Issue2891 wraps <c>Emit</c> in <c>try</c>/<c>catch</c>, they format
    /// diagnostics differently, and they use different temporary-assembly name
    /// prefixes — but every one of those is surrounding context this heuristic
    /// never inspects: it keys on the lambda result flowing into an unobserved
    /// <c>Task.Run</c>, and that expression is common to both.
    /// Recorded here because #4112's title blames gsc's
    /// exhaustive-switch emit path, which #4182 exonerated by running all 46
    /// snippet bodies from both files under a self-hosted gsc.
    /// </para>
    /// </summary>
    [Fact]
    public void TaskRun_ReflectionInvokeWithConditionalArgumentObservedOnlyThroughWait_StaysBare()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("entry.Invoke(", printed, StringComparison.Ordinal);
        Assert.Contains("GetParameters().Length == 0", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(")!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The general shape underlying #4179, without reflection: ANY
    /// nullable-returning call as an unobserved <c>Task.Run</c> lambda result
    /// must stay bare, not just <c>MethodInfo.Invoke</c>.
    /// </summary>
    [Fact]
    public void TaskRun_LocalNullableMethodObservedOnlyThroughWait_StaysBare()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("GetNullableObject()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetNullableObject()!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The <c>Task.Factory.StartNew</c> sibling of
    /// <see cref="TaskRun_LocalNullableMethodObservedOnlyThroughWait_StaysBare"/>.
    /// <c>Task.Factory.StartNew</c> is a meaningfully different call shape than
    /// <c>Task.Run</c> — a different containing type (<c>TaskFactory</c>, reached
    /// through the <c>Task.Factory</c> static property rather than a direct
    /// static method call) resolving to a distinct, heavily-overloaded method
    /// group — so this exercises <c>IsTaskRunEntryPoint</c>'s <c>"TaskFactory"</c>
    /// branch, which no prior test in this file touched.
    /// </summary>
    [Fact]
    public void TaskFactoryStartNew_LocalNullableMethodObservedOnlyThroughWait_StaysBare()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("GetNullableObject()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GetNullableObject()!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Precision guard: when the <c>Task.Run</c> result IS later unwrapped via
    /// <c>.Result</c>, the assertion must still fire — #4179's fix is scoped to
    /// values that are genuinely never observed, not to <c>Task.Run</c> as a
    /// blanket exemption.
    /// </summary>
    [Fact]
    public void TaskRun_ResultReadFromLocal_StillAssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The <c>Task.Factory.StartNew</c> sibling of
    /// <see cref="TaskRun_ResultReadFromLocal_StillAssertsNonNull"/>: proves the
    /// exemption is properly scoped for this call shape too, not just
    /// permissive — when the <c>StartNew</c> result IS unwrapped via
    /// <c>.Result</c>, the assertion must still fire.
    /// </summary>
    [Fact]
    public void TaskFactoryStartNew_ResultReadFromLocal_StillAssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Precision guard: a fluent <c>.Result</c> directly off <c>Task.Run(...)</c>
    /// (no intermediate local) must still assert.
    /// </summary>
    [Fact]
    public void TaskRun_FluentResult_StillAssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Precision guard: an awaited <c>Task.Run(...)</c> must still assert —
    /// <c>await</c> unwraps the value just as surely as <c>.Result</c> does.
    /// </summary>
    [Fact]
    public void TaskRun_Awaited_StillAssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("GetNullableObject()!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Regression guard: #3644's own motivating shape — a LINQ selector
    /// (generic, inferred <c>TResult</c>, exactly like <c>Task.Run</c>) whose
    /// projected elements ARE observed by the downstream enumeration — must be
    /// completely unaffected by #4179's fix. <c>LambdaResultFeedsUnobservedTaskRun</c>
    /// is scoped to <c>Task.Run</c>/<c>Task.Factory.StartNew</c> specifically and
    /// never even inspects a <c>Select</c> call.
    /// </summary>
    [Fact]
    public void Select_FlatAnnotatedBclValue_StillAssertsNonNull()
    {
        string printed = TranslateOblivious(@"
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
}");

        Assert.Contains("Path.GetDirectoryName(Path.GetFullPath(path))!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The functional proof that the FIXED shape actually runs cleanly under
    /// the real <c>gsc.dll</c> emitter, and — for anti-vacuity — that the OLD
    /// (buggy) shape genuinely throws the reported symptom rather than merely
    /// "looking different" in printed text. Both programs are hand-written G#
    /// (not re-derived from the translator) mirroring exactly what
    /// <see cref="TaskRun_ReflectionInvokeObservedOnlyThroughWait_StaysBare"/>
    /// proves the translator now emits (bare) versus emitted before this fix
    /// (<c>!!</c>): a reflection <c>Invoke</c> of a VOID method (so the result
    /// is genuinely null) wrapped in <c>Task.Run</c> and observed only through
    /// <c>.Wait(...)</c> — precisely <c>CompileVerifyLoadAndRun</c>'s shape.
    /// </summary>
    [Fact]
    public void SelfHostedShape_BareVersionRunsCleanly_BangBangVersionThrowsNre()
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        (int bareExit, string bareOutput) = CompileAndRun(compiler, BareSource);
        Assert.True(bareExit == 0, "the bare (fixed) shape must run cleanly. Output:\n" + bareOutput);
        Assert.Contains("done", bareOutput, StringComparison.Ordinal);

        (int buggyExit, string buggyOutput) = CompileAndRun(compiler, BangBangSource);
        Assert.True(
            buggyExit != 0 && buggyOutput.Contains("NullReferenceException", StringComparison.Ordinal),
            "the reverted (!!-asserted) shape must reproduce the reported NullReferenceException. Output:\n"
                + buggyOutput);
    }

    /// <summary>
    /// The <c>Task.Factory.StartNew</c> sibling of
    /// <see cref="SelfHostedShape_BareVersionRunsCleanly_BangBangVersionThrowsNre"/>,
    /// proving <c>IsTaskRunEntryPoint</c>'s <c>"TaskFactory"</c> branch holds up
    /// under the real emitter/runtime, not just in printed-text assertions.
    /// </summary>
    [Fact]
    public void SelfHostedShape_StartNew_BareVersionRunsCleanly_BangBangVersionThrowsNre()
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        (int bareExit, string bareOutput) = CompileAndRun(compiler, StartNewBareSource);
        Assert.True(bareExit == 0, "the bare (fixed) shape must run cleanly. Output:\n" + bareOutput);
        Assert.Contains("done", bareOutput, StringComparison.Ordinal);

        (int buggyExit, string buggyOutput) = CompileAndRun(compiler, StartNewBangBangSource);
        Assert.True(
            buggyExit != 0 && buggyOutput.Contains("NullReferenceException", StringComparison.Ordinal),
            "the reverted (!!-asserted) shape must reproduce the reported NullReferenceException. Output:\n"
                + buggyOutput);
    }

    private const string StartNewBareSource = """
        package Issue4179.StartNewBare

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
        }
        """;

    private const string StartNewBangBangSource = """
        package Issue4179.StartNewBangBang

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
        }
        """;

    private const string BareSource = """
        package Issue4179.Bare

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
        }
        """;

    private const string BangBangSource = """
        package Issue4179.BangBang

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
        }
        """;

    private static (int Exit, string Output) CompileAndRun(string compiler, string source)
    {
        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4179UnobservedTaskRunResultRegressionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Program.gs");
            string dllPath = Path.Combine(workDir, "Program.dll");
            File.WriteAllText(gsPath, source);

            (int compileExit, string compileOutput) = RunDotnet(
                $"\"{compiler}\" /target:exe /targetframework:net10.0 /out:\"{dllPath}\" \"{gsPath}\"");
            Assert.True(compileExit == 0, "gsc must compile the self-hosted-shape probe. Output:\n" + compileOutput);

            return RunDotnet($"\"{dllPath}\"");
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("failed to start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
