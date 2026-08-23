// <copyright file="LocalFunctionHoistTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for C# local functions. C# local functions are
/// hoisted (callable before their lexical declaration), but G# renders them as
/// <c>let name = func(...)</c> bindings, which are not hoisted and cannot be
/// forward-referenced (GS0130/GS0125, issue #2231). When a local function is
/// referenced before its declaration, the translator moves its <c>let</c>
/// binding to just before that first use — but no earlier than the last
/// sibling local it captures by closure (G# closures require captured locals
/// to already be in scope at the binding point).
/// </summary>
public class LocalFunctionHoistTranslationTests
{
    [Fact]
    public void LocalFunctionCalledBeforeDeclaration_IsHoistedToTop()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public int Field;
        public void M(int input)
        {
            if (input > 0)
            {
                Helper(input);
            }
            else
            {
                Helper(0);
            }

            void Helper(int x)
            {
                Field = x;
            }
        }
    }
}");

        // The `let Helper = func ...` binding must precede the first call site.
        int declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal);
        int callIndex = printed.IndexOf("Helper(input)", StringComparison.Ordinal);
        Assert.True(declIndex >= 0, "Local function should be emitted as a let binding.\n" + printed);
        Assert.True(callIndex >= 0, "Call site should be present.\n" + printed);
        Assert.True(
            declIndex < callIndex,
            "Local function declaration must be hoisted above its first use.\n" + printed);
    }

    [Fact]
    public void LocalFunctionCapturingSiblingLocal_IsHoistedAfterCaptureNotAboveIt()
    {
        // Issue #2231, case (c): `Helper` is used before its textual
        // declaration AND captures `seed`, a sibling local declared between
        // the original declaration position and the use. The fix must hoist
        // `let Helper` above the use but *below* `let seed` — not skip
        // hoisting altogether (which would leave the forward-reference bug
        // unfixed) and not hoist to the very top of the block (which would
        // break the `seed` capture).
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int M()
        {
            int seed = 5;
            int result = Helper();

            int Helper()
            {
                return seed + 1;
            }

            return result;
        }
    }
}");

        int seedIndex = printed.IndexOf("let seed", StringComparison.Ordinal);
        int declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal);
        int useIndex = printed.IndexOf("Helper()", StringComparison.Ordinal);
        Assert.True(seedIndex >= 0 && declIndex >= 0 && useIndex >= 0, "All three should be present.\n" + printed);
        Assert.True(
            seedIndex < declIndex,
            "Local function capturing a sibling local must not be hoisted above it.\n" + printed);
        Assert.True(
            declIndex < useIndex,
            "Local function must still be hoisted above its first use.\n" + printed);

        CompileAndRun(printed, "Console.WriteLine(C().M())", "6");
    }

    [Fact]
    public void ExpressionBodiedLocalFunction_ReturnsConditionalValue()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public string M(bool first)
        {
            string Pick() => first ? ""first"" : ""second"";
            return Pick();
        }
    }
}");

        Assert.Contains("return if first", printed, StringComparison.Ordinal);
        CompileAndRun(printed, "Console.WriteLine(C().M(true))", "first");
    }

    [Fact]
    public void MinimalRepro_LetActionBeforeLetHandler_Issue2231()
    {
        // Issue #2231's exact minimal repro: a delegate-typed local function
        // assigned to a plain local before its declaration.
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public void M()
        {
            Action<int> action = handler;

            void handler(int x)
            {
            }
        }
    }
}");

        int declIndex = printed.IndexOf("let handler", StringComparison.Ordinal);
        int actionIndex = printed.IndexOf("let action", StringComparison.Ordinal);
        Assert.True(declIndex >= 0 && actionIndex >= 0, "Both bindings should be present.\n" + printed);
        Assert.True(
            declIndex < actionIndex,
            "`let handler` must be hoisted above `let action = handler`.\n" + printed);

        CompileAndRun(
            printed,
            "C().M()\nConsole.WriteLine(\"ok\")",
            "ok");
    }

    [Fact]
    public void EventHandlerPlusEqualsForwardReference_IsHoisted()
    {
        // Issue #2231: mirrors the `AudibleApi.cs` shape — a local function
        // subscribed to an event with `+=` before its textual declaration.
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public event EventHandler Progress;

        public void M()
        {
            Progress += OnProgress;

            void OnProgress(object sender, EventArgs e)
            {
            }
        }
    }
}");

        int declIndex = printed.IndexOf("let OnProgress", StringComparison.Ordinal);
        int useIndex = printed.IndexOf("OnProgress", StringComparison.Ordinal);
        Assert.True(declIndex >= 0, "Local function should be emitted as a let binding.\n" + printed);
        Assert.True(
            declIndex < useIndex,
            "Local function subscribed via `+=` must be hoisted above the subscription.\n" + printed);
    }

    [Fact]
    public void MutuallyRecursiveLocalFunctions_AreBothHoistedBeforeFirstExternalUse()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void M(int input)
        {
            if (input > 0)
            {
                A();
            }

            void A()
            {
                B();
            }

            void B()
            {
                A();
            }
        }
    }
}");

    Assert.DoesNotContain("let A", printed, StringComparison.Ordinal);
    Assert.DoesNotContain("let B", printed, StringComparison.Ordinal);
    Assert.Contains("__local_M_A", printed, StringComparison.Ordinal);
    Assert.Contains("__local_M_B", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CapturingRecursiveLocalFunction_LiftsMutableCaptureByRef()
    {
    string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        int sum = 0;

        void Add(int current)
        {
            sum += current;
            if (current > 0)
            {
                Add(current - 1);
            }
        }

        Add(input);
        if (sum != 6)
        {
            throw new Exception(""wrong sum"");
        }
    }
    }
}");

    // Issue #3399 hybrid: a capturing recursive local lowers to G#'s
    // nullable function-typed local, not a synthesized capture-passing helper.
    Assert.DoesNotContain("let Add", printed, StringComparison.Ordinal);
    Assert.DoesNotContain("__local_Run_Add", printed, StringComparison.Ordinal);
    Assert.Contains("var Add", printed, StringComparison.Ordinal);
    Assert.Contains("Add = func", printed, StringComparison.Ordinal);
    Assert.Contains("Add!!(", printed, StringComparison.Ordinal);
    CompileAndRun(
        printed,
        "C().Run(3)\nConsole.WriteLine(\"ok\")",
        "ok");
    }

    [Fact]
    public void MutuallyRecursiveLocalFunctions_ForwardSharedMutableCapture()
    {
    string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        int sum = 0;

        void AddEven(int current)
        {
            sum += current;
            if (current > 0)
            {
                AddOdd(current - 1);
            }
        }

        void AddOdd(int current)
        {
            sum += current;
            if (current > 0)
            {
                AddEven(current - 1);
            }
        }

        AddEven(input);
        if (sum != 6)
        {
            throw new Exception(""wrong sum"");
        }
    }
    }
}");

    // Issue #3399 hybrid: a capturing mutually recursive SCC lowers to G#'s
    // nullable function-typed locals, not synthesized capture-passing helpers.
    Assert.DoesNotContain("let AddEven", printed, StringComparison.Ordinal);
    Assert.DoesNotContain("let AddOdd", printed, StringComparison.Ordinal);
    Assert.DoesNotContain("__local_Run_AddEven", printed, StringComparison.Ordinal);
    Assert.DoesNotContain("__local_Run_AddOdd", printed, StringComparison.Ordinal);
    Assert.Contains("var AddEven", printed, StringComparison.Ordinal);
    Assert.Contains("var AddOdd", printed, StringComparison.Ordinal);
    Assert.Contains("AddEven!!(", printed, StringComparison.Ordinal);
    Assert.Contains("AddOdd!!(", printed, StringComparison.Ordinal);
    CompileAndRun(
        printed,
        "C().Run(3)\nConsole.WriteLine(\"ok\")",
        "ok");
    }

    [Fact]
    public void CapturingLocalFunction_WithOutParameters_LiftsToMethod()
    {
    string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        int offset = 2;

        int Read(out int doubled)
        {
            doubled = input * 2;
            return doubled + offset;
        }

        int result = Read(out var doubled);
        if (result != 8 || doubled != 6)
        {
            throw new Exception(""wrong result"");
        }
    }
    }
}");

    Assert.DoesNotContain("let Read", printed, StringComparison.Ordinal);
    Assert.Contains("__local_Run_Read", printed, StringComparison.Ordinal);
    Assert.Contains("out doubled int32", printed, StringComparison.Ordinal);
    CompileAndRun(
        printed,
        "C().Run(3)\nConsole.WriteLine(\"ok\")",
        "ok");
    }

    [Fact]
    public void RecursiveHelper_CaptureKeepsNonNullableReferenceType()
    {
    string printed = TranslateUnit(@"
using System;
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
    public void Run(int input)
    {
        var values = new List<int>();

        void Add(int current)
        {
            values.Add(current);
            if (current > 0)
            {
                Add(current - 1);
            }
        }

        Add(input);
        if (values[0] != input)
        {
            throw new Exception(""wrong value"");
        }
    }
    }
}");

    // Issue #3399 hybrid: the captured local stays a plain non-nullable G#
    // local (`let values = List[int32]()`) captured by the nullable function
    // literal — no nullable reference type is introduced for the capture.
    Assert.Contains("let values = List[int32]()", printed, StringComparison.Ordinal);
    Assert.DoesNotContain("List[int32]?", printed, StringComparison.Ordinal);
    CompileAndRun(
        printed,
        "C().Run(3)\nConsole.WriteLine(\"ok\")",
        "ok");
    }

    [Fact]
    public void StaticRecursiveLocalFunction_IsLiftedToSharedHelper()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public int Factorial(int value)
        {
            static bool IsBaseCase(int current) => current <= 1;

            static int Visit(int current)
            {
                return IsBaseCase(current) ? 1 : current * Visit(current - 1);
            }

            return Visit(value);
        }
    }
}");

        Assert.DoesNotContain("let Visit", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let IsBaseCase", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Factorial_Visit", printed, StringComparison.Ordinal);
        Assert.Contains("__local_Factorial_IsBaseCase", printed, StringComparison.Ordinal);
        CompileAndRun(
            printed,
            "Console.WriteLine(C().Factorial(5))",
            "120");
    }

    [Fact]
    public void Issue2231MutualRecursionRemainsUnsupportedByGscLetBindings()
    {
        // Raw G# `let` bindings remain non-recursive. cs2gs avoids this form for
        // recursive C# local functions by lifting them to helper methods.
        const string Source = @"
package p
class C {
    func M() {
        let a = func (n int32) { b(n) }
        let b = func (n int32) { a(n) }
    }
}";
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2231-mutrec", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, Source);

        ProcessRunResult compile = ProcessRunner.Run(
            "dotnet",
            new[] { compiler, "/target:exe", $"/out:{dllPath}", gsPath },
            timeout: TimeSpan.FromSeconds(30));
        Assert.False(compile.TimedOut, compile.Output);
        Assert.True(
            compile.ExitCode != 0,
            "Forward-referencing `let` recursion is expected to still fail today:\n" +
                compile.Output);
        Assert.Contains("GS0130", compile.Output, StringComparison.Ordinal);
    }

    internal static string TranslateUnit(string source, string roundTripOnlyReason = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="callExpression"/>
    /// appended as a top-level entry statement) with the real <c>gsc</c> and runs
    /// it — proving the translated snippet actually binds (issue #2231's GS0125
    /// forward-reference bug is a binder-time error that a parse-only round-trip
    /// cannot catch).
    /// </summary>
    internal static void CompileAndRun(
        string printed,
        string callExpression,
        string expectedOutput = null)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2231-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        ProcessRunResult compile = ProcessRunner.Run(
            "dotnet",
            new[] { compiler, "/target:exe", $"/out:{dllPath}", gsPath },
            timeout: TimeSpan.FromSeconds(30));
        Assert.False(
            compile.TimedOut,
            $"gsc timed out and was killed. Output:\n{compile.Output}");
        Assert.True(
            compile.ExitCode == 0
                && !compile.Output.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compile.Output +
                "\n\nTranslated G#:\n" + printed);

        ProcessRunResult run = ProcessRunner.Run(
            "dotnet",
            new[] { dllPath },
            timeout: TimeSpan.FromSeconds(30));
        Assert.False(
            run.TimedOut,
            $"Translated program timed out and was killed. Output:\n{run.Output}");
        Assert.True(
            run.ExitCode == 0,
            "Translated snippet must run successfully. Output:\n" + run.Output);
        if (expectedOutput is not null)
        {
            Assert.Equal(expectedOutput, run.Stdout.Trim());
        }
    }

    internal static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
