// <copyright file="Issue1473FunctionTypeEventEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1473 — a field-like event whose handler is a function-type delegate
/// (<c>event E (args) -&gt; ret</c>, mapped by G# to <c>System.Action&lt;...&gt;</c>/
/// <c>System.Func&lt;...&gt;</c>) emitted invalid IL in its generated <c>add_</c>/
/// <c>remove_</c> accessors when a type argument of the delegate is a user-declared
/// type. The closed delegate has no runtime CLR <see cref="Type"/>, so the EventDef
/// type and accessor-body <c>castclass</c> fell back to <c>System.Delegate</c>, which
/// disagreed with the <c>Interlocked.CompareExchange&lt;T&gt;</c> CAS loop spec and
/// failed ilverify with <c>StackUnexpected</c>. The fix encodes the concrete closed
/// delegate as a TypeSpec so all tokens agree.
/// <list type="bullet">
/// <item>Facet A — the minimal repro: an instance function-type event
/// <c>(object?, Args) -&gt; void</c> with a user <c>Args</c>; subscribe, fire,
/// unsubscribe.</item>
/// <item>Facet B — a <c>Func</c>-shaped function-type event (non-void return) of a
/// different arity with a user-type argument, to prove generality.</item>
/// <item>Facet C — a STATIC field-like function-type event with a user-type argument,
/// exercising the static add/remove accessor path (<c>EmitStaticEventAddAccessor</c>/
/// <c>EmitStaticEventRemoveAccessor</c>). G# has no call-form raise for static
/// field-like events, so this facet exercises subscribe/unsubscribe and relies on
/// the in-harness ilverify pass to prove the static accessor IL is valid.</item>
/// </list>
/// All three failed ilverify on current main and pass after the fix.
/// </summary>
public class Issue1473FunctionTypeEventEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_InstanceActionEventWithUserArg_Runs()
    {
        var source = """
            package EN1473A
            import System
            class ArgsA1473 : EventArgs {
                prop Value int32 { get; init; }
            }
            class SourceA1473 {
                event Fired (object?, ArgsA1473) -> void
                func Fire() {
                    Fired?(this, ArgsA1473() { Value = 7 })
                }
            }
            func Main() {
                let s = SourceA1473()
                s.Fired += (sender object?, a ArgsA1473) -> Console.WriteLine(a.Value)
                s.Fire()
                s.Fired -= (sender object?, a ArgsA1473) -> Console.WriteLine(a.Value)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_InstanceFuncEventWithUserArg_Runs()
    {
        var source = """
            package EN1473B
            import System
            class PayloadB1473 {
                prop Amount int32 { get; init; }
            }
            class SourceB1473 {
                event Compute (PayloadB1473) -> string
                func Invoke(p PayloadB1473) string {
                    let r = Compute?(p)
                    return r ?? "none"
                }
            }
            func Main() {
                let s = SourceB1473()
                s.Compute += (p PayloadB1473) -> p.Amount.ToString()
                let r = s.Invoke(PayloadB1473() { Amount = 21 })
                Console.WriteLine(r)
                s.Compute -= (p PayloadB1473) -> p.Amount.ToString()
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("21\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_StaticActionEventWithUserArg_Runs()
    {
        var source = """
            package EN1473C
            import System
            class ArgsC1473 : EventArgs {
                prop Value int32 { get; init; }
            }
            class SourceC1473 {
                shared {
                    event Pinged (object?, ArgsC1473) -> void
                }
            }
            func Main() {
                SourceC1473.Pinged += (sender object?, a ArgsC1473) -> Console.WriteLine(a.Value)
                SourceC1473.Pinged -= (sender object?, a ArgsC1473) -> Console.WriteLine(a.Value)
                Console.WriteLine("static-ok")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("static-ok\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1473_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
