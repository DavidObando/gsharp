// <copyright file="Issue2849NarrowedNullableDelegateInvokeEmitTests.cs" company="GSharp">
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
/// Issue #2849 — a narrowed nullable imported generic delegate lost its
/// symbolic receiver type before emit, so <c>Invoke</c> was parented at the
/// erased <c>Action&lt;object&gt;</c> instead of the reified
/// <c>Action&lt;Src&gt;</c>.
/// </summary>
public class Issue2849NarrowedNullableDelegateInvokeEmitTests
{
    [Fact]
    public void EndToEnd_ImportedDelegateTruthTable_VerifiesAndRuns()
    {
        const string source = """
            package i2849truth
            import System

            class Src { prop N int32 -> 2 }

            func Main() {
                let f System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)

                var d System.Action[Src] = f
                d(Src())

                var n System.Action[Src]? = f
                if n != nil {
                    n(Src())
                }

                var workaround System.Action[Src]? = f
                if workaround != nil {
                    let invoke System.Action[Src] = workaround
                    invoke(Src())
                }

                var bcl System.Action[int32]? = (x int32) -> System.Console.WriteLine(x)
                if bcl != nil {
                    bcl(1)
                }
            }
            """;

        Assert.Equal("2\n2\n2\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_SameCompilationNamedDelegate_VerifiesAndRuns()
    {
        const string source = """
            package i2849namedsame
            import System

            class Src { prop N int32 -> 21 }
            type Handler[T] = delegate func(value T) void

            func Main() {
                let write Handler[Src] = (s Src) -> System.Console.WriteLine(s.N)
                var handler Handler[Src]? = write
                if handler != nil {
                    handler(Src())
                }
            }
            """;

        Assert.Equal("21\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_NarrowedImportedDelegateReceiverShapes_VerifyAndRun()
    {
        const string source = """
            package i2849shapes
            import System

            class Src { prop N int32 -> 22 }

            class Holder {
                let Field System.Action[Src]?
                prop Property System.Action[Src]? { get; init; }

                init(value System.Action[Src]?) {
                    Field = value
                    Property = value
                }

                func Run() {
                    if Field != nil {
                        Field(Src())
                    }
                    if Property != nil {
                        Property(Src())
                    }
                }
            }

            func InvokeParameter(handler System.Action[Src]?) {
                if handler != nil {
                    handler(Src())
                }
            }

            func Main() {
                let write System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)

                InvokeParameter(write)
                Holder(write).Run()

                var optional System.Action[Src]? = write
                if let narrowed = optional {
                    narrowed(Src())
                }

                (optional ?? write)(Src())
            }
            """;

        Assert.Equal("22\n22\n22\n22\n22\n", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_CrossAssemblyImportedAndNamedDelegates_VerifyAndRun()
    {
        const string library = """
            package i2849matrixlib
            import System

            type Handler[T] = delegate func(value T) void

            class ImportedRelay[T] {
                func Run(handler System.Action[T]?, value T) {
                    if handler != nil {
                        handler(value)
                    }
                }
            }

            class NamedRelay[T] {
                func Run(handler Handler[T]?, value T) {
                    if handler != nil {
                        handler(value)
                    }
                }
            }
            """;

        const string consumer = """
            package i2849matrixuse
            import System
            import i2849matrixlib

            class Src { prop N int32 -> 23 }

            func Main() {
                let imported System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)
                ImportedRelay[Src]().Run(imported, Src())

                let named Handler[Src] = (s Src) -> System.Console.WriteLine(s.N + 1)
                NamedRelay[Src]().Run(named, Src())
            }
            """;

        Assert.Equal("23\n24\n", CompileAndRun(consumer, library, "i2849matrixlib"));
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2849_exe_").FullName;
        try
        {
            string libDll = null;
            if (library != null)
            {
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

            return stdout.Replace("\r\n", "\n");
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
