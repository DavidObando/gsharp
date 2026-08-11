// <copyright file="Issue2859ClassTypedForInEmitTests.cs" company="GSharp">
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
/// Issue #2859 — <c>for x in source</c> reported
/// <c>GS0116: Type 'X' is not indexable</c> whenever the source's static type
/// was a user <c>class</c> rather than an interface.
/// <para>
/// Root cause: the binder's user-type arm only accepted a
/// <c>GetEnumerator()</c> whose return type was ANOTHER user-declared type
/// exposing <c>Current</c> as a FIELD. Every real collection — and everything
/// cs2gs emits for a C# <c>IEnumerable&lt;T&gt;</c> implementer — returns an
/// imported <c>IEnumerator[T]</c> whose <c>Current</c> is a property, so the
/// probe failed and the loop fell through to the indexer path.
/// </para>
/// <para>
/// Two further gaps only surfaced across an assembly boundary, where the
/// collection is an <c>ImportedTypeSymbol</c>: the <c>IEnumerable[T]</c> probe
/// did not expand an interface's OWN base interfaces (so a class declaring only
/// <c>IReadOnlyCollection[T]</c> never surfaced <c>IEnumerable[T]</c>), and the
/// duck-typed probe looked for <c>MoveNext</c> with <c>Type.GetMethod</c>,
/// which does not search an interface's base interfaces.
/// </para>
/// Real-world site: <c>tools/Oahu.Diagnostics/Checks/DeepStructureCheck.gs</c>
/// iterating <c>Oahu.Decrypt.Mpeg4.Chunks.ChunkEntryList</c>.
/// Each fact uses a UNIQUE package name because the in-process type caches are
/// name-keyed.
/// </summary>
public class Issue2859ClassTypedForInEmitTests
{
    [Fact]
    public void EndToEnd_ForIn_SameAssemblyClassImplementingIEnumerable_Runs()
    {
        // The reported defect: iterating a class-typed source whose
        // GetEnumerator() returns an imported IEnumerator[T].
        const string source = """
            package i2859same
            import System
            import System.Collections
            import System.Collections.Generic

            class Bag : IEnumerable[int32] {
                private let items List[int32]

                init() {
                    items = List[int32]()
                    items.Add(1)
                    items.Add(2)
                    items.Add(3)
                }

                func GetEnumerator() IEnumerator[int32] -> items.GetEnumerator()
                private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
            }

            func Main() {
                var total = 0
                let bag = Bag()
                for x in bag {
                    total += x
                }

                Console.WriteLine(total)
            }
            """;

        Assert.Equal($"6{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_ForIn_SameAssemblyClassWithSourceDeclaredElement_KeepsElementType()
    {
        // The element type is a same-compilation class, so the constructed
        // IEnumerator[Item] is erased to IEnumerator<object> on its ClrType.
        // The loop variable must still recover the symbolic `Item` (otherwise
        // `it.Value` cannot bind).
        const string source = """
            package i2859elem
            import System
            import System.Collections.Generic

            class Item {
                prop Value int32 { get; init; }
            }

            class ItemBag {
                private let items List[Item]

                init() {
                    items = List[Item]()
                    items.Add(Item{Value: 7})
                    items.Add(Item{Value: 9})
                }

                func GetEnumerator() IEnumerator[Item] -> items.GetEnumerator()
            }

            func Main() {
                var total = 0
                for it in ItemBag() {
                    total += it.Value
                }

                Console.WriteLine(total)
            }
            """;

        Assert.Equal($"16{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void EndToEnd_ForIn_ImportedClassDeclaringOnlyIReadOnlyCollection_Runs()
    {
        // The Oahu shape: `ChunkEntryList : IReadOnlyCollection[ChunkEntry]`
        // consumed from another assembly. IEnumerable[T] is only reachable by
        // expanding IReadOnlyCollection[T]'s own base interfaces.
        const string library = """
            package i2859lib
            import System
            import System.Collections
            import System.Collections.Generic

            class Entry {
                prop N int32 { get; init; }
            }

            class EntryList : IReadOnlyCollection[Entry] {
                private let items List[Entry]

                init() {
                    items = List[Entry]()
                    items.Add(Entry{N: 4})
                    items.Add(Entry{N: 5})
                }

                prop Count int32 { get -> items.Count }

                func GetEnumerator() IEnumerator[Entry] -> items.GetEnumerator()
                private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
            }
            """;

        const string source = """
            package i2859xasm
            import System
            import i2859lib

            func Main() {
                var total = 0
                let list = EntryList()
                for e in list {
                    total += e.N
                }

                Console.WriteLine(total)
            }
            """;

        Assert.Equal($"9{Environment.NewLine}", CompileAndRun(source, library, "i2859lib"));
    }

    [Fact]
    public void EndToEnd_ForIn_ImportedDuckTypedClassWithNoInterface_Runs()
    {
        // No interface at all — only a public GetEnumerator() returning an
        // imported IEnumerator[T]. MoveNext lives on the BASE IEnumerator
        // interface, which Type.GetMethod does not search.
        const string library = """
            package i2859ducklib
            import System.Collections.Generic

            class DuckBag {
                private let items List[int32]

                init() {
                    items = List[int32]()
                    items.Add(10)
                    items.Add(20)
                }

                func GetEnumerator() IEnumerator[int32] -> items.GetEnumerator()
            }
            """;

        const string source = """
            package i2859duck
            import System
            import i2859ducklib

            func Main() {
                var total = 0
                for v in DuckBag() {
                    total += v
                }

                Console.WriteLine(total)
            }
            """;

        Assert.Equal($"30{Environment.NewLine}", CompileAndRun(source, library, "i2859ducklib"));
    }

    [Fact]
    public void EndToEnd_ForIn_InterfaceTypedSource_StillRuns()
    {
        // Control: the interface-typed source always worked and must keep
        // working — this fact fails if the widening broke the existing path.
        const string source = """
            package i2859ctrl
            import System
            import System.Collections.Generic

            func Main() {
                var total = 0
                let items IEnumerable[int32] = List[int32]{ 1, 2, 3, 4 }
                for x in items {
                    total += x
                }

                Console.WriteLine(total)
            }
            """;

        Assert.Equal($"10{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source, string library = null, string libraryAssemblyName = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2859_exe_").FullName;
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
