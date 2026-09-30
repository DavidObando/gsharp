// <copyright file="Issue4559TransitiveInterfaceInferenceEmitTests.cs" company="GSharp">
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
/// Issue #4559 — generic inference must traverse interface inheritance even
/// when the referenced assembly was emitted by G#, whose InterfaceImpl rows
/// list only the DIRECT interfaces of a type. A library class declaring only
/// <c>IReadOnlyCollection[string]</c> has no row for the inherited
/// <c>IEnumerable[string]</c>, so the consumer's <c>First[T](IEnumerable[T])</c>
/// call could not infer <c>T</c>.
/// </summary>
public sealed class Issue4559TransitiveInterfaceInferenceEmitTests
{
    private const string GenericCollectionLibrary = """
        package i4559lib
        import System.Collections
        import System.Collections.Generic

        open class ProjectedCollection[TMarker] : IReadOnlyCollection[string] {
            private let items List[string]

            init() {
                items = List[string]()
                items.Add("projected")
            }

            prop Count int32 { get -> items.Count }

            func GetEnumerator() IEnumerator[string] -> items.GetEnumerator()
            private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
        }

        class DerivedProjectedCollection[TMarker] : ProjectedCollection[TMarker] {
        }
        """;

    [Fact]
    public void ImportedGenericClass_InfersThroughTransitiveInterface()
    {
        const string source = """
            package i4559direct
            import System
            import System.Collections.Generic
            import i4559lib

            func First[T](items IEnumerable[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            func Main() {
                Console.WriteLine(First(ProjectedCollection[int32]()))
            }
            """;

        Assert.Equal($"projected{Environment.NewLine}", CompileAndRun(source, GenericCollectionLibrary, "i4559lib"));
    }

    [Fact]
    public void ImportedGenericClass_InfersThroughTransitiveInterfaceOfBase()
    {
        const string source = """
            package i4559base
            import System
            import System.Collections.Generic
            import i4559lib

            func First[T](items IEnumerable[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            func Main() {
                Console.WriteLine(First(DerivedProjectedCollection[int32]()))
            }
            """;

        Assert.Equal($"projected{Environment.NewLine}", CompileAndRun(source, GenericCollectionLibrary, "i4559lib"));
    }

    [Fact]
    public void ImportedGenericClass_ConflictingInterfaceProjectionsStayRejected()
    {
        const string library = """
            package i4559conflictlib
            import System.Collections
            import System.Collections.Generic

            class Both : IEnumerable[int32], IEnumerable[string] {
                func GetEnumerator() IEnumerator[int32] -> List[int32]().GetEnumerator()
                private func (IEnumerable[string]) GetEnumerator() IEnumerator[string] -> List[string]().GetEnumerator()
                private func (IEnumerable) GetEnumerator() IEnumerator -> List[int32]().GetEnumerator()
            }
            """;

        const string source = """
            package i4559conflict
            import System
            import System.Collections.Generic
            import i4559conflictlib

            func First[T](items IEnumerable[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            func Main() {
                Console.WriteLine(First(Both()))
            }
            """;

        var ex = Assert.ThrowsAny<Exception>(() => CompileAndRun(source, library, "i4559conflictlib"));
        Assert.Contains("infer", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4559_exe_").FullName;
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
