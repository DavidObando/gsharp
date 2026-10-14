// <copyright file="Issue2385NullableSameCompilationStructGenericArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2385 (deferred finding from #2381): an imported generic collection
/// closed over a <em>nullable same-compilation struct/enum</em> (e.g.
/// `List[Point?]`) produced `System.InvalidProgramException` at
/// runtime. (cref:GSharp.Core.CodeAnalysis.Binding.ConversionClassifier
/// .TrySubstituteParameterTypeFromReceiver) recovers the substituted
/// parameter type for a call on an imported generic receiver (e.g.
/// `List[T].Add(!0)`) whose type argument is a same-compilation user
/// type, so the correct conversion (`T -> Nullable<T>`) is
/// bound instead of the erased/boxing shape. Its gate previously only
/// matched a receiver type argument that was DIRECTLY a
/// `StructSymbol`/`InterfaceSymbol`/`EnumSymbol`/
/// `DelegateTypeSymbol` (or nested `ImportedTypeSymbol`) — a
/// `NullableTypeSymbol` wrapping one of those (the actual shape of
/// `List[Point?]`'s type argument) matched none of those cases, so the
/// whole substitution was skipped and the call fell back to the erased CLR
/// parameter type (`object`), misclassifying the argument as boxing.
/// The emitted `box`/bare `ldnull` IL is invalid against what is
/// actually a value-type `Nullable<T>` generic parameter slot,
/// producing `InvalidProgramException` at runtime (no compile-time
/// diagnostic — (cref:IlVerifier) is what catches this class of
/// defect).
///
/// The fix replaces the narrow ad hoc predicate with
/// `TypeSymbol.ContainsSameCompilationUserType` — the general,
/// already-established predicate (reused from the analogous #2381 fix) that
/// recurses uniformly through `NullableTypeSymbol` (and
/// `SliceTypeSymbol`/`ArrayTypeSymbol`/`TupleTypeSymbol`/nested
/// `ImportedTypeSymbol`), so it additionally and for-free generalizes to
/// same-compilation ENUMS wrapped in `Nullable<T>`.
open class Issue2385NullableSameCompilationStructGenericArgEmitTests {
    @Fact
    func ListOfNullableUserStruct_AddConcreteAndNil_RunsAndVerifies() {
        const source = `package i2385struct
import System
import System.Collections.Generic

struct Point2385(X int32, Y int32) { }

func main() {
    let list = List[Point2385?]()
    list.Add(Point2385(1, 2))
    list.Add(nil)
    let first = list[0] ?? Point2385(0, 0)
    let second = list[1] ?? Point2385(-1, -1)
    Console.WriteLine(list.Count)
    Console.WriteLine(first.X)
    Console.WriteLine(second.X)
}

main()`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}1${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func ListOfNullableUserEnum_AddConcreteAndNil_RunsAndVerifies() {
        const source = `package i2385enum
import System
import System.Collections.Generic

enum Color2385 { Red, Green, Blue }

func main() {
    let list = List[Color2385?]()
    list.Add(Color2385.Blue)
    list.Add(nil)
    let first = list[0] ?? Color2385.Red
    let second = list[1] ?? Color2385.Red
    Console.WriteLine(list.Count)
    Console.WriteLine(first)
    Console.WriteLine(second)
}

main()`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}2${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func DictionaryValueNullableUserStruct_IndexerSetAndGet_RunsAndVerifies() {
        const source = `package i2385dict
import System
import System.Collections.Generic

struct Point2385Dict(X int32, Y int32) { }

func main() {
    let dict = Dictionary[string, Point2385Dict?]()
    dict["a"] = Point2385Dict(3, 4)
    dict["b"] = nil
    let a = dict["a"] ?? Point2385Dict(0, 0)
    let b = dict["b"] ?? Point2385Dict(-1, -1)
    Console.WriteLine(dict.Count)
    Console.WriteLine(a.X)
    Console.WriteLine(b.X)
}

main()`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}3${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func ListOfNonNullableUserStruct_AddConcreteValue_RegressionStillRuns() {
        // Regression control: the pre-existing (#765) DIRECT (non-nullable)
        // same-compilation struct type argument must keep working exactly
        // as before the widened gate.
        const source = `package i2385directstruct
import System
import System.Collections.Generic

struct Point2385Direct(X int32, Y int32) { }

func main() {
    let list = List[Point2385Direct]()
    list.Add(Point2385Direct(5, 6))
    Console.WriteLine(list.Count)
    Console.WriteLine(list[0].X)
}

main()`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func ListOfNullablePrimitive_AddConcreteValueAndNil_RegressionStillRuns() {
        // Regression control: a BUILT-IN nullable value type (Nullable<int32>)
        // is unaffected by the widened gate (it never reached
        // TrySubstituteParameterTypeFromReceiver's same-compilation-only
        // substitution path in the first place).
        const source = `package i2385primitive
import System
import System.Collections.Generic

func main() {
    let list = List[int32?]()
    list.Add(42)
    list.Add(nil)
    let first = list[0] ?? -1
    let second = list[1] ?? -1
    Console.WriteLine(list.Count)
    Console.WriteLine(first)
    Console.WriteLine(second)
}

main()`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}42${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2385_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                IlVerifier.Verify(dllPath)
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
    }
}
