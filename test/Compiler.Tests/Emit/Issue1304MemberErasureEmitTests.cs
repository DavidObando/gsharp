// <copyright file="Issue1304MemberErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1304: accessing a property/member on a constructed BCL/generic type
/// instantiated over a same-compilation user type (e.g.
/// <c>IEnumerator[Ch].Current</c>) erased the member type to <c>object</c>
/// instead of substituting the user element <c>Ch</c>. These tests pin the fix
/// end-to-end: each enumerates a user-element collection and reads
/// <c>.Current.&lt;member&gt;</c>, summing the member values at runtime — proving
/// the member type both binds AND emits correctly over a user element. A
/// primitive-element control guards the unchanged path.
/// </summary>
public class Issue1304MemberErasureEmitTests
{
    private static readonly string[] InitOnlyStructLiteral = { "InitOnly" };

    [Fact]
    public void StructElementEnumerator_ReadCurrentMember_Sums()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            struct Ch { prop V int32 { get; init; } }

            func GetE(l List[Ch]) IEnumerator[Ch] { return l.GetEnumerator() }

            func SumV(e IEnumerator[Ch]) int32 {
                var total = 0
                while e.MoveNext() {
                    total = total + e.Current.V
                }
                return total
            }

            var l = List[Ch]()
            l.Add(Ch{V: 5})
            l.Add(Ch{V: 7})
            l.Add(Ch{V: 9})
            Console.WriteLine(SumV(GetE(l)))
            """;

        Assert.Equal("21\n", CompileAndRun(source, InitOnlyStructLiteral));
    }

    [Fact]
    public void StructElementEnumerator_ReturnCurrentElement_Roundtrips()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            struct Ch { prop V int32 { get; init; } }

            func GetE(l List[Ch]) IEnumerator[Ch] { return l.GetEnumerator() }

            func First(e IEnumerator[Ch]) Ch {
                e.MoveNext()
                return e.Current
            }

            var l = List[Ch]()
            l.Add(Ch{V: 42})
            l.Add(Ch{V: 7})
            var c = First(GetE(l))
            Console.WriteLine(c.V)
            """;

        Assert.Equal("42\n", CompileAndRun(source, InitOnlyStructLiteral));
    }

    [Fact]
    public void ClassElementEnumerator_ReadCurrentMember_Sums()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Seg { public var X int32 = 0 }

            func GetE(l List[Seg]) IEnumerator[Seg] { return l.GetEnumerator() }

            func SumX(e IEnumerator[Seg]) int32 {
                var total = 0
                while e.MoveNext() {
                    total = total + e.Current.X
                }
                return total
            }

            var a = Seg()
            a.X = 3
            var b = Seg()
            b.X = 4
            var l = List[Seg]()
            l.Add(a)
            l.Add(b)
            Console.WriteLine(SumX(GetE(l)))
            """;

        Assert.Equal("7\n", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveElementEnumerator_ReadCurrent_StillWorks()
    {
        // Regression control: the primitive (IEnumerator[int32]) path is
        // unchanged.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func GetE(l List[int32]) IEnumerator[int32] { return l.GetEnumerator() }

            func Sum(e IEnumerator[int32]) int32 {
                var total = 0
                while e.MoveNext() {
                    total = total + e.Current
                }
                return total
            }

            var l = List[int32]()
            l.Add(1)
            l.Add(2)
            l.Add(3)
            Console.WriteLine(Sum(GetE(l)))
            """;

        Assert.Equal("6\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1304_").FullName;
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
