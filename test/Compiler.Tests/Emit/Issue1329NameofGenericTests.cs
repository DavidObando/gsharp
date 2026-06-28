// <copyright file="Issue1329NameofGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1329: <c>nameof(...)</c> accepts a constructed/generic type argument
/// and folds to the unqualified type name as a compile-time constant string,
/// with the type arguments dropped — matching C# (<c>nameof(List&lt;int&gt;)</c>
/// → <c>"List"</c>). These tests compile and run emitted programs and assert the
/// printed bare type names, covering:
/// <list type="bullet">
/// <item><description>a generic over a concrete type (<c>List[int32]</c>).</description></item>
/// <item><description>a generic over a type parameter (<c>IAppleData[TData]</c>).</description></item>
/// <item><description>a multi-argument generic (<c>Dictionary[string, int32]</c>).</description></item>
/// <item><description>a nested generic argument (<c>List[List[int32]]</c>).</description></item>
/// <item><description>regression: the bare-name and member-access forms still work.</description></item>
/// </list>
/// </summary>
public class Issue1329NameofGenericTests
{
    [Fact]
    public void GenericOverConcreteType_YieldsBareName()
    {
        var source = """
            package P
            import System

            class List[T] {}

            Console.WriteLine(nameof(List[int32]))
            """;

        Assert.Equal("List\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericOverTypeParameter_YieldsBareName()
    {
        var source = """
            package P
            import System

            interface IAppleData[TData] {}

            class C {
                func F[TData](x TData) string -> nameof(IAppleData[TData])
            }

            Console.WriteLine(C().F(5))
            """;

        Assert.Equal("IAppleData\n", CompileAndRun(source));
    }

    [Fact]
    public void MultiArgGeneric_YieldsBareName()
    {
        var source = """
            package P
            import System

            class Dictionary[K, V] {}

            Console.WriteLine(nameof(Dictionary[string, int32]))
            """;

        Assert.Equal("Dictionary\n", CompileAndRun(source));
    }

    [Fact]
    public void NestedGeneric_YieldsOuterBareName()
    {
        var source = """
            package P
            import System

            class List[T] {}

            Console.WriteLine(nameof(List[List[int32]]))
            """;

        Assert.Equal("List\n", CompileAndRun(source));
    }

    [Fact]
    public void BareNameAndMemberAccess_StillWork()
    {
        // Regression: the existing accepted forms (plain identifier and member
        // access) keep their behaviour alongside the new generic form.
        var source = """
            package P
            import System

            class List[T] {}

            Console.WriteLine(nameof(List))
            Console.WriteLine(nameof(Console.WriteLine))
            """;

        Assert.Equal("List\nWriteLine\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1329_emit_").FullName;
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
