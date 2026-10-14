// <copyright file="Issue2859ClassTypedForInEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2859 — `for x in source` reported
/// `GS0116: Type 'X' is not indexable` whenever the source's static type
/// was a user `class` rather than an interface.
///
/// Root cause: the binder's user-type arm only accepted a
/// `GetEnumerator()` whose return type was ANOTHER user-declared type
/// exposing `Current` as a FIELD. Every real collection — and everything
/// cs2gs emits for a C# `IEnumerable<T>` implementer — returns an
/// imported `IEnumerator[T]` whose `Current` is a property, so the
/// probe failed and the loop fell through to the indexer path.
///
/// Two further gaps only surfaced across an assembly boundary, where the
/// collection is an `ImportedTypeSymbol`: the `IEnumerable[T]` probe
/// did not expand an interface's OWN base interfaces (so a class declaring only
/// `IReadOnlyCollection[T]` never surfaced `IEnumerable[T]`), and the
/// duck-typed probe looked for `MoveNext` with `Type.GetMethod`,
/// which does not search an interface's base interfaces.
///
/// Real-world site: `tools/Oahu.Diagnostics/Checks/DeepStructureCheck.gs`
/// iterating `Oahu.Decrypt.Mpeg4.Chunks.ChunkEntryList`.
/// Each fact uses a UNIQUE package name because the in-process type caches are
/// name-keyed.
open class Issue2859ClassTypedForInEmitTests {
    @Fact
    func EndToEnd_ForIn_SameAssemblyClassImplementingIEnumerable_Runs() {
        // The reported defect: iterating a class-typed source whose
        // GetEnumerator() returns an imported IEnumerator[T].
        const source = `package i2859same
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
}`
        Assert.Equal("6${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ForIn_SameAssemblyClassWithSourceDeclaredElement_KeepsElementType() {
        // The element type is a same-compilation class, so the constructed
        // IEnumerator[Item] is erased to IEnumerator<object> on its ClrType.
        // The loop variable must still recover the symbolic `Item` (otherwise
        // `it.Value` cannot bind).
        const source = `package i2859elem
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
}`
        Assert.Equal("16${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_ForIn_ImportedClassDeclaringOnlyIReadOnlyCollection_Runs() {
        // The Oahu shape: `ChunkEntryList : IReadOnlyCollection[ChunkEntry]`
        // consumed from another assembly. IEnumerable[T] is only reachable by
        // expanding IReadOnlyCollection[T]'s own base interfaces.
        const library = `package i2859lib
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
}`
        const source = `package i2859xasm
import System
import i2859lib

func Main() {
    var total = 0
    let list = EntryList()
    for e in list {
        total += e.N
    }

    Console.WriteLine(total)
}`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source, library, "i2859lib"))
    }

    @Fact
    func EndToEnd_ForIn_ImportedDuckTypedClassWithNoInterface_Runs() {
        // No interface at all — only a public GetEnumerator() returning an
        // imported IEnumerator[T]. MoveNext lives on the BASE IEnumerator
        // interface, which Type.GetMethod does not search.
        const library = `package i2859ducklib
import System.Collections.Generic

class DuckBag {
    private let items List[int32]

    init() {
        items = List[int32]()
        items.Add(10)
        items.Add(20)
    }

    func GetEnumerator() IEnumerator[int32] -> items.GetEnumerator()
}`
        const source = `package i2859duck
import System
import i2859ducklib

func Main() {
    var total = 0
    for v in DuckBag() {
        total += v
    }

    Console.WriteLine(total)
}`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source, library, "i2859ducklib"))
    }

    @Fact
    func EndToEnd_ForIn_InterfaceTypedSource_StillRuns() {
        // Control: the interface-typed source always worked and must keep
        // working — this fact fails if the widening broke the existing path.
        const source = `package i2859ctrl
import System
import System.Collections.Generic

func Main() {
    var total = 0
    let items IEnumerable[int32] = List[int32]{ 1, 2, 3, 4 }
    for x in items {
        total += x
    }

    Console.WriteLine(total)
}`
        Assert.Equal("10${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string, library string? = nil, libraryAssemblyName string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2859_exe_").FullName
            try {
                var libDll string? = nil
                if library != nil {
                    // ilverify resolves `-r` references by FILE NAME, so the
                    // library must be written out under its assembly identity.
                    let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                    libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                    File.WriteAllText(libSrc, library)
                    Compile([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                    IlVerifier.Verify(libDll)
                }
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                if libDll != nil {
                    args.Add("/r:" + libDll)
                }
                args.Add(srcPath)
                Compile(args.ToArray())
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func Compile(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }
    }
}
