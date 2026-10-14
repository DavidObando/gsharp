// <copyright file="Issue2323GenericSliceInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2323: the binder already accepts a slice `[]T` converting to
/// each of the five supported one-argument generic collection interfaces —
/// `IEnumerable[T]`, `ICollection[T]`, `IList[T]`,
/// `IReadOnlyList[T]`, `IReadOnlyCollection[T]` — when `T` is a
/// generic type parameter (via `Conversion.SliceConvertsToInterfaceSymbolically`),
/// but `MethodBodyEmitter.IsReferenceCompatible` only mirrored the
/// element-INDEPENDENT #2140 array supertypes and threw
/// (cref:NotSupportedException) (surfaced as GS9998) for these five
/// generic interfaces. These tests prove the paired emitter fix end-to-end —
/// compile, ILVerify, and run — for all five interfaces using the exact
/// shape from the issue's minimal repro (a generic `Holder[T]` class),
/// plus negative coverage proving mismatched element types and unsupported
/// generic interfaces are still rejected at BIND time (never reaching the
/// emitter).
open class Issue2323GenericSliceInterfaceEmitTests {
    @Fact
    func GenericParamElementSlice_ToIEnumerable_CompilesRunsAndIlVerifies() {
        let gsource = `package Repro
import System
import System.Collections.Generic

class Holder[T] {
    var items IEnumerable[T]
    init(values []T) { items = values }
    func Count() int32 {
        var n int32 = 0
        for x in items { n = n + 1 }
        return n
    }
}

var h = Holder[int32]([]int32{1, 2, 3})
Console.WriteLine(h.Count())`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func GenericParamElementSlice_ToICollection_CompilesRunsAndIlVerifies() {
        let gsource = `package Repro
import System
import System.Collections.Generic

class Holder[T] {
    var items ICollection[T]
    init(values []T) { items = values }
}

var h = Holder[int32]([]int32{1, 2, 3, 4})
Console.WriteLine(h.items.Count)`
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func GenericParamElementSlice_ToIList_CompilesRunsAndIlVerifies() {
        let gsource = `package Repro
import System
import System.Collections.Generic

class Holder[T] {
    var items IList[T]
    init(values []T) { items = values }
}

var h = Holder[int32]([]int32{1, 2, 3})
Console.WriteLine(h.items.Count)
Console.WriteLine(h.items[1])`
        Assert.Equal("3${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func GenericParamElementSlice_ToIReadOnlyList_CompilesRunsAndIlVerifies() {
        let gsource = `package Repro
import System
import System.Collections.Generic

class Holder[T] {
    var items IReadOnlyList[T]
    init(values []T) { items = values }
}

var h = Holder[int32]([]int32{7, 9})
Console.WriteLine(h.items[0])
Console.WriteLine(h.items.Count)`
        Assert.Equal("7${Environment.NewLine}2${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func GenericParamElementSlice_ToIReadOnlyCollection_CompilesRunsAndIlVerifies() {
        let gsource = `package Repro
import System
import System.Collections.Generic

class Holder[T] {
    var items IReadOnlyCollection[T]
    init(values []T) { items = values }
}

var h = Holder[int32]([]int32{1, 2, 3, 4, 5})
Console.WriteLine(h.items.Count)`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func GenericParamElementSlice_ToIList_WithStringInstantiation_CompilesRunsAndIlVerifies() {
        // Same generic Holder[T], closed over a reference-type argument
        // instead of the primitive int32 used above.
        let gsource = `package Repro
import System
import System.Collections.Generic

class Holder[T] {
    var items IList[T]
    init(values []T) { items = values }
}

var h = Holder[string]([]string{"a", "b", "c"})
Console.WriteLine(h.items.Count)
Console.WriteLine(h.items[2])`
        Assert.Equal("3${Environment.NewLine}c${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func Negative_GenericParamElementSlice_ToMismatchedIList_FailsAtBind() {
        // Slice invariance must hold: []T does NOT convert to IList[U] for a
        // different generic parameter U. Must fail to compile (never reach
        // the emitter), not crash with GS9998.
        let gsource = `package Repro
import System.Collections.Generic

class Holder[T, U] {
    var items IList[U]
    init(values []T) { items = values }
}`
        let (exitCode, stderr) = Compile(gsource)
        Assert.NotEqual(0, exitCode)
        Assert.DoesNotContain("GS9998", stderr)
    }

    @Fact
    func Negative_GenericParamElementSlice_ToUnsupportedGenericInterface_FailsAtBind() {
        // ISet[T] is not one of the five supported array supertype
        // interfaces; []T must not convert to it.
        let gsource = `package Repro
import System.Collections.Generic

class Holder[T] {
    var items ISet[T]
    init(values []T) { items = values }
}`
        let (exitCode, stderr) = Compile(gsource)
        Assert.NotEqual(0, exitCode)
        Assert.DoesNotContain("GS9998", stderr)
    }

    shared {
        private func Compile(source string)(ExitCode int32, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2323_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (compileExit, compileOut.ToString() + compileErr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2323_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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
    }
}
