// <copyright file="ForRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Phase 4 emit-parity tests for `for k, v := range coll` across the three
/// iteration shapes the binder produces: Indexed (arrays), Dictionary
/// (Dictionary[K,V]), and Enumerable (List[T] and other IEnumerable[T]).
/// All three are lowered by `Lowerer.LowerCollectionRange` /
/// `LowerIndexedRange` and rely on the CLR-interop emit paths added in
/// commit A plus value-type-receiver handling for struct enumerators.
open class ForRangeEmitTests {
    @Fact
    func IndexedRange_OverFixedArray() {
        let source = `package P
import System

var arr = [3]int32{100, 200, 300}
for i, v in arr {
  Console.WriteLine(i)
  Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "0${Environment.NewLine}100${Environment.NewLine}1${Environment.NewLine}200${Environment.NewLine}2${Environment.NewLine}300${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EnumerableRange_OverList_ValueOnly() {
        let source = `package P
import System
import System.Collections.Generic

var xs = List[int32]()
xs.Add(10)
xs.Add(20)
xs.Add(30)
for v in xs {
  Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", output)
    }

    @Fact
    func EnumerableRange_OverList_WithIndex() {
        let source = `package P
import System
import System.Collections.Generic

var xs = List[int32]()
xs.Add(10)
xs.Add(20)
for i, v in xs {
  Console.WriteLine(i)
  Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "0${Environment.NewLine}10${Environment.NewLine}1${Environment.NewLine}20${Environment.NewLine}",
            output
        )
    }

    @Fact
    func DictionaryRange_KeysAndValues() {
        let source = `package P
import System
import System.Collections.Generic

var d = Dictionary[string, int32]()
d["a"] = 1
d["b"] = 2
for k, v in d {
  Console.WriteLine(k)
  Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "a${Environment.NewLine}1${Environment.NewLine}b${Environment.NewLine}2${Environment.NewLine}",
            output
        )
    }

    // ---- P2-1 regression tests: for-range over an IEnumerable must wrap the
    // enumerator loop in try/finally Dispose, matching Roslyn's `foreach`
    // lowering. Resource-owning enumerators (StreamReader-backed
    // File.ReadLines, custom IEnumerator<T>s, Dictionary<K,V>.Enumerator)
    // would otherwise leak handles on every iteration.
    /// A for-range over `List[int32]` (a value-type enumerator that
    /// implements (cref:IDisposable)) must produce exactly one
    /// exception region in the entry-point method body — the try/finally
    /// that disposes the enumerator after the loop.
    @Fact
    func EnumerableRange_OverList_EmitsTryFinallyDispose() {
        let source = `package P
import System
import System.Collections.Generic

var xs = List[int32]()
xs.Add(1)
for v in xs {
  Console.WriteLine(v)
}`
        let regions = GetEntryPointExceptionRegions(source)
        Assert.True(
            regions.Any((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Finally),
            "Expected at least one finally region in the entry-point body to dispose the enumerator."
        )
    }

    /// A for-range over (cref:System.Collections.Generic.IEnumerable{T})
    /// — i.e. a reference enumerator with non-no-op Dispose — must also wrap
    /// in try/finally. Uses `Enumerable.Range` (reference enumerator).
    @Fact
    func EnumerableRange_OverIEnumerable_EmitsTryFinallyDispose() {
        let source = `package P
import System
import System.Linq

for v in Enumerable.Range(0, 3) {
  Console.WriteLine(v)
}`
        let regions = GetEntryPointExceptionRegions(source)
        Assert.True(
            regions.Any((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Finally),
            "Expected a finally region wrapping the enumerator loop for IEnumerable<int>."
        )
    }

    /// The Dispose call inside the finally region must actually run end-to-end
    /// — verified here by iterating a temp file via `File.ReadLines` and
    /// observing that the underlying `StreamReader` released the file
    /// handle (so we can delete the file immediately after the loop on
    /// platforms where open files are locked).
    @Fact
    func EnumerableRange_OverFileReadLines_ReleasesFileHandle() {
        let dataDir = Directory.CreateTempSubdirectory("gs_for_range_dispose_data_").FullName
        let dataPath = Path.Combine(dataDir, "data.txt")
        File.WriteAllText(dataPath, `alpha
beta
gamma
`)
        let source = (`package P
import System
import System.IO

for line in File.ReadLines("` + "${dataPath.Replace("\\", "\\\\")}" + `") {
  Console.WriteLine(line)
}`)
        let output = CompileAndRun(source)
        Assert.Equal("alpha${Environment.NewLine}beta${Environment.NewLine}gamma${Environment.NewLine}", output)
        // If the for-range didn't dispose the StreamReader, the file handle
        // would still be held by the (now-orphaned) reader, and on Windows
        // this delete would throw IOException. On POSIX deletion succeeds
        // regardless, but failing to call Dispose would still be observable
        // via accumulated handle leaks at scale.
        File.Delete(dataPath)
        Directory.Delete(dataDir)
    }

    private struct ImmutableExceptionRegionList {
        private let regions List[ExceptionRegion]

        init(regions List[ExceptionRegion]) {
            this.regions = regions
        }

        func Where(p(ExceptionRegion) -> bool) IEnumerable[ExceptionRegion] -> this.regions.Where(p)

        func Any(p(ExceptionRegion) -> bool) bool -> this.regions.Any(p)
        prop Count int32 -> this.regions.Count
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_for_range_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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

        private func GetEntryPointExceptionRegions(source string) ImmutableExceptionRegionList {
            let tempDir = Directory.CreateTempSubdirectory("gs_for_range_dispose_il_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                using let fs = File.OpenRead(outPath)
                using let pe = PEReader(fs)
                let md = pe.GetMetadataReader()
                let entryToken = pe.PEHeaders.CorHeader!!.EntryPointTokenOrRelativeVirtualAddress
                Assert.NotEqual(0, entryToken)
                let entryMethodHandle = MetadataTokens.MethodDefinitionHandle(entryToken)
                let entryMethod = md.GetMethodDefinition(entryMethodHandle)
                let rva = entryMethod.RelativeVirtualAddress
                Assert.NotEqual(0, rva)
                let body = pe.GetMethodBody(rva)
                let collected = List[ExceptionRegion](body.ExceptionRegions.Length)
                for region in body.ExceptionRegions {
                    collected.Add(region)
                }
                return ImmutableExceptionRegionList(collected)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
