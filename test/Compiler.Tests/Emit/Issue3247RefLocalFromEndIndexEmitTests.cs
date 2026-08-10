// <copyright file="Issue3247RefLocalFromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3247: a ref-aliasing local over an index-from-end element access
/// (<c>let ref r = xs[^1]</c>) ICEd the emitter with GS9998 because the
/// from-end lowering wraps the element access in a
/// <c>BoundBlockExpression</c> (receiver + offset spilled into temps) and the
/// address-of path could not see through the block wrapper. The binder now
/// sinks the address-of onto the trailing element access (mirroring the
/// <c>return ref</c> path), so the prefix runs once and the alias captures
/// the element via <c>ldelema</c>. This test compiles the canonical shapes
/// from the issue, gates the output through ILVerify, and runs it.
/// </summary>
public class Issue3247RefLocalFromEndIndexEmitTests
{
    [Fact]
    public void LetRef_FromEndIndex_CompilesRunsAndIlVerifies()
    {
        var source = """
            package P
            import System

            func probe() {
                var original = []int32{10, 20, 30}
                var current = original
                let ref r = current[^1]
                current = []int32{40, 50, 60}
                r = 99
                Console.WriteLine(r)
                Console.WriteLine("${original[0]},${original[1]},${original[2]}")
                Console.WriteLine("${current[0]},${current[1]},${current[2]}")
                var k int32 = 3
                var ref s = original[^k]
                s = s + 1
                Console.WriteLine(original[0])
            }

            probe()
            """;

        Assert.Equal($"99{Environment.NewLine}10,20,99{Environment.NewLine}40,50,60{Environment.NewLine}11{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue3247_emit_").FullName;
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
