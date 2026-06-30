// <copyright file="Issue1469LambdaHostAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1469 — a non-capturing (zero-capture) lambda was hoisted to a static
/// method on the top-level <c>&lt;Program&gt;</c> host type. When such a lambda
/// reads a <c>protected</c>/<c>private</c> member of its parameter's type (a
/// positional member of a <c>protected</c> nested data class, or a private
/// backing field), the emitted <c>ldfld</c>/<c>call</c> falls outside that
/// member's accessibility domain — producing an unverifiable <c>FieldAccess</c>
/// IL site and a runtime <see cref="FieldAccessException"/>, even though gsc
/// reports zero errors. The fix routes such non-capturing lambdas through a
/// (fieldless) display class nested inside the lexically enclosing user type,
/// matching the #1335 capture-bearing nesting, so the lambda shares the
/// enclosing member's accessibility domain (as C# does with its <c>&lt;&gt;c</c>
/// display class).
/// <list type="bullet">
/// <item>Facet A — a non-capturing lambda over a positional member of a
/// <c>protected</c> nested <c>data class</c> (the Oahu.Decrypt
/// <c>ChunkReader.TrackEntry</c> shape).</item>
/// <item>Facet B — a non-capturing lambda reading a <c>private</c> backing field
/// of a non-public type.</item>
/// <item>Facet C — a non-capturing lambda whose enclosing type is GENERIC,
/// locking in that the generic-encloser fallback (top-level static placement)
/// still emits verifiable IL.</item>
/// </list>
/// </summary>
public class Issue1469LambdaHostAccessEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_NonCapturingLambdaOverProtectedNestedDataClassMember_Runs()
    {
        var source = """
            package Probe1469a
            import System
            import System.Linq
            import System.Collections.Generic

            open class ChunkReader1469A {
                protected let entries List[TrackEntry1469A] = List[TrackEntry1469A]()
                func AddOne() {
                    entries.Add(TrackEntry1469A(5, 1000))
                }
                func FirstId() uint32 {
                    return entries.Select((e TrackEntry1469A) -> e.TrackId).First()
                }
                protected open data class TrackEntry1469A(TrackId uint32, Timescale uint32) {
                }
            }

            func Main() {
                let r = ChunkReader1469A()
                r.AddOne()
                Console.WriteLine(r.FirstId())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("5\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_NonCapturingLambdaOverPrivateBackingField_Runs()
    {
        var source = """
            package Probe1469b
            import System
            import System.Linq
            import System.Collections.Generic

            class Box1469B {
                private let secret int32
                init(s int32) {
                    secret = s
                }
                func SumVia() int32 {
                    let items = List[Box1469B]()
                    items.Add(Box1469B(7))
                    items.Add(Box1469B(35))
                    return items.Select((b Box1469B) -> b.secret).Sum()
                }
            }

            func Main() {
                let x = Box1469B(0)
                Console.WriteLine(x.SumVia())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_NonCapturingLambdaInsideGenericEnclosingType_Runs()
    {
        var source = """
            package Probe1469c
            import System
            import System.Linq
            import System.Collections.Generic

            class GHolder1469C[T] {
                let nums List[int32] = List[int32]()
                func Seed() {
                    nums.Add(3)
                    nums.Add(4)
                }
                func Doubled() int32 {
                    return nums.Select((n int32) -> n * 2).Sum()
                }
            }

            func Main() {
                let g = GHolder1469C[string]()
                g.Seed()
                Console.WriteLine(g.Doubled())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("14\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1469_exe_").FullName;
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
