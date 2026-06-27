// <copyright file="Issue1274ConditionalImportedBaseUnifyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1274: end-to-end CLR emit coverage for unifying conditional /
/// if-expression arms to an imported/BCL base class. When one arm is an
/// imported base (e.g. <c>System.Exception</c>) and the other a user-defined
/// subclass — or when both arms are user subclasses of the same imported base —
/// the best-common-type is the imported base. The upcast must be a no-op
/// reference conversion, so the value flowing out of the conditional keeps its
/// concrete runtime type per the branch taken.
/// </summary>
public class Issue1274ConditionalImportedBaseUnifyEmitTests
{
    [Fact]
    public void EndToEnd_IfExpression_ImportedBaseVsUserSubclass_PreservesConcreteType()
    {
        var source = """
            package Probe
            import System

            open class MyEx : Exception { }

            func Pick(b bool, e Exception) Exception {
                return if b { e } else { MyEx() }
            }

            func Main() {
                let baseEx = Exception("base")
                Console.WriteLine(Pick(true, baseEx).GetType().Name)
                Console.WriteLine(Pick(false, baseEx).GetType().Name)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("Exception\nMyEx\n", output);
    }

    [Fact]
    public void EndToEnd_IfExpression_TwoUserSubclassesOfImportedBase_PreservesConcreteType()
    {
        var source = """
            package Probe
            import System

            open class MyExA : Exception { }
            open class MyExB : Exception { }

            func Pick(b bool) Exception {
                let a = MyExA()
                let b2 = MyExB()
                return if b { a } else { b2 }
            }

            func Main() {
                Console.WriteLine(Pick(true).GetType().Name)
                Console.WriteLine(Pick(false).GetType().Name)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("MyExA\nMyExB\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_cond1274_exe_").FullName;
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
