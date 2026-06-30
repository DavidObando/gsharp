// <copyright file="Issue1451OutVarInLambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1451 — an inline <c>out var x</c> declared *inside* a lambda / `func`
/// literal body crashed emit with GS9998 "Variable 'x' has no local slot or
/// parameter index in the current method." The out-var binds to
/// <c>BoundAddressOfExpression(BoundVariableExpression(local))</c> (not a
/// BoundVariableDeclaration), and loop lowering emits the loop body before the
/// declaring condition, so the lambda's capture analysis misclassified the
/// out-var as an enclosing-scope capture and boxed it, desynchronizing it from
/// its emit local slot. The fix pre-seeds the lambda capture collector with every
/// inline out-var declared in the body. The same out-var in a non-lambda function
/// always worked (the control).
/// </summary>
public class Issue1451OutVarInLambdaEmitTests
{
    [Fact]
    public void EndToEnd_OutVarInWhileConditionInsideLambda_Runs()
    {
        var source = """
            package Probe1451a
            import System

            open class Counter {
                private var n int32
                init() { this.n = 3 }
                func TryNext(out v int32) bool {
                    if this.n <= 0 {
                        v = 0
                        return false
                    }
                    v = this.n
                    this.n = this.n - 1
                    return true
                }
            }

            func MakeSummer() (int32) -> int32 {
                let c = Counter()
                let sum = func (seed int32) int32 {
                    var total = seed
                    while c.TryNext(out var x) {
                        total = total + x
                    }
                    return total
                }
                return sum
            }

            func Main() {
                let s = MakeSummer()
                Console.WriteLine(s(100))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("106\n", output);
    }

    [Fact]
    public void EndToEnd_OutVarStraightLineInsideLambda_Runs()
    {
        var source = """
            package Probe1451b
            import System

            open class Box {
                func TryGet(out v int32) bool {
                    v = 41
                    return true
                }
            }

            func MakeReader() () -> int32 {
                let b = Box()
                let read = func () int32 {
                    if b.TryGet(out var got) {
                        return got + 1
                    }
                    return -1
                }
                return read
            }

            func Main() {
                let r = MakeReader()
                Console.WriteLine(r())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1451_exe_").FullName;
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
