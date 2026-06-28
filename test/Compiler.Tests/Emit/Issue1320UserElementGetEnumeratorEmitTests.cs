// <copyright file="Issue1320UserElementGetEnumeratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1320: <c>GetEnumerator()</c> on a <c>sequence[UserType]</c> (an
/// iterator return type, alias for <c>IEnumerable&lt;UserType&gt;</c>) failed to
/// bind with GS0159, while it resolved for a primitive element and for an
/// explicitly-typed <c>IEnumerable[UserType]</c>. These end-to-end tests pin the
/// fix at runtime: each drives the bridged <c>SeqUser().GetEnumerator()</c> via
/// <c>MoveNext()</c> / <c>Current</c> and asserts the user values it yields,
/// proving the generic <c>IEnumerator[UserType]</c> overload both binds AND emits
/// a runtime-correct enumerator. A <c>sequence[int32]</c> control guards the
/// primitive path.
/// </summary>
public class Issue1320UserElementGetEnumeratorEmitTests
{
    [Fact]
    public void StructSequence_GetEnumerator_YieldsUserValues()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            struct E { var X int32 }

            func SeqUser() sequence[E] {
                yield E{X: 10}
                yield E{X: 20}
                yield E{X: 30}
            }

            func Sum() int32 {
                var e = SeqUser().GetEnumerator()
                var sum = 0
                while e.MoveNext() {
                    sum = sum + e.Current.X
                }
                return sum
            }

            Console.WriteLine(Sum())
            """;

        Assert.Equal("60\n", CompileAndRun(source));
    }

    [Fact]
    public void ClassSequence_GetEnumerator_YieldsUserValues()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Seg { public var X int32 = 0 }

            func MakeSeg(v int32) Seg {
                var s = Seg()
                s.X = v
                return s
            }

            func SeqUser() sequence[Seg] {
                yield MakeSeg(1)
                yield MakeSeg(2)
            }

            func Count() int32 {
                var e = SeqUser().GetEnumerator()
                var n = 0
                while e.MoveNext() {
                    n = n + e.Current.X
                }
                return n
            }

            Console.WriteLine(Count())
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveSequence_GetEnumerator_StillWorks()
    {
        // Regression control: the primitive (sequence[int32]) path is unchanged.
        var source = """
            package P
            import System
            import System.Collections.Generic

            func SeqPrim() sequence[int32] {
                yield 1
                yield 2
                yield 3
            }

            func Sum() int32 {
                var e = SeqPrim().GetEnumerator()
                var sum = 0
                while e.MoveNext() {
                    sum = sum + e.Current
                }
                return sum
            }

            Console.WriteLine(Sum())
            """;

        Assert.Equal("6\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1320_").FullName;
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
