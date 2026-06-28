// <copyright file="Issue1316AssignmentTargetTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1316: end-to-end CLR emit coverage for an assignment whose RHS is a
/// target-typed conditional with a <c>nil</c> arm. A nullable property assigned
/// <c>if cond { nil } else { T(...) }</c> must thread the property's declared
/// type into the RHS binder so the <c>nil</c> arm unifies to <c>T?</c> (the same
/// adaptation a <c>let x T? = ...</c> initializer gets) and the assembly emits,
/// verifies, and runs — producing <c>nil</c> for the nil branch and a non-nil
/// value for the other branch.
/// </summary>
public class Issue1316AssignmentTargetTypeEmitTests
{
    [Fact]
    public void EndToEnd_NullablePropertyAssignment_BothBranches_RunCorrectly()
    {
        var source = """
            package Probe
            import System

            class AesCtr {
                init(k []uint8) {}
            }

            class C {
                init(key []uint8) {
                    A = if key.Length == 0 { nil } else { AesCtr(key) }
                }
                prop A AesCtr? { get; init; }
            }

            func Main() {
                var empty []uint8 = []uint8{ }
                var filled []uint8 = []uint8{ 1, 2, 3 }
                var c1 = C(empty)
                var c2 = C(filled)
                Console.WriteLine(c1.A == nil)
                Console.WriteLine(c2.A == nil)
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_NullableFieldAssignment_BothBranches_RunCorrectly()
    {
        var source = """
            package Probe
            import System

            class AesCtr {
                init(k []uint8) {}
            }

            class C {
                var f AesCtr?
                init(key []uint8) {
                    f = if key.Length == 0 { nil } else { AesCtr(key) }
                }
                func IsNil() bool { return f == nil }
            }

            func Main() {
                var empty []uint8 = []uint8{ }
                var filled []uint8 = []uint8{ 1, 2, 3 }
                Console.WriteLine(C(empty).IsNil())
                Console.WriteLine(C(filled).IsNil())
            }
            """;
        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_assign1316_exe_").FullName;
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
