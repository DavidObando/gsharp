// <copyright file="TupleEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4.5 emit-parity tests for tuple literals and element access. Tuple
/// literals lower to <c>System.ValueTuple{...}</c> constructor calls (struct
/// newobj); element access (<c>t.ItemN</c>) lowers to <c>ldfld</c> on the
/// public ItemN field of the ValueTuple shape. Tuple arities 2–7 are covered;
/// higher arities have a null ClrType per TupleTypeSymbol.BuildClrType and
/// remain interpreter-only.
/// </summary>
public class TupleEmitTests
{
    [Fact]
    public void TupleLiteral_Arity2_ItemAccess()
    {
        var source = """
            package P
            import System

            var t = (1, "hi")
            Console.WriteLine(t.Item1)
            Console.WriteLine(t.Item2)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nhi\n", output);
    }

    [Fact]
    public void TupleLiteral_HeterogeneousArity3()
    {
        var source = """
            package P
            import System

            var t = (42, "answer", true)
            Console.WriteLine(t.Item1)
            Console.WriteLine(t.Item2)
            Console.WriteLine(t.Item3)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\nanswer\nTrue\n", output);
    }

    [Fact]
    public void TupleLiteral_Nested()
    {
        var source = """
            package P
            import System

            var t = (10, (20, 30))
            Console.WriteLine(t.Item1)
            Console.WriteLine(t.Item2.Item1)
            Console.WriteLine(t.Item2.Item2)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n30\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_tuple_emit_").FullName;
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
