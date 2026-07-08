// <copyright file="LocalFunctionHoistTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
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

        CompileAndRun(printed, "C().M()");
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

        CompileAndRun(printed, "C().M()");
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
        // Issue #2231, case (d): `A` and `B` call each other and are both used
        // (via `A`) before either's textual declaration. Both `let` bindings
        // must land before the external use, in their original relative
        // order. (Whether the mutual recursion itself binds in gsc is a
        // pre-existing, separate `let`-recursion limitation — see
        // Issue2231MutualRecursionRemainsUnsupportedByGscLetBindings below —
        // this test only checks the hoist ordering.)
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

        int aDeclIndex = printed.IndexOf("let A", StringComparison.Ordinal);
        int bDeclIndex = printed.IndexOf("let B", StringComparison.Ordinal);
        int ifIndex = printed.IndexOf("if ", StringComparison.Ordinal);
        Assert.True(ifIndex >= 0, "The external `if` call site should be present.\n" + printed);
        int useIndex = printed.IndexOf("A()", ifIndex, StringComparison.Ordinal);
        Assert.True(aDeclIndex >= 0 && bDeclIndex >= 0, "Both bindings should be present.\n" + printed);
        Assert.True(
            aDeclIndex < useIndex && bDeclIndex < useIndex,
            "Both mutually-recursive local functions must be hoisted above the first external use.\n" + printed);
        Assert.True(
            aDeclIndex < bDeclIndex,
            "Original relative declaration order (A before B) must be preserved.\n" + printed);
    }

    [Fact]
    public void Issue2231MutualRecursionRemainsUnsupportedByGscLetBindings()
    {
        // Documents a pre-existing, separate gsc limitation (not addressed by
        // this fix, per the issue's own scoping guidance): `let` bindings are
        // not letrec — a lambda cannot forward-reference a `let` name bound
        // later in the same block, so two mutually-recursive `let`-lambdas
        // can never both bind successfully, regardless of hoist order.
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

        (int exit, string output) = RunDotnet($"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(exit != 0, "Forward-referencing `let` recursion is expected to still fail today:\n" + output);
        Assert.Contains("GS0130", output, StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source)
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
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
    private static void CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2231-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string runOut) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
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
