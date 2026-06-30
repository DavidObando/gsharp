// <copyright file="Issue1467GenericEncodingResidualEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1467 — residual cases where the enclosing CLASS generic type-parameter
/// was encoded with a named element-kind (<c>T0</c>) instead of the ordinal class
/// variable (<c>ELEMENT_TYPE_VAR !index</c>) in signature contexts that #1466
/// missed. The three shapes mirror the Oahu.Decrypt
/// <c>FrameFilterBase`1</c>/<c>FrameTransformBase`2</c> ilverify failures:
/// <list type="bullet">
/// <item>Facet A — an array of the class type-parameter (<c>T[]</c>) used as a
/// member of a NESTED generic type and constructed inside an <c>async</c> method,
/// where the array element token / nested-type member signatures must encode
/// <c>!0[]</c>.</item>
/// <item>Facet B — <c>base.Dispose(disposing)</c> reaching a generic base from a
/// non-generic derived leaf through several non-generic intermediates, where the
/// MemberRef declaring type must be the CONSTRUCTED base instantiation, not the
/// open <c>FrameFilterBase`1&lt;!0&gt;</c>.</item>
/// <item>Facet C — an arity-2 state machine capturing the type-parameters across
/// an <c>await</c>, with a <c>Task.Run(InstanceMethod)</c> delegate, an
/// <c>is</c>/<c>as</c> over an unconstrained type-parameter, and a
/// <c>base.M()</c> async call — all of which must encode the <c>this</c>/builder/
/// delegate-target/base-call entities with ordinal class variables.</item>
/// </list>
/// All three failed ilverify on current main and pass after the fix.
/// </summary>
public class Issue1467GenericEncodingResidualEmitTests
{
    [Fact]
    public void EndToEnd_FacetA_GenericArrayFieldInNestedTypeWithinAsync_Runs()
    {
        var source = """
            package Probe1467a
            import System
            import System.Threading.Tasks

            open class BufferHolderA[T] {
                var buffer []T
                var pos int32 = 0

                func Init() {
                    buffer = [4]T
                }

                open async func AddInputAsync(input T) {
                    buffer[pos] = input
                    pos = pos + 1
                    await Task.CompletedTask
                    var e = Entry(pos, buffer)
                    buffer = [4]T
                    Console.WriteLine(e.Count)
                }

                data struct Entry(Count int32, Items []T) { }
            }

            func Main() {
                var g = BufferHolderA[int32]()
                g.Init()
                g.AddInputAsync(7).Wait()
                Console.WriteLine("okA")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\nokA\n", output);
    }

    [Fact]
    public void EndToEnd_FacetB_BaseDisposeThroughNonGenericLeafChain_Runs()
    {
        var source = """
            package Probe1467b
            import System

            open class FilterBaseB[T] {
                protected var Disposed bool = false
                protected open func Dispose(disposing bool) {
                    Disposed = true
                }
            }
            open class TransformBaseB[TIn, TOut] : FilterBaseB[TIn] {
                protected open override func Dispose(disposing bool) {
                    if disposing && !Disposed {
                        Console.WriteLine("transform dispose")
                    }
                    base.Dispose(disposing)
                }
            }
            open class ValidateFilterB : TransformBaseB[int32, int32] {
            }
            class LeafFilterB : ValidateFilterB {
                override func Dispose(disposing bool) {
                    if disposing && !Disposed {
                        Console.WriteLine("leaf dispose")
                    }
                    base.Dispose(disposing)
                }
            }
            func Main() {
                var f = LeafFilterB()
                f.Dispose(true)
                Console.WriteLine("okB")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("leaf dispose\ntransform dispose\nokB\n", output);
    }

    [Fact]
    public void EndToEnd_FacetC_Arity2StateMachineDelegateAndBaseCall_Runs()
    {
        var source = """
            package Probe1467c

            import System
            import System.Threading
            import System.Threading.Tasks

            open class FilterC[TInput]() {
                private var filterLoop Task?
                private var cancellationToken CancellationToken

                open async func AddInputAsync(input TInput) {
                    filterLoop ??= Task.Run(Encoder, cancellationToken)
                    await Task.CompletedTask
                }

                protected open func FlushAsync() Task;
                protected open func HandleInputDataAsync(input TInput) Task;

                protected open async func CompleteInternalAsync() {
                    await Task.CompletedTask
                    if filterLoop != nil {
                        await filterLoop
                    }
                }

                private async func Encoder() {
                    await FlushAsync()
                }
            }

            open class TransformC[TInput, TOutput] : FilterC[TInput] {
                private var linked FilterC[TOutput]?

                func LinkTo(nextFilter FilterC[TOutput]) -> linked = nextFilter
                protected open func PerformFinalFiltering() TOutput? -> default

                protected override async func FlushAsync() {
                    if PerformFinalFiltering() is TOutput && linked != nil {
                        await linked!!.AddInputAsync((PerformFinalFiltering() as TOutput)!!)
                    }
                }

                protected override async func HandleInputDataAsync(input TInput) {
                    await Task.CompletedTask
                }

                protected override async func CompleteInternalAsync() {
                    await base.CompleteInternalAsync()
                }

                open async func RunAsync() {
                    await CompleteInternalAsync()
                }
            }

            func Main() {
                var t = TransformC[int32, int32]()
                t.RunAsync().Wait()
                Console.WriteLine("okC")
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("okC\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1467_exe_").FullName;
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
