// <copyright file="Issue1302EnumeratorInterfaceUserElementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1302: converting a constructed BCL value struct
/// (<c>List[T].Enumerator</c>) to its generic interface
/// (<c>IEnumerator[T]</c>) failed with GS0155 when the element type <c>T</c>
/// was a same-compilation user type, because the implemented-interface set was
/// compared against the target by erased CLR identity (a user element symbol
/// has a null <c>ClrType</c> during binding) instead of structurally over the
/// substituted element type. These tests pin the fix end-to-end: each returns
/// <c>list.GetEnumerator()</c> as an <c>IEnumerator[UserStruct]</c>, then drives
/// the converted enumerator at runtime and asserts the number of elements it
/// yields — proving the boxing conversion both binds AND emits a runtime-correct
/// enumerator. A <c>List[int32]</c> control guards the primitive path.
/// </summary>
public class Issue1302EnumeratorInterfaceUserElementEmitTests
{
    private static readonly string[] InitOnlyStructLiteral = { "InitOnly" };

    [Fact]
    public void StructElementList_EnumeratorToInterface_Iterates()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            struct Ch { prop V int32 { get; init; } }

            func F(l List[Ch]) IEnumerator[Ch] { return l.GetEnumerator() }

            var l = List[Ch]()
            l.Add(Ch{V: 5})
            l.Add(Ch{V: 7})
            l.Add(Ch{V: 9})
            var e = F(l)
            var n = 0
            while e.MoveNext() {
                n = n + 1
            }
            Console.WriteLine(n)
            """;

        Assert.Equal("3\n", CompileAndRun(source, InitOnlyStructLiteral));
    }

    [Fact]
    public void ClassElementList_EnumeratorToInterface_Iterates()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Seg { public var X int32 = 0 }

            func F(l List[Seg]) IEnumerator[Seg] { return l.GetEnumerator() }

            var a = Seg()
            var b = Seg()
            var l = List[Seg]()
            l.Add(a)
            l.Add(b)
            var e = F(l)
            var n = 0
            while e.MoveNext() {
                n = n + 1
            }
            Console.WriteLine(n)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void DataStructElementList_EnumeratorToInterface_Iterates()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            data struct Point { var X int32
                                var Y int32 }

            func F(l List[Point]) IEnumerator[Point] { return l.GetEnumerator() }

            var l = List[Point]()
            l.Add(Point{X: 1, Y: 2})
            l.Add(Point{X: 3, Y: 4})
            l.Add(Point{X: 5, Y: 6})
            l.Add(Point{X: 7, Y: 8})
            var e = F(l)
            var n = 0
            while e.MoveNext() {
                n = n + 1
            }
            Console.WriteLine(n)
            """;

        Assert.Equal("4\n", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveElementList_EnumeratorToInterface_StillWorks()
    {
        // Regression control: the primitive (List[int32]) path is unchanged.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func F(l List[int32]) IEnumerator[int32] { return l.GetEnumerator() }

            var l = List[int32]()
            l.Add(1)
            l.Add(2)
            l.Add(3)
            var e = F(l)
            var sum = 0
            while e.MoveNext() {
                sum = sum + e.Current
            }
            Console.WriteLine(sum)
            """;

        Assert.Equal("6\n", CompileAndRun(source));
    }

    // The struct case prints the iteration count over a three-element list,
    // proving the converted IEnumerator[Ch] yields every element at runtime.
    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1302_").FullName;
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
