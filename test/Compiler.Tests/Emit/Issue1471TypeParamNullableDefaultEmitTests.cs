// <copyright file="Issue1471TypeParamNullableDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1471 — a bare <c>default</c> whose target type is <c>T?</c> for an
/// unconstrained open type parameter <c>T</c>, flowing as an argument to a
/// generic method instantiated with <c>T?</c> (e.g.
/// <c>Task.FromResult[T?](default)</c>), used to lower to a
/// <c>BoundDefaultExpression(object)</c> because the method type-argument erased
/// to the reference-context <c>object</c> placeholder. That emitted <c>ldnull</c>
/// against the bare type parameter <c>!T</c> the callee expects, which is
/// unverifiable (<c>StackUnexpected: found Nullobjref, expected value 'T'</c>)
/// and throws <c>InvalidProgramException</c> at runtime for a value-type
/// instantiation. The binder now recovers the symbolic parameter type from the
/// method's type-argument vector so the default emits the verifiable
/// <c>ldloca; initobj; ldloc</c> slot shape for both reference and value
/// instantiations.
/// <list type="bullet">
/// <item>Facet A — the minimal repro instantiated with a VALUE type
/// (<c>int32</c>): <c>default(int32)</c> = <c>0</c>.</item>
/// <item>Facet B — instantiated with a REFERENCE type (<c>string</c>):
/// <c>default(string)</c> = <c>null</c>.</item>
/// <item>Facet C — a default argument to a user generic function other than
/// <c>Task.FromResult</c>, proving the fix is general.</item>
/// </list>
/// </summary>
public class Issue1471TypeParamNullableDefaultEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_TaskFromResultDefaultValueTypeInstantiation_RunsAndPrintsZero()
    {
        var source = """
            package Probe1471a
            import System
            import System.Threading.Tasks

            class Box1471A[T] {
                func Make() Task[T?] -> Task.FromResult[T?](default)
            }

            func Main() {
                Console.WriteLine(Box1471A[int32]().Make().Result)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_TaskFromResultDefaultReferenceTypeInstantiation_RunsAndPrintsNullSentinel()
    {
        var source = """
            package Probe1471b
            import System
            import System.Threading.Tasks

            class Box1471B[T] {
                func Make() Task[T?] -> Task.FromResult[T?](default)
            }

            func Main() {
                let result = Box1471B[string]().Make().Result
                Console.WriteLine("[" + (result ?? "null") + "]")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("[null]\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_DefaultArgumentToUserGenericFunction_Runs()
    {
        var source = """
            package Probe1471c
            import System

            func Identity1471C[U](u U?) U? -> u

            class Box1471C[T] {
                func Make() T? -> Identity1471C[T](default)
            }

            func Main() {
                let result = Box1471C[string]().Make()
                Console.WriteLine("[" + (result ?? "null") + "]")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("[null]\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1471_exe_").FullName;
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
