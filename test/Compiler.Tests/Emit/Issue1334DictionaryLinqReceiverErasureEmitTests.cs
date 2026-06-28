// <copyright file="Issue1334DictionaryLinqReceiverErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1334 (follow-up to #1328): a <c>Dictionary[K, V].Values</c> /
/// <c>.Keys</c> collection over a same-compilation user element, when used as the
/// RECEIVER of a LINQ operator (<c>.Select</c>, <c>.Where</c>), erased the
/// projected result element to <c>System.Object</c>, so a member access on the
/// loop variable failed <c>GS0159</c>. The fix recovers the symbolic
/// <c>TResult</c> from the explicitly-annotated projection lambda while the
/// receiver supplies <c>TSource</c>. These end-to-end tests pin the fix at
/// runtime: each builds a <c>Dictionary[uint32, E]</c>, runs the value collection
/// through a LINQ operator that projects to / preserves a user element, accesses
/// the user member, executes, and asserts the result. A primitive-projection
/// control guards the closed-CLR path that always worked.
/// </summary>
public class Issue1334DictionaryLinqReceiverErasureEmitTests
{
    [Fact]
    public void ValuesSelect_ProjectsUserType_ForIn_YieldsUserMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class FilterSel(Tag uint32) { func Go() uint32 -> Tag }
            data class EntrySel(FirstFilter FilterSel) {}

            func ViaSelect(d Dictionary[uint32, EntrySel]) uint32 {
                var sum uint32 = 0
                for f in d.Values.Select((e EntrySel) -> e.FirstFilter) { sum = sum + f.Go() }
                return sum
            }

            let d = Dictionary[uint32, EntrySel]()
            let k1 uint32 = 1
            let k2 uint32 = 2
            d.Add(k1, EntrySel(FilterSel(10)))
            d.Add(k2, EntrySel(FilterSel(20)))
            Console.WriteLine(ViaSelect(d))
            """;

        Assert.Equal("30\n", CompileAndRun(source));
    }

    [Fact]
    public void ValuesWhere_ForIn_YieldsUserMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class FilterWhr(Tag uint32) { func Go() uint32 -> Tag }
            data class EntryWhr(FirstFilter FilterWhr) {}

            func ViaWhere(d Dictionary[uint32, EntryWhr]) uint32 {
                var sum uint32 = 0
                for e in d.Values.Where((x EntryWhr) -> true) { sum = sum + e.FirstFilter.Go() }
                return sum
            }

            let d = Dictionary[uint32, EntryWhr]()
            let k1 uint32 = 1
            let k2 uint32 = 2
            d.Add(k1, EntryWhr(FilterWhr(10)))
            d.Add(k2, EntryWhr(FilterWhr(20)))
            Console.WriteLine(ViaWhere(d))
            """;

        Assert.Equal("30\n", CompileAndRun(source));
    }

    [Fact]
    public void ValuesWhereThenSelect_Chained_ForIn_YieldsUserMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class FilterChn(Tag uint32) { func Go() uint32 -> Tag }
            data class EntryChn(FirstFilter FilterChn) {}

            func Chained(d Dictionary[uint32, EntryChn]) uint32 {
                var sum uint32 = 0
                for f in d.Values.Where((x EntryChn) -> true).Select((e EntryChn) -> e.FirstFilter) { sum = sum + f.Go() }
                return sum
            }

            let d = Dictionary[uint32, EntryChn]()
            let k1 uint32 = 1
            let k2 uint32 = 2
            d.Add(k1, EntryChn(FilterChn(10)))
            d.Add(k2, EntryChn(FilterChn(20)))
            Console.WriteLine(Chained(d))
            """;

        Assert.Equal("30\n", CompileAndRun(source));
    }

    [Fact]
    public void ValuesSelect_ThenLinqTerminal_YieldsUserMember()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class FilterTrm(Tag uint32) { func Go() uint32 -> Tag }
            data class EntryTrm(FirstFilter FilterTrm) {}

            func SelectFirst(d Dictionary[uint32, EntryTrm]) uint32 -> d.Values.Select((e EntryTrm) -> e.FirstFilter).First().Go()

            let d = Dictionary[uint32, EntryTrm]()
            let k1 uint32 = 1
            d.Add(k1, EntryTrm(FilterTrm(42)))
            Console.WriteLine(SelectFirst(d))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void PrimitiveProjection_Control_StillWorks()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            data class EPrim(Value uint32) {}

            func SelectPrimitive(d Dictionary[uint32, EPrim]) uint32 {
                var sum uint32 = 0
                for v in d.Values.Select((e EPrim) -> e.Value) { sum = sum + v }
                return sum
            }

            let d = Dictionary[uint32, EPrim]()
            let k1 uint32 = 1
            let k2 uint32 = 2
            d.Add(k1, EPrim(5))
            d.Add(k2, EPrim(9))
            Console.WriteLine(SelectPrimitive(d))
            """;

        Assert.Equal("14\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string[] ignoredIlErrorCodes = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1334_").FullName;
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
