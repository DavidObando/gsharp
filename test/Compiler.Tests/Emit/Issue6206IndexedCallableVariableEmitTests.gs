// <copyright file="Issue6206IndexedCallableVariableEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #6206: `fns[i](x)` on a bare variable/field/property of an indexable
/// container of callables parses with a `TypeArgumentList` under ADR-0020 and
/// must bind as index-then-call, while genuine generic calls, constructors,
/// and #6186 `GS0148` diagnostics remain intact.
open class Issue6206IndexedCallableVariableEmitTests {
    @Fact
    func Repro_And_ContainerShapes_Execute() {
        let output = CompileAndRun(`package P
import System
import System.Collections.Generic

class T {}

class Grid {
    private let fns[](int32) -> int32
    init(fns [](int32) -> int32) { this.fns = fns }
    prop this[row int32, col int32] (int32) -> int32 {
        get { return fns[row * 2 + col] }
    }
}

class Holder {
    var Callbacks Dictionary[string, (int32) -> int32] = Dictionary[string, (int32) -> int32]()
    var Matrix[,](int32) -> int32 = [2, 2](int32) -> int32{
        (v int32) -> v + 1,
        (v int32) -> v + 2,
        (v int32) -> v + 3,
        (v int32) -> v + 4
    }
}

class Container {
    var FieldFns List[(int32) -> int32] = List[(int32) -> int32]()
    prop PropFns [](int32) -> int32 {
        get { return [](int32) -> int32{(v int32) -> v + 100} }
    }
    shared {
        var SharedFns List[(int32) -> int32] = List[(int32) -> int32]()
    }
    func Run(x int32) string {
        let i = 0
        FieldFns.Add((v int32) -> v + 50)
        SharedFns.Add((v int32) -> v + 60)
        return "${FieldFns[i](x)}:${PropFns[i](x)}:${SharedFns[i](x)}"
    }
}

func Id[T](v T) T -> v
func Pair[A, B](a A, b B) string -> "${a}-${b}"

class Box[T] {
    let V T
    init(v T) { V = v }
}

func Main() {
    let x = 10
    let i = 0

    // Exact #6206 repro + literal index
    let fns = List[(int32) -> int32]()
    fns.Add((v int32) -> v + 1)
    fns.Add((v int32) -> v + 2)
    let a = fns[i](x)
    let b = fns[0](x)

    // Slice, fixed array, Dictionary, map, arithmetic index, nested index
    let arr = [](int32) -> int32{(v int32) -> v * 2, (v int32) -> v * 3}
    let fixedArr = [2](int32) -> int32{(v int32) -> v + 5, (v int32) -> v + 6}
    let dict = Dictionary[string, Func[int32, int32]]()
    let k = "mul"
    dict[k] = func(v int32) int32 { return v * 10 }
    let m = map[string, (int32) -> int32]{"inc": (v int32) -> v + 7}
    let jobs = []int32{1, 0}

    // Multi-arg index (rectangular array + user indexer)
    let rect = [2, 2](int32) -> int32{
        (v int32) -> v + 10,
        (v int32) -> v + 20,
        (v int32) -> v + 30,
        (v int32) -> v + 40
    }
    let j = 1
    let grid = Grid(arr)

    // Chained call & null-conditional call & deferred lambda argument
    let factories = List[(int32) -> (int32) -> int32]()
    factories.Add((baseVal int32) -> (delta int32) -> baseVal + delta)
    let optFns = List[((int32) -> int32)?]()
    optFns.Add((v int32) -> v + 9)
    optFns.Add(nil)
    let higher = []((int32) -> int32) -> int32{(cb (int32) -> int32) -> cb(4)}

    // Local index variable sharing a name with a type T
    let T = 1

    // Member-receiver #3880 with nested and multi-arg indices
    let holder = Holder()
    let keys = []string{"hit"}
    holder.Callbacks["hit"] = (v int32) -> v + 77

    // Container field/property/shared field
    let container = Container()

    // Genuine generic calls & constructors still work
    let g1 = Id[int32](5)
    let g2 = Pair[int32, string](1, "ok")
    let box = Box[List[int32]](List[int32]{99})
    let box2 = Box[int32](88)

    let dictLit = dict["mul"](x)
    let mapLit = m["inc"](x)
    Console.WriteLine("${a}:${b}:${arr[i](x)}:${fixedArr[i](x)}:${dict[k](x)}:${dictLit}:${mapLit}:${fns[i + 1](x)}:${fns[jobs[i]](x)}")
    Console.WriteLine("${rect[i, j](x)}:${grid[i, j](x)}:${factories[i](x)(3)}:${optFns[i]?(x)}:${optFns[j]?(x) == nil}:${higher[i](v -> v + 8)}:${fns[T](x)}")
    Console.WriteLine("${holder.Callbacks[keys[i]](x)}:${holder.Matrix[i, j](x)}:${container.Run(x)}")
    Console.WriteLine("${g1}:${g2}:${box.V[0]}:${box2.V}")
}`)
        let expected = "11:11:20:15:100:100:17:12:12" +
            Environment.NewLine +
            "30:30:13:19:True:12:12" +
            Environment.NewLine +
            "87:12:60:110:70" +
            Environment.NewLine +
            "5:1-ok:99:88" +
            Environment.NewLine
        Assert.Equal(expected, output)
    }

    @Fact
    func ColorColorShadow_And_FallbackReceivers_Execute() {
        let output = CompileAndRun(`package P
import System
import System.Collections.Generic

class Box[T] {
    let Value T
    init(v T) { Value = v }
}

interface IFnHost {
    prop IfaceFns [](int32) -> int32 {
        get { return [](int32) -> int32{(v int32) -> v + 200} }
    }
    func CallViaDim(i int32, x int32) int32 { return IfaceFns[i](x) }
}

class Impl : IFnHost {}

func Main() {
    // Color Color: local variable Box shadows class Box[T].
    // Box[i](x) indexes the local; Box[int32](x) constructs Box[int32].
    let Box = List[(int32) -> int32]()
    Box.Add((v int32) -> v + 300)
    let i = 0
    let x = 5
    let indexed = Box[i](x)
    let constructed = Box[int32](x)
    let dimRes = Impl().CallViaDim(i, x)
    Console.WriteLine("${indexed}:${constructed.Value}:${dimRes}")
}`)
        Assert.Equal("305:5:205${Environment.NewLine}", output)
    }

    @Fact
    func InheritedClrProperty_And_StaticImport_Execute() {
        let output = CompileLibraryAndRun(library: `package LibCallbacks
import System
import System.Collections.Generic

open class BaseCallbacks {
    prop InheritedFns List[(int32) -> int32] {
        get {
            let xs = List[(int32) -> int32]()
            xs.Add((v int32) -> v + 11)
            return xs
        }
    }
    shared {
        let StaticFns [](int32) -> int32 = [](int32) -> int32{(v int32) -> v + 22}
    }
}`, consumer: `package P
import System
import LibCallbacks
import LibCallbacks.BaseCallbacks

class Child : BaseCallbacks {
    func Run(i int32, x int32) int32 -> InheritedFns[i](x) + StaticFns[i](x)
}

func Main() {
    let i = 0
    Console.WriteLine(Child().Run(i, 3))
}`)
        Assert.Equal("39${Environment.NewLine}", output)
    }

    @Fact
    func NegativeControls_ReportExpectedDiagnostics() {
        // Non-generic function with type argument -> GS0148
        let nonGenericErrors = CompileExpectingErrors(`package P
func Use(x int32) int32 -> x
func Main() {
    let a = Use[int32](1)
}`)
        Assert.Contains("GS0148", nonGenericErrors, StringComparison.Ordinal)

        // Undefined callee -> GS0130
        let undefinedErrors = CompileExpectingErrors(`package P
func Main() {
    let a = Undefined[Nope](1)
}`)
        Assert.Contains("GS0130", undefinedErrors, StringComparison.Ordinal)

        // Non-callable indexed element -> GS0131 on `ints[i]`
        let nonCallableErrors = CompileExpectingErrors(`package P
func Main() {
    let ints = []int32{1, 2}
    let i = 0
    let a = ints[i](1)
}`)
        Assert.Contains("GS0131", nonCallableErrors, StringComparison.Ordinal)
        Assert.Contains("ints[i]", nonCallableErrors, StringComparison.Ordinal)

        // Invalid index type -> GS0267 on List / GS0155 on slice (not GS0131 "'fns' is not a function")
        let badListIndexErrors = CompileExpectingErrors(`package P
import System.Collections.Generic
func Main() {
    let fns = List[(int32) -> int32]()
    let bad = "k"
    let a = fns[bad](1)
}`)
        Assert.Contains("GS0267", badListIndexErrors, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0131", badListIndexErrors, StringComparison.Ordinal)

        let badSliceIndexErrors = CompileExpectingErrors(`package P
func Main() {
    let arr = [](int32) -> int32{(v int32) -> v + 1}
    let bad = "k"
    let a = arr[bad](1)
}`)
        Assert.Contains("GS0155", badSliceIndexErrors, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0131", badSliceIndexErrors, StringComparison.Ordinal)
    }

    shared {
        private func CompileLibraryAndRun(library string, consumer string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_6206_lib_").FullName
            try {
                let libSrc = Path.Combine(tempDir, "lib.gs")
                let libDll = Path.Combine(tempDir, "LibCallbacks.dll")
                File.WriteAllText(libSrc, library)
                RunGsc([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                let consumerSrc = Path.Combine(tempDir, "consumer.gs")
                let consumerDll = Path.Combine(tempDir, "consumer.dll")
                File.WriteAllText(consumerSrc, consumer)
                RunGsc(
                    []string{
                        "/out:" + consumerDll,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/r:" + libDll,
                        consumerSrc
                    }
                )
                IlVerifier.Verify(consumerDll, []string{libDll})
                return ExecDll(tempDir, consumerDll)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_6206_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                RunGsc([]string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath})
                IlVerifier.Verify(outPath)
                return ExecDll(tempDir, outPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func ExecDll(tempDir string, dllPath string) string {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(Path.ChangeExtension(dllPath, ".runtimeconfig.json"))
            psi.ArgumentList.Add(dllPath)
            using let proc = Process.Start(psi)!!
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func CompileExpectingErrors(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_6206_neg_").FullName
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
                Assert.True(compileExit != 0, "expected compilation failure")
                return compileOut.ToString() + compileErr.ToString()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunGsc(args[]string) {
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
        }
    }
}
