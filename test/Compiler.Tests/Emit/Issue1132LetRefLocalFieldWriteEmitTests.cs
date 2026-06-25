// <copyright file="Issue1132LetRefLocalFieldWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1132: <c>let</c> communicates immutability of the BINDING (shallow,
/// like Kotlin <c>val</c> / a C# <c>readonly</c> reference), not of the heap
/// object the binding points at. For a reference-type (<c>class</c>/interface)
/// local, a field or property write through the binding
/// (<c>b.Field = x</c>, <c>b.Field += 1</c>, <c>b.Field++</c>) mutates the heap
/// object and must be allowed; only rebinding the local (<c>b = other</c>) is
/// blocked. These end-to-end tests prove the mutation is actually observed at
/// runtime after the fix removed the spurious GS0127.
/// </summary>
public class Issue1132LetRefLocalFieldWriteEmitTests
{
    [Fact]
    public void LetClassLocal_FieldWrite_MutationObserved()
    {
        var source = """
            package P
            import System

            class Box {
                var Value int32 = 0
            }

            func mutate() int32 {
                let b = Box{ }
                b.Value = 5
                return b.Value
            }

            Console.WriteLine(mutate())
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void LetClassLocal_CompoundFieldWrite_MutationObserved()
    {
        var source = """
            package P
            import System

            class Box {
                var Value int32 = 10
            }

            func mutate() int32 {
                let b = Box{ }
                b.Value += 3
                b.Value++
                return b.Value
            }

            Console.WriteLine(mutate())
            """;

        Assert.Equal("14\n", CompileAndRun(source));
    }

    [Fact]
    public void LetClassLocal_PropertyWrite_MutationObserved()
    {
        var source = """
            package P
            import System

            class Counter {
                public var Count int32 = 0
                public func Bump() {
                    let self = this
                    self.Count = self.Count + 1
                }
            }

            let c = Counter{ }
            c.Bump()
            c.Bump()
            Console.WriteLine(c.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1132_emit_").FullName;
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

            return stdout.Replace("\r\n", "\n");
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
