// <copyright file="Issue4559TransitiveInterfaceInferenceEmitTests.cs" company="GSharp">
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

/// Issue #4559 — generic inference must traverse interface inheritance even
/// when the referenced assembly was emitted by G#, whose InterfaceImpl rows
/// list only the DIRECT interfaces of a type. A library class declaring only
/// `IReadOnlyCollection[string]` has no row for the inherited
/// `IEnumerable[string]`, so the consumer's `First[T](IEnumerable[T])`
/// call could not infer `T`.
class Issue4559TransitiveInterfaceInferenceEmitTests {
    @Fact
    func ImportedGenericClass_InfersThroughTransitiveInterface() {
        const source = `package i4559direct
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
}`
        Assert.Equal("projected${Environment.NewLine}", CompileAndRun(source, GenericCollectionLibrary, "i4559lib"))
    }

    @Fact
    func ImportedGenericClass_InfersThroughTransitiveInterfaceOfBase() {
        const source = `package i4559base
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
}`
        Assert.Equal("projected${Environment.NewLine}", CompileAndRun(source, GenericCollectionLibrary, "i4559lib"))
    }

    @Fact
    func ImportedGenericClass_ConflictingInterfaceProjectionsStayRejected() {
        const library = `package i4559conflictlib
import System.Collections
import System.Collections.Generic

class Both : IEnumerable[int32], IEnumerable[string] {
    func GetEnumerator() IEnumerator[int32] -> List[int32]().GetEnumerator()
    private func (IEnumerable[string]) GetEnumerator() IEnumerator[string] -> List[string]().GetEnumerator()
    private func (IEnumerable) GetEnumerator() IEnumerator -> List[int32]().GetEnumerator()
}`
        const source = `package i4559conflict
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
}`
        let ex = Assert.ThrowsAny[Exception](
            func () object? {
                return CompileAndRun(source, library, "i4559conflictlib")
            }
        )
        Assert.Contains("GS0151", ex.Message, StringComparison.Ordinal)
    }

    shared {
        private const GenericCollectionLibrary string = `package i4559lib
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
}`

        private func CompileAndRun(source string, library string? = nil, libraryAssemblyName string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_4559_exe_").FullName
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
                let stdoutTask = proc.StandardOutput.ReadToEndAsync()
                let stderrTask = proc.StandardError.ReadToEndAsync()
                if !proc.WaitForExit(30_000) {
                    proc.Kill(entireProcessTree: true)
                    Assert.Fail("dotnet exec timed out")
                }
                let stdout = stdoutTask.GetAwaiter().GetResult()
                let stderr = stderrTask.GetAwaiter().GetResult()
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
