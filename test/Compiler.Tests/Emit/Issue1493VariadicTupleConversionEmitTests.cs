// <copyright file="Issue1493VariadicTupleConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1493 — when a value is passed as an element of a variadic
/// (<c>...T</c>) parameter, gsc must apply the same element-wise implicit
/// conversion (reference upcast, tuple-element conversion, interface
/// conversion, ...) that a fixed parameter of the element type would apply,
/// so the packed array element is built with the variadic ELEMENT type rather
/// than the argument's static (derived) type. Before the fix the packing path
/// either emitted invalid IL (ilverify <c>StackUnexpected</c>) or wrongly
/// rejected the call with GS0154. The facets below mirror the Oahu corpus:
/// <list type="bullet">
/// <item>Facet A — a tuple literal whose second element is a derived class is
/// passed to a multi-overload variadic <c>...(Track, FilterBase)</c>; the
/// derived element must be up-cast inside the packed <c>ValueTuple</c>.</item>
/// <item>Facet B — the single-overload manifestation, which previously failed
/// applicability with GS0154.</item>
/// <item>Facet C — a plain (non-tuple) derived element passed to a
/// <c>...FilterBase</c> variadic.</item>
/// <item>Facet D — a class implementing an interface passed to a
/// <c>...IFilter</c> variadic.</item>
/// </list>
/// All four ilverify clean and run after the fix.
/// </summary>
public class Issue1493VariadicTupleConversionEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_TupleElementUpcastMultipleOverloads_Runs()
    {
        var source = """
            package Probe1493a
            import System

            open class FilterBaseA[T] { init() { } }
            open class TransformBaseA[A, B] : FilterBaseA[A] { init() : base() { } }
            class TrackA { init() { } }

            class OpA {
                init() { }
                open func GetFilter() TransformBaseA[int32, int32] -> TransformBaseA[int32, int32]()
                open func Process(cont (int32) -> void, filters ...(TrackA, FilterBaseA[int32])) int32 -> filters.Length
                func Process[R](cont (int32) -> R, filters ...(TrackA, FilterBaseA[int32])) int32 -> filters.Length
                func Run() int32 {
                    let t = TrackA()
                    let filter1 = GetFilter()
                    let cont = func (x int32) { }
                    return Process(cont, (t, filter1))
                }
            }

            func Main() {
                Console.WriteLine(OpA().Run())
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_TupleElementUpcastSingleOverload_Runs()
    {
        var source = """
            package Probe1493b
            import System

            open class FilterBaseB[T] { init() { } }
            open class TransformBaseB[A, B] : FilterBaseB[A] { init() : base() { } }
            class TrackB { init() { } }

            func ProcessB(label int32, filters ...(TrackB, FilterBaseB[int32])) int32 -> filters.Length
            func GetFilterB() TransformBaseB[int32, int32] -> TransformBaseB[int32, int32]()

            func Main() {
                let t = TrackB()
                let f = GetFilterB()
                Console.WriteLine(ProcessB(1, (t, f)))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_NonTupleDerivedToBaseElement_Runs()
    {
        var source = """
            package Probe1493c
            import System

            open class FilterBaseC[T] { init() { } }
            open class TransformBaseC[A, B] : FilterBaseC[A] { init() : base() { } }

            func ProcessC(xs ...FilterBaseC[int32]) int32 -> xs.Length
            func GetFilterC() TransformBaseC[int32, int32] -> TransformBaseC[int32, int32]()

            func Main() {
                let f = GetFilterC()
                Console.WriteLine(ProcessC(f))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void EndToEnd_FacetD_DerivedToInterfaceElement_Runs()
    {
        var source = """
            package Probe1493d
            import System

            interface IFilterD { }
            open class FilterImplD : IFilterD { init() { } }

            func ProcessD(xs ...IFilterD) int32 -> xs.Length

            func Main() {
                let f = FilterImplD()
                Console.WriteLine(ProcessD(f))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1493_exe_").FullName;
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
