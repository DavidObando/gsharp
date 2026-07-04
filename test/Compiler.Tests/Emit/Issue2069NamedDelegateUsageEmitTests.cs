// <copyright file="Issue2069NamedDelegateUsageEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2069 — a NAMED delegate type (<c>type Name = delegate func(...) ...</c>)
/// used as the type of a local variable, a class field/auto-property, or a
/// function parameter crashed emit with <c>InvalidOperationException: Delegate
/// '...' has no emitted TypeDef</c>.
/// <para>
/// Root cause: several lowering passes (<c>InterpolatedStringHandlerLowerer</c>,
/// <c>SideEffectSpiller</c>) reconstruct a new <see cref="GSharp.Core.CodeAnalysis.Binding.BoundProgram"/>
/// from a prior one but omitted the <c>Delegates</c> constructor argument,
/// silently truncating <c>BoundProgram.Delegates</c> to empty (the
/// convenience overload defaults it when not supplied). The emitter's
/// named-delegate TypeDef pass iterates exactly that (now-empty) collection,
/// so any named delegate never got an emitted TypeDef whenever one of those
/// rewriters ran on the compilation — which happens whenever a statement
/// needs side-effect spilling (e.g. a property/field assignment used again as
/// an argument in the same statement), not merely by referencing the type.
/// The fix threads <c>program.Delegates</c> through both reconstructions,
/// matching the other two BoundProgram-rebuilding rewriters
/// (<c>BaseCallForwarderRewriter</c>, <c>CaptureBoxingRewriter</c>) that
/// already did this correctly.
/// </para>
/// Each fact below uses a UNIQUE package name because the in-process type
/// caches are name-keyed.
/// </summary>
public class Issue2069NamedDelegateUsageEmitTests
{
    [Fact]
    public void EndToEnd_NamedDelegate_AsLocalVariableType_Runs()
    {
        const string source = """
            package i2069local
            import System

            type TickHandler = delegate func(n int32) void

            func Main() {
                var h TickHandler = (n int32) -> System.Console.WriteLine(n * 2)
                h(21)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_NamedDelegate_AsFieldAndParamType_Runs()
    {
        // Reproduces the exact issue #2069 shape: a named-delegate-typed
        // auto-property assigned via a member-access setter and then reread
        // as an argument in the SAME statement, which forces the
        // SideEffectSpiller rewriter to reconstruct BoundProgram.
        const string source = """
            package i2069fieldparam
            import System

            type TickHandler = delegate func(n int32) void

            class C {
                prop H TickHandler { get; set; }
            }

            func Apply(h TickHandler) {
                h(1)
            }

            func Main() {
                var c = C()
                c.H = (n int32) -> System.Console.WriteLine(n + 99)
                Apply(c.H)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("100\n", output);
    }

    [Fact]
    public void EndToEnd_NamedDelegate_AsPlainFieldType_Runs()
    {
        const string source = """
            package i2069plainfield
            import System

            type TickHandler = delegate func(n int32) void

            class C {
                var H TickHandler
            }

            func Main() {
                var c = C()
                c.H = (n int32) -> System.Console.WriteLine(n)
                c.H(7)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    [Fact]
    public void EndToEnd_NamedDelegate_AsParameterType_Runs()
    {
        const string source = """
            package i2069param
            import System

            type TickHandler = delegate func(n int32) void

            func Apply(h TickHandler) {
                h(5)
            }

            func Main() {
                Apply((n int32) -> System.Console.WriteLine(n * 10))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("50\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2069_exe_").FullName;
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
