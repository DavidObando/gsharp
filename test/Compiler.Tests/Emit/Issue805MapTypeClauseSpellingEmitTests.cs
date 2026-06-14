// <copyright file="Issue805MapTypeClauseSpellingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #805 / ADR-0104 — end-to-end emit + ilverify coverage for the
/// canonical <c>map[K,V]</c> spelling. These tests are intentionally
/// minimal: the symbol-level emit path is unaffected by the
/// surface-syntax change, so what we are pinning down is that the
/// parser change has not broken IL emission or verifiability for the
/// canonical literal form across every type-clause slot the issue
/// names.
/// </summary>
public class Issue805MapTypeClauseSpellingEmitTests
{
    [Fact]
    public void CanonicalSpelling_InferredLocal_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            var m = map[string,int32]{"a": 1}
            Console.WriteLine(m["a"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void CanonicalSpelling_ExplicitTypedLocal_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            var m map[string,int32] = map[string,int32]{"a": 1, "b": 2}
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void CanonicalSpelling_FunctionReturnType_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            func makeIndex() map[string,int32] {
                return map[string,int32]{"a": 1, "b": 2}
            }

            var m = makeIndex()
            Console.WriteLine(m["a"])
            Console.WriteLine(m["b"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n2\n", output);
    }

    [Fact]
    public void CanonicalSpelling_FunctionParameterType_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            func first(m map[string,int32]) int32 {
                return m["a"]
            }

            var m = map[string,int32]{"a": 42}
            Console.WriteLine(first(m))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_map805_emit_").FullName;
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
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
