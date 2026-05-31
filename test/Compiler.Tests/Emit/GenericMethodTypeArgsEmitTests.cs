// <copyright file="GenericMethodTypeArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #311: invoking a generic method with an EXPLICIT type-argument list
/// (<c>Method[T](...)</c>) end-to-end (gsc → PE → dotnet exec). Covers the
/// forms that type inference cannot supply because the type argument itself is
/// the information being provided (e.g. <c>Array.Empty[T]()</c>,
/// <c>Enumerable.Empty[T]()</c>), single and multiple type arguments, and the
/// generic-extension-method-with-receiver form. All tests run under bare
/// <c>gsc /targetframework</c> (no explicit <c>/r:</c>), keeping them
/// independent of the cross-load-context concern tracked by #310.
/// </summary>
public class GenericMethodTypeArgsEmitTests
{
    [Fact]
    public void StaticGenericMethod_SingleExplicitTypeArg_ArrayEmpty()
    {
        var source = """
            package P
            import System

            var a = Array.Empty[string]()
            Console.WriteLine(a.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void StaticGenericMethod_SingleExplicitTypeArg_EnumerableEmpty()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            var e = Enumerable.Empty[int32]()
            Console.WriteLine(e.Count())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void StaticGenericMethod_MultipleExplicitTypeArgs_KeyValuePairCreate()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var pair = KeyValuePair.Create[string, int32]("answer", 42)
            Console.WriteLine(pair.Key)
            Console.WriteLine(pair.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("answer\n42\n", output);
    }

    [Fact]
    public void GenericExtensionMethod_ExplicitTypeArg_OnReceiver()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            var words = List[string]()
            words.Add("alpha")
            words.Add("beta")
            var wordArray = words.ToArray[string]()
            Console.WriteLine(wordArray.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void TypeInference_StillWorks_AlongsideExplicitForm()
    {
        var source = """
            package P
            import System
            import System.Linq

            var repeated = Enumerable.Repeat("x", 3)
            Console.WriteLine(repeated.Count())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_generic_method_typeargs_").FullName;
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
