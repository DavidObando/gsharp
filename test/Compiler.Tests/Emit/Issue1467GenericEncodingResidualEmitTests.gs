// <copyright file="Issue1467GenericEncodingResidualEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1467 — residual cases where the enclosing CLASS generic type-parameter
/// was encoded with a named element-kind (`T0`) instead of the ordinal class
/// variable (`ELEMENT_TYPE_VAR !index`) in signature contexts that #1466
/// missed. The three shapes mirror the Oahu.Decrypt
/// `FrameFilterBase`1`/`FrameTransformBase`2` ilverify failures:
/// - Facet A — an array of the class type-parameter (`T[]`) used as a member of a NESTED generic type
/// and constructed inside an `async` method, where the array element token / nested-type member
/// signatures must encode `!0[]`.
/// - Facet B — `base.Dispose(disposing)` reaching a generic base from a non-generic derived leaf
/// through several non-generic intermediates, where the MemberRef declaring type must be the
/// CONSTRUCTED base instantiation, not the open `FrameFilterBase`1<!0>`.
/// - Facet C — an arity-2 state machine capturing the type-parameters across an `await`, with a
/// `Task.Run(InstanceMethod)` delegate, an `is`/`as` over an unconstrained type-parameter, and a
/// `base.M()` async call — all of which must encode the `this`/builder/ delegate-target/base-call
/// entities with ordinal class variables.
/// All three failed ilverify on current main and pass after the fix.
open class Issue1467GenericEncodingResidualEmitTests {
    @Fact
    func EndToEnd_FacetA_GenericArrayFieldInNestedTypeWithinAsync_Runs() {
        let source = `package Probe1467a
import System
import System.Threading.Tasks

open class BufferHolderA[T] {
    var buffer []T
    var pos int32 = 0

    func Init() {
        buffer = [4]T
    }

    open async func AddInputAsync(input T) {
        buffer[pos] = input
        pos = pos + 1
        await Task.CompletedTask
        var e = Entry(pos, buffer)
        buffer = [4]T
        Console.WriteLine(e.Count)
    }

    data struct Entry(Count int32, Items []T) { }
}

func Main() {
    var g = BufferHolderA[int32]()
    g.Init()
    g.AddInputAsync(7).Wait()
    Console.WriteLine("okA")
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}okA${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetB_BaseDisposeThroughNonGenericLeafChain_Runs() {
        let source = `package Probe1467b
import System

open class FilterBaseB[T] {
    protected var Disposed bool = false
    protected open func Dispose(disposing bool) {
        Disposed = true
    }
}
open class TransformBaseB[TIn, TOut] : FilterBaseB[TIn] {
    protected open override func Dispose(disposing bool) {
        if disposing && !Disposed {
            Console.WriteLine("transform dispose")
        }
        base.Dispose(disposing)
    }
}
open class ValidateFilterB : TransformBaseB[int32, int32] {
}
class LeafFilterB : ValidateFilterB {
    override func Dispose(disposing bool) {
        if disposing && !Disposed {
            Console.WriteLine("leaf dispose")
        }
        base.Dispose(disposing)
    }
}
func Main() {
    var f = LeafFilterB()
    f.Dispose(true)
    Console.WriteLine("okB")
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "leaf dispose${Environment.NewLine}transform dispose${Environment.NewLine}okB${Environment.NewLine}",
            output
        )
    }

    @Fact
    func EndToEnd_FacetC_Arity2StateMachineDelegateAndBaseCall_Runs() {
        let source = `package Probe1467c

import System
import System.Threading
import System.Threading.Tasks

open class FilterC[TInput]() {
    private var filterLoop Task?
    private var cancellationToken CancellationToken

    open async func AddInputAsync(input TInput) {
        filterLoop ??= Task.Run(Encoder, cancellationToken)
        await Task.CompletedTask
    }

    protected open func FlushAsync() Task;
    protected open func HandleInputDataAsync(input TInput) Task;

    protected open async func CompleteInternalAsync() {
        await Task.CompletedTask
        if filterLoop != nil {
            await filterLoop
        }
    }

    private async func Encoder() {
        await FlushAsync()
    }
}

open class TransformC[TInput, TOutput] : FilterC[TInput] {
    private var linked FilterC[TOutput]?

    func LinkTo(nextFilter FilterC[TOutput]) -> linked = nextFilter
    protected open func PerformFinalFiltering() TOutput? -> default

    protected override async func FlushAsync() {
        if PerformFinalFiltering() is TOutput && linked != nil {
            await linked!!.AddInputAsync((PerformFinalFiltering() as TOutput)!!)
        }
    }

    protected override async func HandleInputDataAsync(input TInput) {
        await Task.CompletedTask
    }

    protected override async func CompleteInternalAsync() {
        await base.CompleteInternalAsync()
    }

    open async func RunAsync() {
        await CompleteInternalAsync()
    }
}

func Main() {
    var t = TransformC[int32, int32]()
    t.RunAsync().Wait()
    Console.WriteLine("okC")
}`
        let output = CompileAndRun(source)
        Assert.Equal("okC${Environment.NewLine}", output)
    }

    @Fact
    func Issue2785_GenericExtensionDelegateTypeSpecUsesMethodParameters() {
        let source = `package Probe2785
import System
import System.Collections.Generic
import System.Linq

func (source IEnumerable[TSource]) Flat[TSource, TResult](selector (TSource) -> IEnumerable[TResult]) IEnumerable[IEnumerable[TResult]] {
    return source.Select((s TSource) -> selector(s)).ToArray()
}

func Main() {
    var result = [2]int32{1, 2}.Flat((x int32) -> [2]int32{x, x + 1})
    var total int32
    for values in result {
        for value in values {
            total += value
        }
    }
    Console.WriteLine(total)
}`
        let output = CompileAndRun(source)
        Assert.Equal("8${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1467_exe_").FullName
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
