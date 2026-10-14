// <copyright file="Issue1512GenericClosureInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1512 — two independent emit bugs that both surface when a generic
/// class passes a lambda returning (or parameterized by) a type parameter to a
/// generic method.
///
/// Facet A — generic-method type-argument inference erased a type-parameter
/// lambda return to `object`. `Task.ContinueWith<TResult>` (and
/// any generic CLR/imported method inferring a type argument from a lambda whose
/// parameter/return is a type parameter) selected `ContinueWith<object>`
/// instead of `ContinueWith<T>`, producing `Task<object>`
/// where `Task<T>` was required and failing ilverify with
/// `StackUnexpected [found Task`1<object>][expected Task`1<T0>]`.
///
/// Facet B — a lambda lowered into a generic closure class (reified over its
/// enclosing type parameters) was emitted as a top-level type, so its
/// synthesized `Invoke` could not access the enclosing generic class's
/// `private` captured field, failing ilverify with
/// `FieldAccess … Field is not visible`. Nesting the reified closure inside
/// its enclosing type (matching the non-generic closure path) grants the CLR
/// nested-type access to the encloser's private members.
///
/// Every test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed. The `CompileAndRun` helper
/// runs `IlVerifier.Verify` and then executes the program, so each test
/// asserts both ilverify-cleanliness and a real runtime value.
open class Issue1512GenericClosureInferenceEmitTests {
    @Fact
    func FacetA_TaskContinueWith_ReturnsTypeParameter_Runs() {
        const source = `package i1512facetataskcw
import System
import System.Threading.Tasks

class Op[T] {
    var cont Task[T]?
    init() { }
    func SetIt(readerTask Task, v T) Task[T] {
        let r = readerTask.ContinueWith((t Task) -> v)
        cont = r
        return r
    }
}

func Main() {
    var o = Op[int32]()
    var r = o.SetIt(Task.CompletedTask, 42)
    System.Console.WriteLine(r.Result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func FacetA_EnumerableSelect_ReturnsTypeParameter_Runs() {
        // A non-Task generic-method inference shape: `Enumerable.Select`'s
        // TResult is inferred from a lambda whose return is the enclosing type
        // parameter T (here bound to string).
        const source = `package i1512facetaselect
import System
import System.Collections.Generic
import System.Linq

class Box[T] {
    func Mapped(src List[int32], f (int32) -> T) IEnumerable[T] {
        return src.Select(f)
    }
}

func Main() {
    var b = Box[string]()
    var lst = List[int32]()
    lst.Add(3)
    lst.Add(4)
    var sum = 0
    for v in b.Mapped(lst, (x int32) -> "v" + x.ToString()) {
        System.Console.WriteLine(v)
    }
}`
        let output = CompileAndRun(source)
        Assert.Equal("v3${Environment.NewLine}v4${Environment.NewLine}", output)
    }

    @Fact
    func FacetB_GenericClosure_CapturesPrivateField_Int_Runs() {
        const source = `package i1512facetbint
import System

class Op[T] {
    private let fn (int32) -> T
    init(fn (int32) -> T) { this.fn = fn }
    func Use() (int32) -> T {
        let g = (x int32) -> fn(x)
        return g
    }
}

func Main() {
    var o = Op[int32]((x int32) -> x + 1)
    let h = o.Use()
    System.Console.WriteLine(h(5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func FacetB_GenericClosure_CapturesPrivateField_StructTypeArg_Runs() {
        // Generalizes Facet B to a user struct type argument (not int32): the
        // reified closure is constructed over `Pt` and still reaches the
        // enclosing generic class's private captured field.
        const source = `package i1512facetbstruct
import System

struct Pt(x int32) { }

class Holder[T] {
    private let make (int32) -> T
    init(make (int32) -> T) { this.make = make }
    func Build() (int32) -> T {
        let g = (n int32) -> make(n)
        return g
    }
}

func Main() {
    var h = Holder[Pt]((n int32) -> Pt(n * 2))
    let f = h.Build()
    var p = f(21)
    System.Console.WriteLine(p.x)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Combined_FacetA_And_FacetB_TogetherInOneType_Runs() {
        // Both root causes in one generic type: the captured private field `fn`
        // (Facet B) is invoked inside a lambda passed to `Task.ContinueWith`
        // whose TResult must infer to T (Facet A).
        const source = `package i1512combined
import System
import System.Threading.Tasks

class Op[T] {
    private let fn (Task) -> T
    var cont Task[T]?
    init(fn (Task) -> T) { this.fn = fn }
    func SetContinuation(readerTask Task) Task[T] {
        let r = readerTask.ContinueWith((t Task) -> fn(t))
        cont = r
        return r
    }
}

func Main() {
    var o = Op[int32]((t Task) -> 7)
    var r = o.SetContinuation(Task.CompletedTask)
    System.Console.WriteLine(r.Result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1512_exe_").FullName
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
