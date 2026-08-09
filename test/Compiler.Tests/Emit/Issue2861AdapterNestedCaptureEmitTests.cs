// <copyright file="Issue2861AdapterNestedCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2861 — a lambda with an EXPLICIT parameter type that is converted to
/// a delegate whose slot type differs makes the binder synthesize an erased
/// parameter adapter (<c>LambdaBinder.CreateErasedFunctionLiteralAdapter</c>),
/// which rebinds every parameter onto a fresh <c>ParameterSymbol</c>.
/// <para>
/// <c>BoundTreeRewriter</c> treats a nested function literal as a leaf, so a
/// nested lambda kept reading — and kept listing in its
/// <c>CapturedVariables</c> — the ORIGINAL parameter symbol, which has no slot
/// in the adapter method. Emit then crashed with
/// <c>GS9998: Variable '…' has no local slot or parameter index in the current
/// method</c>.
/// </para>
/// <para>
/// These facts pin the runtime behaviour end to end: the nested closure must
/// observe the adapter's converted parameter value on every invocation.
/// </para>
/// </summary>
public class Issue2861AdapterNestedCaptureEmitTests
{
    [Fact]
    public void NestedLambdaCapturingWidenedAdapterParameter_Runs()
    {
        // Defect: `Action[string]` supplies a `string` slot while the literal
        // writes `object`, so an erased adapter is synthesized; the nested
        // lambda then captures the pre-adapter parameter symbol.
        const string source = """
            package i2861a
            import System

            func Main() {
                var log = ""
                let a Action[string] = (msg object) -> {
                    let g = () -> { log = "got:" + msg.ToString() }
                    g()
                }

                a("hello")
                Console.WriteLine(log)
            }
            """;

        Assert.Equal($"got:hello{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NestedLambdaCapturingAdapterParameter_ObservesEachInvocation()
    {
        // The converted local must be re-initialized per call, not hoisted
        // once: two invocations must accumulate two distinct values.
        const string source = """
            package i2861b
            import System
            import System.Collections.Generic

            func Main() {
                let seen = List[string]()
                let a Action[string] = (msg object) -> {
                    let g = () -> { seen.Add(msg.ToString()) }
                    g()
                }

                a("first")
                a("second")
                Console.WriteLine(string.Join(",", seen))
            }
            """;

        Assert.Equal($"first,second{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void DoublyNestedLambdaCapturingAdapterParameter_Runs()
    {
        // The substitution must reach transitively through TWO levels of
        // nesting, including the intermediate literal's capture list.
        const string source = """
            package i2861c
            import System

            func Main() {
                var log = ""
                let a Action[string] = (msg object) -> {
                    let outer = () -> {
                        let inner = () -> { log = "deep:" + msg.ToString() }
                        inner()
                    }

                    outer()
                }

                a("nested")
                Console.WriteLine(log)
            }
            """;

        Assert.Equal($"deep:nested{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NestedLambdaCapturingImportedDataClassParameter_Runs()
    {
        // The shape that blocked the Oahu migration: an imported `data class`
        // is materialized as a semantic-aggregate StructSymbol while the
        // delegate slot resolves to an ImportedTypeSymbol for the same CLR
        // type, so the binder believes a conversion is needed and synthesizes
        // an adapter for what is really an identity conversion.
        const string library = """
            package i2861lib

            data class Msg(IncItem int32?) {
            }
            """;

        const string source = """
            package i2861d
            import System
            import i2861lib

            func Main() {
                var total = 0
                let report Action[Msg] = (msg Msg) -> {
                    let apply = () -> {
                        if msg.IncItem != nil {
                            total += msg.IncItem!!
                        }
                    }

                    apply()
                }

                report(Msg(7))
                report(Msg(5))
                Console.WriteLine(total)
            }
            """;

        Assert.Equal($"12{Environment.NewLine}", CompileAndRun(source, library, "i2861lib"));
    }

    [Fact]
    public void NestedLambdaCapturingAdapterParameterAndEnclosingLocal_Runs()
    {
        // Mixed captures: the nested literal captures BOTH the re-homed
        // adapter parameter and a local from the enclosing method, so the
        // substitution must rewrite one entry of the capture list and leave
        // the other untouched.
        const string source = """
            package i2861e
            import System

            func Main() {
                let prefix = "p:"
                var log = ""
                let a Action[string] = (msg object) -> {
                    let g = () -> { log = prefix + msg.ToString() }
                    g()
                }

                a("value")
                Console.WriteLine(log)
            }
            """;

        Assert.Equal($"p:value{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void NestedLambdaInLoopCapturingAdapterParameter_Runs()
    {
        // A nested literal created inside a loop in the adapter body: each
        // iteration's closure must still bind to the adapter's converted
        // local rather than the erased pre-adapter parameter.
        const string source = """
            package i2861f
            import System
            import System.Collections.Generic

            func Main() {
                let seen = List[string]()
                let a Action[string] = (msg object) -> {
                    let indexes = List[int32]{ 0, 1 }
                    for i in indexes {
                        let g = () -> { seen.Add(msg.ToString() + i.ToString()) }
                        g()
                    }
                }

                a("x")
                Console.WriteLine(string.Join(",", seen))
            }
            """;

        Assert.Equal($"x0,x1{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void LambdaWithoutNesting_StillRunsThroughAdapter()
    {
        // Control: the non-nested adapter path must keep working unchanged.
        const string source = """
            package i2861ctrl
            import System

            func Main() {
                var log = ""
                let a Action[string] = (msg object) -> {
                    log = "flat:" + msg.ToString()
                }

                a("value")
                Console.WriteLine(log)
            }
            """;

        Assert.Equal($"flat:value{Environment.NewLine}", CompileAndRun(source));
    }


    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2861_exe_").FullName;
        try
        {
            string libDll = null;
            if (library != null)
            {
                // ilverify resolves `-r` references by FILE NAME, so the
                // library must be written out under its assembly identity.
                var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
                File.WriteAllText(libSrc, library);
                Compile(new[]
                {
                    "/out:" + libDll,
                    "/target:library",
                    "/targetframework:net10.0",
                    libSrc,
                });
                IlVerifier.Verify(libDll);
            }

            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            if (libDll != null)
            {
                args.Add("/r:" + libDll);
            }

            args.Add(srcPath);
            Compile(args.ToArray());
            IlVerifier.Verify(dllPath, libDll != null ? new[] { libDll } : null);

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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void Compile(string[] args)
    {
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
    }
}
