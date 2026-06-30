// <copyright file="Issue1457UserTypeDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1457 — a <c>func</c> literal / lambda whose signature mentions a
/// same-compilation user type (especially a user value type such as a
/// <c>data struct</c>) was realised with the wrong delegate type. A LINQ
/// <c>Sum&lt;TSource&gt;(IEnumerable&lt;TSource&gt;, Func&lt;TSource,long&gt;)</c>
/// bound with <c>TSource = SampleEntry</c> emitted <c>Func&lt;object,int64&gt;</c>
/// instead of <c>Func&lt;SampleEntry,int64&gt;</c>, forcing an unverifiable
/// <c>object -&gt; SampleEntry</c> unbox (GS9998) — or, after a naive unbox patch,
/// an ilverify <c>StackUnexpected</c> + runtime segfault. The fix preserves the
/// same-compilation user type in the erased-adapter slots so the delegate reifies
/// through the <c>Func`N</c>/<c>Action`N</c> TypeSpec path (ADR-0087 §3 R6),
/// matching the reified generic call site.
/// </summary>
public class Issue1457UserTypeDelegateEmitTests
{
    [Fact]
    public void EndToEnd_SumOverUserValueTypeSelector_Runs()
    {
        var source = """
            package Probe1457a
            import System
            import System.Linq
            import System.Collections.Generic

            data struct SampleEntryA(FrameCount uint32, FrameDelta uint32)

            func Main() {
                let lst = List[SampleEntryA]()
                lst.Add(SampleEntryA(1, 2))
                let s = uint32(lst.Sum((e SampleEntryA) -> e.FrameCount))
                Console.WriteLine(s)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_WhereAndSelectOverUserValueType_Runs()
    {
        var source = """
            package Probe1457b
            import System
            import System.Linq
            import System.Collections.Generic

            data struct EntryB(Id uint32, Name string)

            func Main() {
                let lst = List[EntryB]()
                lst.Add(EntryB(1, "alpha"))
                lst.Add(EntryB(2, "beta"))
                let filtered = lst.Where((e EntryB) -> e.Id > 1u).ToList()
                Console.WriteLine(filtered.Count)
                let names = lst.Select((e EntryB) -> e.Name).ToList()
                Console.WriteLine(names[0])
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nalpha\n", output);
    }

    [Fact]
    public void EndToEnd_SumOverUserReferenceType_Runs()
    {
        var source = """
            package Probe1457c
            import System
            import System.Linq
            import System.Collections.Generic

            class WidgetC {
                var Cost int32
                init(c int32) { this.Cost = c }
            }

            func Main() {
                let widgets = List[WidgetC]()
                widgets.Add(WidgetC(10))
                widgets.Add(WidgetC(20))
                let total = widgets.Sum((w WidgetC) -> w.Cost)
                Console.WriteLine(total)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("30\n", output);
    }

    [Fact]
    public void EndToEnd_FuncLiteralStoredInVariableThenInvoked_Runs()
    {
        var source = """
            package Probe1457d
            import System

            data struct PointD(X int32, Y int32)

            func Main() {
                let f = (p PointD) -> p.X + p.Y
                Console.WriteLine(f(PointD(3, 4)))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("7\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1457_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

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
