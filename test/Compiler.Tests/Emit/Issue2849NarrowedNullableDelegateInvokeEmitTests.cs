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
            struct Pt { var X int32 }

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

                let writePt System.Action[Pt] = (p Pt) -> System.Console.WriteLine(p.X)
                var ptAction System.Action[Pt]? = writePt
                if ptAction != nil {
                    var q Pt
                    q.X = 5
                    ptAction(q)
                }

                let readPt System.Func[Pt,int32] = (p Pt) -> p.X + 1
                var ptFunc System.Func[Pt,int32]? = readPt
                if ptFunc != nil {
                    var q Pt
                    q.X = 6
                    System.Console.WriteLine(ptFunc(q))
                }
            }
            """;

        Assert.Equal($"2{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}1{Environment.NewLine}5{Environment.NewLine}7{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_SameCompilationNamedDelegate_VerifiesAndRuns()
    {
        const string source = """
            package i2849namedsame
            import System

            class Src { prop N int32 -> 21 }
            delegate Handler[T](value T) void;

            func Main() {
                let write Handler[Src] = (s Src) -> System.Console.WriteLine(s.N)
                var handler Handler[Src]? = write
                if handler != nil {
                    handler(Src())
                }
            }
            """;

        Assert.Equal($"21{Environment.NewLine}", CompileAndRun(source));
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

        Assert.Equal($"22{Environment.NewLine}22{Environment.NewLine}22{Environment.NewLine}22{Environment.NewLine}22{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_IsNarrowedImportedDelegate_VerifiesAndRuns()
    {
        const string source = """
            package i2849isnarrowed
            import System

            class Src { prop N int32 -> 8 }

            func Run(value object) {
                if value is System.Action[Src] {
                    value(Src())
                }
            }

            func Main() {
                let write System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)
                Run(write)
            }
            """;

        Assert.Equal($"8{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_QualifiedStableMemberPath_VerifiesAndRuns()
    {
        const string source = """
            package i2849qualified
            import System

            class Src { prop N int32 -> 7 }

            class Inner {
                let H System.Action[Src]?
                init(h System.Action[Src]?) { H = h }
            }

            class Outer {
                let B Inner
                init(b Inner) { B = b }
            }

            func Main() {
                let write System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)
                let outer = Outer(Inner(write))
                if outer.B.H != nil {
                    outer.B.H(Src())
                }
            }
            """;

        Assert.Equal($"7{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_CrossAssemblyImportedAndNamedDelegates_VerifyAndRun()
    {
        const string library = """
            package i2849matrixlib
            import System

            delegate Handler[T](value T) void;

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

        Assert.Equal($"23{Environment.NewLine}24{Environment.NewLine}", CompileAndRun(consumer, library, "i2849matrixlib"));
    }

    [Fact]
    public void EndToEnd_CrossAssemblyNamedDelegateWithConsumerSourceType_VerifiesAndRuns()
    {
        const string library = """
            package i2849lib2

            delegate Handler[T](value T) void;
            """;

        const string consumer = """
            package i2849use2
            import System
            import i2849lib2

            class Src { prop N int32 -> 9 }

            func Main() {
                let handler Handler[Src] = (s Src) -> System.Console.WriteLine(s.N)
                var optional Handler[Src]? = handler
                if optional != nil {
                    optional(Src())
                }
            }
            """;

        Assert.Equal($"9{Environment.NewLine}", CompileAndRun(consumer, library, "i2849lib2"));
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
