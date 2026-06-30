// <copyright file="Issue1475NullConditionalUserValueTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1475 — a null-conditional access <c>recv?.Member</c> whose result is a
/// value-type <c>Nullable&lt;T&gt;</c> where <c>T</c> is a user-declared value
/// type (enum or struct, with no runtime <c>ClrType</c>) previously emitted
/// <c>ldnull</c> for the receiver-null branch instead of
/// <c>default(Nullable&lt;T&gt;)</c>. That produced unverifiable IL
/// (<c>StackUnexpected</c>/<c>PathStackUnexpected</c>: "found Nullobjref,
/// expected value 'System.Nullable`1&lt;...&gt;'") and an
/// <c>InvalidProgramException</c> at runtime. BCL value-type underlyings
/// (e.g. <c>int32?</c>) already worked.
/// <list type="bullet">
/// <item>Facet A — <c>?.</c> yielding <c>Nullable&lt;user-enum&gt;</c>: the
/// minimal repro; null receiver then non-null.</item>
/// <item>Facet B — <c>?.</c> yielding <c>Nullable&lt;user-STRUCT&gt;</c>, proving
/// the fix generalises to struct underlyings, not just enums.</item>
/// <item>Facet C — chained <c>a?.b?.c</c> where the intermediate is already a
/// <c>Nullable&lt;userT&gt;</c> (ADR-0073 / #710): the not-null branch must NOT
/// double-wrap.</item>
/// </list>
/// Each test uses a UNIQUE package + user-type names because the in-process emit
/// tests share a process and a name-keyed type cache.
/// </summary>
public class Issue1475NullConditionalUserValueTypeEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_NullConditionalUserEnum_Runs()
    {
        var source = """
            package N1475A
            import System
            enum ColA1475 { Red; Green }
            class InnerA1475 {
                prop C ColA1475 { get; init; }
            }
            class BoxA1475 {
                var inner InnerA1475?
                prop ColorOpt ColA1475? -> inner?.C
            }
            func Main() {
                let b = BoxA1475()
                Console.WriteLine(b.ColorOpt == nil)
                b.inner = InnerA1475() { C = ColA1475.Green }
                Console.WriteLine(b.ColorOpt == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_NullConditionalUserStruct_Runs()
    {
        var source = """
            package N1475B
            import System
            struct PtB1475 {
                var X int32
                var Y int32
            }
            class InnerB1475 {
                prop P PtB1475 { get; init; }
            }
            class BoxB1475 {
                var inner InnerB1475?
                prop PointOpt PtB1475? -> inner?.P
            }
            func Main() {
                let b = BoxB1475()
                Console.WriteLine(b.PointOpt == nil)
                b.inner = InnerB1475() { P = PtB1475{X: 3, Y: 4} }
                Console.WriteLine(b.PointOpt == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_ChainedNullConditionalUserStruct_NoDoubleWrap_Runs()
    {
        var source = """
            package N1475C
            import System
            struct PtC1475 {
                var X int32
                var Y int32
            }
            class InnerC1475 {
                prop P PtC1475 { get; init; }
            }
            class MidC1475 {
                var inner InnerC1475?
                prop PointOpt PtC1475? -> inner?.P
            }
            class BoxC1475 {
                var mid MidC1475?
                prop Chained PtC1475? -> mid?.PointOpt
            }
            func Main() {
                let b = BoxC1475()
                Console.WriteLine(b.Chained == nil)
                let m = MidC1475()
                m.inner = InnerC1475() { P = PtC1475{X: 3, Y: 4} }
                b.mid = m
                Console.WriteLine(b.Chained == nil)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("True\nFalse\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1475_exe_").FullName;
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
