// <copyright file="Issue1507SliceUntypedLambdaLinqEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1507 — target-typed inference of an UNTYPED arrow-lambda parameter
/// (<c>(i) -&gt; …</c>) for a LINQ / imported extension method must work when the
/// receiver is a G# slice (<c>[]T</c>) or array (<c>[N]T</c>), matching the
/// existing <c>List[T]</c> behaviour. Before the fix the untyped lambda over a
/// slice/array receiver failed to bind (GS0159/GS0304/GS0158). These end-to-end
/// tests pin the fix at runtime: each compiles a program that runs an untyped
/// LINQ lambda over a slice/array receiver, verifies the produced IL, executes
/// it, and asserts the result.
/// <para>
/// Every type / func / package name is globally unique across the test class
/// because the process-wide <c>FunctionTypeSymbol</c> cache is not cleared
/// between in-process compilations — a reused name would alias a stale delegate
/// element symbol from another test.
/// </para>
/// </summary>
public class Issue1507SliceUntypedLambdaLinqEmitTests
{
    [Fact]
    public void Slice_UserStruct_UntypedWhereCount_Runs()
    {
        var source = """
            package P1507WhereCount
            import System
            import System.Linq

            data struct Item1507WhereCount { var V int32 }

            func Filtered(xs []Item1507WhereCount) int32 -> xs.Where((i) -> i.V > 0).Count()

            let xs []Item1507WhereCount = []Item1507WhereCount{ Item1507WhereCount{V: 1}, Item1507WhereCount{V: -2}, Item1507WhereCount{V: 3} }
            Console.WriteLine(Filtered(xs))
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_UserStruct_UntypedSelectSum_Runs()
    {
        var source = """
            package P1507SelectSum
            import System
            import System.Linq

            data struct Item1507SelectSum { var V int32 }

            func Total(xs []Item1507SelectSum) int32 -> xs.Select((i) -> i.V).Sum()

            let xs []Item1507SelectSum = []Item1507SelectSum{ Item1507SelectSum{V: 1}, Item1507SelectSum{V: -2}, Item1507SelectSum{V: 3} }
            Console.WriteLine(Total(xs))
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_UserStruct_ChainedWhereWhereCount_Runs()
    {
        var source = """
            package P1507Chain
            import System
            import System.Linq

            data struct Item1507Chain { var V int32 }

            func Narrowed(xs []Item1507Chain) int32 -> xs.Where((i) -> i.V > 0).Where((i) -> i.V < 3).Count()

            let xs []Item1507Chain = []Item1507Chain{ Item1507Chain{V: 1}, Item1507Chain{V: 2}, Item1507Chain{V: 3}, Item1507Chain{V: -4} }
            Console.WriteLine(Narrowed(xs))
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_UserStruct_SelectThenWhereSum_Runs()
    {
        var source = """
            package P1507SelectWhere
            import System
            import System.Linq

            data struct Item1507SelectWhere { var V int32 }

            func Combo(xs []Item1507SelectWhere) int32 -> xs.Select((i) -> i.V).Where((v) -> v > 1).Sum()

            let xs []Item1507SelectWhere = []Item1507SelectWhere{ Item1507SelectWhere{V: 1}, Item1507SelectWhere{V: 2}, Item1507SelectWhere{V: 3} }
            Console.WriteLine(Combo(xs))
            """;

        Assert.Equal("5\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_PrimitiveInt32_UntypedWhereCount_Runs()
    {
        var source = """
            package P1507PrimWhere
            import System
            import System.Linq

            func Positives(xs []int32) int32 -> xs.Where((i) -> i > 0).Count()

            let xs []int32 = []int32{ 5, -1, 3, 8, -7 }
            Console.WriteLine(Positives(xs))
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void Slice_PrimitiveString_UntypedOrderByFirst_Runs()
    {
        var source = """
            package P1507PrimStr
            import System
            import System.Linq

            func Shortest(xs []string) string -> xs.OrderBy((s) -> s.Length).First()

            let xs []string = []string{ "apple", "kiwi", "fig" }
            Console.WriteLine(Shortest(xs))
            """;

        Assert.Equal("fig\n", CompileAndRun(source));
    }

    [Fact]
    public void Array_UserStruct_UntypedWhereSelectSum_Runs()
    {
        var source = """
            package P1507ArrWhere
            import System
            import System.Linq

            data struct Item1507ArrWhere { var V int32 }

            func Positive(xs [3]Item1507ArrWhere) int32 -> xs.Where((i) -> i.V > 0).Select((i) -> i.V).Sum()

            let xs [3]Item1507ArrWhere = [3]Item1507ArrWhere{ Item1507ArrWhere{V: 10}, Item1507ArrWhere{V: 20}, Item1507ArrWhere{V: -5} }
            Console.WriteLine(Positive(xs))
            """;

        Assert.Equal("30\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1507_").FullName;
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

            IlVerifier.Verify(outPath, ignoredErrorCodes: ignoredIlErrorCodes);

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
