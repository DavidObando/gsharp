// <copyright file="Issue3978NullConditionalOutVarScopeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3978: an inline <c>out var</c> argument inside a NULL-CONDITIONAL
/// access must bind in the scope enclosing the call, exactly as it does when
/// the receiver is spelled <c>receiver!!.</c>.
/// <para>
/// <c>BindNullConditionalAccessExpressionCore</c> pushes a temporary scope to
/// hold the synthetic <c>$ncap_N</c> capture local and popped it wholesale
/// after binding the right part, which threw away every declaration the right
/// part had made. <c>lookup?.TryGetValue(k, out var found) == true</c>
/// therefore reported <c>GS0125 Variable 'found' doesn't exist</c> at every
/// later reference, while the <c>!!</c> spelling of the same call compiled.
/// </para>
/// <para>
/// These tests EXECUTE the emitted assembly rather than only binding it: the
/// risk of hoisting a declaration out of a scope is that the local is emitted
/// but never assigned on the short-circuit path, which binds clean and then
/// reads garbage (or fails ilverify) at run time. The nil-receiver case below
/// is the one that pins that down.
/// </para>
/// </summary>
public class Issue3978NullConditionalOutVarScopeEmitTests
{
    [Fact]
    public void ConditionalAccess_InlineOutVar_IsVisibleAfterTheCall()
    {
        // Hit, miss-on-empty and nil-receiver in one program. The nil case
        // proves `?.` still short-circuits: the call never runs, so the
        // condition is nil (not `true`) and the binding is simply not taken.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func probe(lookup Dictionary[string, int32]?) string {
                if lookup?.TryGetValue("k", out var found) == true {
                    return "hit:" + found.ToString()
                }
                return "miss"
            }

            let live = Dictionary[string, int32]()
            live["k"] = 7
            Console.WriteLine(probe(live))
            Console.WriteLine(probe(Dictionary[string, int32]()))
            Console.WriteLine(probe(nil))
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"hit:7{Environment.NewLine}miss{Environment.NewLine}miss{Environment.NewLine}",
            output);
    }

    [Fact]
    public void ConditionalAccess_InlineOutVar_MatchesTheBangBangSpelling()
    {
        // The whole defect was that the RECEIVER SPELLING moved the binding.
        // Both spellings of the same call must produce the same result.
        var source = """
            package P
            import System
            import System.Collections.Generic

            let d = Dictionary[string, string]()
            d["a"] = "alpha"

            let viaAssertion = d!!.TryGetValue("a", out var asserted)
            Console.WriteLine(viaAssertion)
            Console.WriteLine(asserted)

            let nullable Dictionary[string, string]? = d
            if nullable?.TryGetValue("a", out var conditional) == true {
                Console.WriteLine(conditional)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"True{Environment.NewLine}alpha{Environment.NewLine}alpha{Environment.NewLine}",
            output);
    }

    [Fact]
    public void ConditionalAccess_InlineOutVar_SurvivesTheTranslatedSelfMigrationShape()
    {
        // The exact shape cs2gs emitted for tools/cs2gs/Cs2Gs.Pipeline's
        // TranslateStage after #3972: an `out var` inside a `?.` call that is
        // the last conjunct of an `&&` chain, consumed twice in the body.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func transform(
                enabled bool,
                moniker string,
                paths Dictionary[string, string]?,
                key string) string {
                if enabled &&
                    !string.IsNullOrEmpty(moniker) &&
                    paths?.TryGetValue(key, out var generatedProjectPath) == true {
                    return generatedProjectPath + "|" + generatedProjectPath
                }
                return "skipped"
            }

            let paths = Dictionary[string, string]()
            paths["p"] = "gen"
            Console.WriteLine(transform(true, "sdk", paths, "p"))
            Console.WriteLine(transform(true, "sdk", paths, "absent"))
            Console.WriteLine(transform(false, "sdk", paths, "p"))
            Console.WriteLine(transform(true, "", paths, "p"))
            Console.WriteLine(transform(true, "sdk", nil, "p"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"gen|gen{Environment.NewLine}skipped{Environment.NewLine}skipped{Environment.NewLine}" +
            $"skipped{Environment.NewLine}skipped{Environment.NewLine}",
            output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue3978_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
