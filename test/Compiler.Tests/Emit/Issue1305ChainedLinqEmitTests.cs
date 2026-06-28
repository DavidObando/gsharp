// <copyright file="Issue1305ChainedLinqEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1305: chaining an extension/LINQ method whose generic type parameter
/// is inferred from the receiver element type (e.g. <c>Where</c>'s
/// <c>TSource</c>) over a same-compilation user element produced a constructed
/// result whose backing <c>ClrType</c> surfaced the open method type parameter
/// rather than the type-erased closed shape, so the next chained call failed to
/// bind (GS0159). These tests pin the fix end-to-end: each builds a
/// user-element collection, chains <c>Where(...).Select(...)</c> (the second
/// call's <c>TSource</c>/receiver is the first call's result), and sums the
/// projected values at runtime — proving the chained calls both bind AND emit
/// correctly. A primitive-element control guards the unchanged path.
/// </summary>
public class Issue1305ChainedLinqEmitTests
{
    // Each struct-element test uses a distinct struct name (ChWs, ChCw). These
    // emit tests share one process and compile with no explicit /reference, so
    // the (host-keyed) FunctionTypeSymbol cache for `Func<TStruct, …>` selector
    // delegates is not torn down between compilations; a shared struct name
    // would alias a prior compilation's struct symbol into the next emit.
    private static readonly string[] InitOnlyStructLiteral = { "InitOnly" };

    [Fact]
    public void StructElement_WhereThenSelect_SumsKept()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            struct ChWs { prop V int32 { get; init; } }

            func SumKept(e IEnumerable[ChWs]) int32 {
                var total = 0
                var filtered = e.Where((c ChWs)->c.V>1).Select((c ChWs)->c.V)
                var en = filtered.GetEnumerator()
                while en.MoveNext() {
                    total = total + en.Current
                }
                return total
            }

            var l = List[ChWs]()
            l.Add(ChWs{V: 1})
            l.Add(ChWs{V: 5})
            l.Add(ChWs{V: 9})
            Console.WriteLine(SumKept(l))
            """;

        // Keeps V>1 → 5 + 9 = 14.
        Assert.Equal("14\n", CompileAndRun(source, InitOnlyStructLiteral));
    }

    [Fact]
    public void StructElement_ChainedWhere_CountsKept()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            struct ChCw { prop V int32 { get; init; } }

            func CountKept(e IEnumerable[ChCw]) int32 {
                var kept = e.Where((c ChCw)->c.V>0).Where((c ChCw)->c.V>3)
                var n = 0
                var en = kept.GetEnumerator()
                while en.MoveNext() {
                    n = n + 1
                }
                return n
            }

            var l = List[ChCw]()
            l.Add(ChCw{V: 1})
            l.Add(ChCw{V: 5})
            l.Add(ChCw{V: 9})
            Console.WriteLine(CountKept(l))
            """;

        // V>0 keeps all three; V>3 keeps 5 and 9 → 2.
        Assert.Equal("2\n", CompileAndRun(source, InitOnlyStructLiteral));
    }

    [Fact]
    public void PrimitiveElement_WhereThenSelect_StillRuns()
    {
        // Regression control: primitive element throughout was never affected.
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            func SumKept(e IEnumerable[int32]) int32 {
                var total = 0
                var filtered = e.Where((x int32)->x>1).Select((x int32)->x*2)
                var en = filtered.GetEnumerator()
                while en.MoveNext() {
                    total = total + en.Current
                }
                return total
            }

            var l = List[int32]()
            l.Add(1)
            l.Add(5)
            l.Add(9)
            Console.WriteLine(SumKept(l))
            """;

        // Keeps 5,9 then doubles → 10 + 18 = 28.
        Assert.Equal("28\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1305_").FullName;
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
