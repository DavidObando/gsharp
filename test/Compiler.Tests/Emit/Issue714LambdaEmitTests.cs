// <copyright file="Issue714LambdaEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #714 / ADR-0074 — end-to-end CompileAndRun coverage for the new
/// arrow-lambda expression form. The lambda lowers into the existing
/// function-literal pipeline (closure capture, ldftn/newobj, Func/Action
/// constructor) so these tests exist primarily to catch any regression
/// in the parser/binder path that connects <c>LambdaExpressionSyntax</c>
/// to the established emit machinery.
/// </summary>
public class Issue714LambdaEmitTests
{
    [Fact]
    public void Lambda_TypedParameter_ExpressionBody_Roundtrips()
    {
        var source = """
            package P
            import System

            let inc = (x int32) -> x + 1
            Console.WriteLine(inc(41))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Lambda_BlockBody_TrailingExpressionIsResult()
    {
        var source = """
            package P
            import System

            let f = (x int32) -> {
              let y = x * 2
              y + 2
            }
            Console.WriteLine(f(20))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Lambda_CapturesOuterLocal_AndEmits()
    {
        var source = """
            package P
            import System

            let base = 40
            let add = (x int32) -> x + base
            Console.WriteLine(add(2))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void Lambda_VoidBody_EmitsAndRuns()
    {
        var source = """
            package P
            import System

            let print = (s string) -> Console.WriteLine(s)
            print("hi")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hi\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_lambda714_emit_").FullName;
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
