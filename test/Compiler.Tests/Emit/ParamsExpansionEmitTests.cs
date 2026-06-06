// <copyright file="ParamsExpansionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #506: C#-style <c>params T[]</c> expansion. Calls to CLR methods
/// whose final parameter is a <c>params</c> array must auto-collect trailing
/// positional arguments into a synthesised array when no fixed-arity overload
/// matches, while still honoring the normal form when a pre-built
/// <c>[]T{...}</c> is passed directly.
/// </summary>
public class ParamsExpansionEmitTests
{
    [Fact]
    public void PathCombine_SevenStringsExpandsToParamsStringArray()
    {
        // No fixed-arity Path.Combine overload accepts seven strings; this must
        // bind to Combine(params string[]) by packing the trailing args.
        var source = """
            package P
            import System
            import System.IO

            let combined = Path.Combine("a", "b", "..", "..", "src", "lib", "out.dll")
            Console.WriteLine(combined)
            """;

        var output = CompileAndRun(source);
        var expected = Path.Combine("a", "b", "..", "..", "src", "lib", "out.dll");
        Assert.Equal(expected + "\n", output);
    }

    [Fact]
    public void StringFormat_FourHolesExpandsToParamsObjectArray()
    {
        // String.Format(string, params object[]) — four object-typed trailing
        // args must pack into an object[] (each string element reference-converts
        // into the object element type).
        var source = """
            package P
            import System

            let s = String.Format("{0} {1} {2} {3}", "a", "b", "c", "d")
            Console.WriteLine(s)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a b c d\n", output);
    }

    [Fact]
    public void ConsoleWriteLine_FormatPlusFourTrailingArgs()
    {
        // Console.WriteLine has fixed overloads up to (string, object, object,
        // object); 4 trailing positional args force selection of the
        // (string, params object[]) overload and exercise expansion at a
        // void-returning CLR static. Strings reference-convert into the
        // object element slot so the test does not depend on value-type
        // boxing in callee-side parameter conversions.
        var source = """
            package P
            import System

            Console.WriteLine("{0}-{1}-{2}-{3}", "a", "b", "c", "d")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a-b-c-d\n", output);
    }

    [Fact]
    public void StringJoin_ZeroTrailingArgsAllocatesEmptyArray()
    {
        // String.Join(string, params string[]) with zero trailing args must
        // still bind in expanded form and allocate an empty array.
        var source = """
            package P
            import System

            let s = String.Join(",")
            Console.WriteLine("[" + s + "]")
            Console.WriteLine(s.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("[]\n0\n", output);
    }

    [Fact]
    public void PathCombine_PrebuiltStringSliceStillBindsNormalForm()
    {
        // Regression guard: passing an explicit []string slice as a single
        // argument must still bind via the normal (non-expanded) form.
        var source = """
            package P
            import System
            import System.IO

            let parts = []string{"a", "b", "..", "..", "src", "x.dll"}
            let combined = Path.Combine(parts)
            Console.WriteLine(combined)
            """;

        var output = CompileAndRun(source);
        var expected = Path.Combine(new[] { "a", "b", "..", "..", "src", "x.dll" });
        Assert.Equal(expected + "\n", output);
    }

    [Fact]
    public void StringConcat_PrebuiltObjectSliceBindsNormalFormOverloads()
    {
        // Regression guard: a fixed-arity Concat(string,string) overload must
        // still beat the expanded params form when arg count matches a fixed
        // overload.
        var source = """
            package P
            import System

            let s = String.Concat("hello", " world")
            Console.WriteLine(s)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello world\n", output);
    }

    [Fact]
    public void TaskWhenAll_ParamsTaskArrayExpansion()
    {
        // Task.WhenAll(params Task[]) with multiple trailing task args expands.
        var source = """
            package P
            import System
            import System.Threading.Tasks

            func makeTask(value int32) Task {
                return Task.CompletedTask
            }

            let t = Task.WhenAll(makeTask(1), makeTask(2), makeTask(3))
            t.Wait()
            Console.WriteLine("done")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("done\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_params_emit_").FullName;
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
