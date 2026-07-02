// <copyright file="Issue1615ScopeProtectedRegionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1615 — <c>scope { }</c> bodies are emitted as a try/finally region
/// (the finally awaits/disposes spawned tasks) but the body itself was
/// emitted with plain <c>EmitStatement</c> instead of <c>EmitProtectedRegion</c>,
/// and the lowerer never counted <c>BoundScopeStatement</c> toward
/// <c>tryNestingDepth</c>. A <c>return</c>/<c>break</c>/<c>goto</c> out of a
/// scope therefore emitted a bare <c>ret</c>/<c>br</c> from inside a
/// protected region — invalid per ECMA-335 (ReturnFromTry / BranchOutOfTry)
/// and an <see cref="InvalidProgramException"/> at JIT time. The fix emits
/// the scope body via <c>EmitProtectedRegion</c> (region-crossing gotos
/// become <c>leave</c>) and makes the lowerer rewrite <c>return</c> inside a
/// scope into a store-to-temp + goto-exit, exactly like <c>return</c> inside
/// a real <c>try</c>.
/// </summary>
public class Issue1615ScopeProtectedRegionEmitTests
{
    [Fact]
    public void ReturnInsideScope_ReturnsValue_AndVerifies()
    {
        var source = """
            package Probe1615a

            func f() int32 {
                scope {
                    return 1
                }
            }

            func Main() {
                System.Console.WriteLine(f())
            }
            """;

        var output = CompileAndRun(source, "1615a");
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void BreakInsideScopeInsideLoop_BreaksLoop_AndVerifies()
    {
        var source = """
            package Probe1615b

            func f() int32 {
                var i int32 = 0
                for i < 10 {
                    scope {
                        if i == 3 {
                            break
                        }
                    }
                    i = i + 1
                }
                return i
            }

            func Main() {
                System.Console.WriteLine(f())
            }
            """;

        var output = CompileAndRun(source, "1615b");
        Assert.Equal("3\n", output);
    }

    [Fact]
    public void NestedScopeWithReturn_ReturnsValue_AndVerifies()
    {
        var source = """
            package Probe1615c

            func f() int32 {
                scope {
                    scope {
                        return 42
                    }
                }
            }

            func Main() {
                System.Console.WriteLine(f())
            }
            """;

        var output = CompileAndRun(source, "1615c");
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void ScopeInsideTry_ReturnFromScope_RunsFinally_AndVerifies()
    {
        var source = """
            package Probe1615d

            func f() int32 {
                try {
                    scope {
                        return 7
                    }
                } finally {
                    System.Console.WriteLine("finally")
                }
            }

            func Main() {
                System.Console.WriteLine(f())
            }
            """;

        var output = CompileAndRun(source, "1615d");
        Assert.Equal("finally\n7\n", output);
    }

    private static string CompileAndRun(string source, string tag)
    {
        var tempDir = Directory.CreateTempSubdirectory($"gs_{tag}_exe_").FullName;
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
