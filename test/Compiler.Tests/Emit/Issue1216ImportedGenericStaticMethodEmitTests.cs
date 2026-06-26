// <copyright file="Issue1216ImportedGenericStaticMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1216: an explicit type argument on a call to an IMPORTED (CLR)
/// generic static method whose open return type <em>embeds</em> the method
/// type parameter — e.g. <c>GC.AllocateArray[T](n) → T[]</c> or
/// <c>Array.Empty[T]() → T[]</c> — must close the CLR method over the explicit
/// type argument and surface the substituted return type, including when the
/// type argument is a same-compilation user type (which is erased to
/// <c>object</c> in the reflection load context and recovered via the symbolic
/// projection). Before the fix the return type collapsed to the erased
/// <c>object[]</c> (GS0155). These tests round-trip gsc → PE → dotnet exec,
/// proving a correctly-instantiated <c>MethodSpec</c> is emitted.
/// </summary>
public class Issue1216ImportedGenericStaticMethodEmitTests
{
    [Fact]
    public void ImportedGenericStatic_AllocateArray_UserStructTypeArg()
    {
        var source = """
            package P
            import System

            struct Foo { var X int32 }

            func Make(n int32) []Foo { return GC.AllocateArray[Foo](n) }

            var a = Make(3)
            Console.WriteLine(a.Length)
            Console.WriteLine(a[1].X)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n0\n", output);
    }

    [Fact]
    public void ImportedGenericStatic_ArrayEmpty_UserStructTypeArg()
    {
        var source = """
            package P
            import System

            struct Foo { var X int32 }

            func Empty() []Foo { return Array.Empty[Foo]() }

            var a = Empty()
            Console.WriteLine(a.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n", output);
    }

    [Fact]
    public void ImportedGenericStatic_AllocateArray_PrimitiveTypeArg()
    {
        var source = """
            package P
            import System

            func Make(n int32) []int32 { return GC.AllocateArray[int32](n) }

            var a = Make(4)
            Console.WriteLine(a.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("4\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1216_").FullName;
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
