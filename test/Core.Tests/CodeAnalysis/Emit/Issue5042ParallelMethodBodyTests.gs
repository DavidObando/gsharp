package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import Xunit

class Issue5042ParallelMethodBodyTests {
    @Fact
    func MethodInstructionsRunConcurrentlyAfterBindingAndPreserveAllOutputBytes() {
        let source = "package ParallelEmit\n" + IndependentFunctions() + IndependentLambdas() + `
func LambdaHost() int32 {
    let first = func(x int32) int32 {
        if x > 0 { return x + 1 }
        return 0
    }
    let second = func(x int32) int32 {
        if x > 0 { return x * 2 }
        return 0
    }
    return first(2) + second(3)
}
`
        var implementation[]uint8 = Array.Empty[uint8]()
        var reference[]uint8 = Array.Empty[uint8]()
        var symbols[]uint8 = Array.Empty[uint8]()
        for workers in[]int32{1, 2, 4, 8, 4, 2} {
            let compilation = Create(source)
            let _ = compilation.BoundProgram
            compilation.WorkBudget = CompilationWorkBudget(workers)
            using let measurement = CompilationMeasurements.Start("parallel-emit-test")
            using let pe = MemoryStream()
            using let pdb = MemoryStream()
            using let refPe = MemoryStream()
            let result = compilation.Emit(pe, pdb, refPe, docStream: nil, assemblyName: "ParallelEmit")
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.ToString())))
            Assert.Empty(result.Diagnostics)
            if workers == 1 {
                implementation = pe.ToArray()
                reference = refPe.ToArray()
                symbols = pdb.ToArray()
                Assert.NotEmpty(implementation)
                Assert.NotEmpty(reference)
                Assert.NotEmpty(symbols)
            } else {
                Assert.Equal(implementation, pe.ToArray())
                Assert.Equal(reference, refPe.ToArray())
                Assert.Equal(symbols, pdb.ToArray())
                if compilation.WorkBudget.MaxWorkers > 1 {
                    Assert.True(measurement.GetCounter("emit.method-bodies.completed") >= 64)
                    Assert.True(measurement.GetCounter("emit.method-bodies.il-bytes") > 10000)
                    Assert.True(measurement.GetCounter("emit.method-bodies.parallel-batches") > 0)
                    Assert.True(measurement.GetCounter("lowering.emit-lambdas.completed") >= 2)
                    Assert.True(measurement.GetCounter("lowering.emit-lambdas.parallel-batches") > 0)
                }
            }
            let assembly = EmittedFixture.Load(pe.ToArray())
            let type = assembly.GetType("ParallelEmit.<Program>", throwOnError: true)!!
            const flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            Assert.Equal(6055, type.GetMethod("F63", flags)!!.Invoke(nil, []object{7}))
            Assert.Equal(9, type.GetMethod("LambdaHost", flags)!!.Invoke(nil, nil))
        }
    }

    @Theory
    @InlineData(DebugInformationFormat.Portable)
    @InlineData(DebugInformationFormat.Embedded)
    func InitializersClosuresGenericsSuspensionByRefAndExceptionsRemainDeterministic(format DebugInformationFormat) {
        let source = `package ParallelEmit
import System
import System.Collections.Generic
import System.Threading.Tasks
class State {
    var Value int32 = (func() int32 { return 3 })()
    init() { Value += 1 }
    shared {
        var Seed int32 = (func() int32 { return 7 })()
        init { Seed += 1 }
    }
    func Read() int32 -> Value + Seed
    func Pure(x int32) int32 -> x + 1
}
func Identity[T](value T) T -> value
func Values() sequence[int32] {
    try { yield 2 } finally { let final = 3 }
}
async func Answer() int32 {
    await Task.Yield()
    return 6
}
func AsyncValues() IAsyncEnumerable[int32] {
    yield 5
    await Task.Yield()
    yield 7
}
func Run() int32 {
    var parsed = 0
    Int32.TryParse("4", &parsed)
    var captured = 1
    let next = func() int32 { captured += 1
        return captured }
    var total = 0
    for value in Values() { total += value }
    try { return State().Read() + State().Pure(5) + Identity(parsed) + next() + total + Answer().GetAwaiter().GetResult() }
    finally { total += 10 }
}
` + IndependentFunctions()
        var implementation[]uint8 = Array.Empty[uint8]()
        var reference[]uint8 = Array.Empty[uint8]()
        var symbols[]uint8 = Array.Empty[uint8]()
        for workers in[]int32{1, 2, 4, 8} {
            let compilation = Create(source, format)
            compilation.WorkBudget = CompilationWorkBudget(workers)
            using let pe = MemoryStream()
            using let pdb = MemoryStream()
            using let refPe = MemoryStream()
            let result = compilation.Emit(pe, pdb, refPe, docStream: nil, assemblyName: "ParallelEmit")
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.ToString())))
            if workers == 1 {
                implementation = pe.ToArray()
                reference = refPe.ToArray()
                symbols = pdb.ToArray()
            } else {
                Assert.Equal(implementation, pe.ToArray())
                Assert.Equal(reference, refPe.ToArray())
                Assert.Equal(symbols, pdb.ToArray())
            }
            let assembly = EmittedFixture.Load(pe.ToArray())
            let method = assembly.GetType("ParallelEmit.<Program>", true)!!.GetMethod(
                "Run",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )!!
            Assert.Equal(32, method.Invoke(nil, nil))
            let stream = cast[IAsyncEnumerable[int32]](
                assembly.GetType("ParallelEmit.<Program>", true)!!.GetMethod(
                    "AsyncValues",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )!!.Invoke(nil, nil)
            )
            let enumerator = stream.GetAsyncEnumerator()
            let values = List[int32]()
            try {
                while enumerator.MoveNextAsync().AsTask().GetAwaiter().GetResult() {
                    values.Add(enumerator.Current)
                }
            } finally {
                enumerator.DisposeAsync().AsTask().GetAwaiter().GetResult()
            }
            Assert.Equal([]int32{5, 7}, values)
            using let refOnly = MemoryStream()
            let refResult = compilation.Emit(
                peStream: nil,
                pdbStream: nil,
                refStream: refOnly,
                docStream: nil,
                assemblyName: "ParallelEmit"
            )
            Assert.True(refResult.Success)
            Assert.Equal(reference, refOnly.ToArray())
        }
    }

    @Fact
    func CancellationBeforeEmitDoesNotPublishAnyOutput() {
        let compilation = Create("package ParallelEmit\n" + IndependentFunctions())
        let _ = compilation.BoundProgram
        using let cancellation = CancellationTokenSource()
        compilation.WorkBudget = CompilationWorkBudget(4, cancellationToken: cancellation.Token)
        cancellation.Cancel()
        using let pe = MemoryStream()
        using let pdb = MemoryStream()
        using let reference = MemoryStream()
        Assert.Throws[OperationCanceledException](
            () -> compilation.Emit(pe, pdb, reference, docStream: nil, assemblyName: "ParallelEmit")
        )
        Assert.Equal(0, pe.Length)
        Assert.Equal(0, pdb.Length)
        Assert.Equal(0, reference.Length)
    }

    @Theory
    @InlineData(DebugInformationFormat.None)
    @InlineData(DebugInformationFormat.Portable)
    func NoPdbRequestRetainsNoSequencePointBuffers(format DebugInformationFormat) {
        let compilation = Create("package ParallelEmit\n" + IndependentFunctions(), format)
        let _ = compilation.BoundProgram
        compilation.WorkBudget = CompilationWorkBudget(4)
        using let measurement = CompilationMeasurements.Start("no-pdb-buffer-test")
        using let pe = MemoryStream()
        let result = compilation.Emit(pe, pdbStream: nil, refStream: nil, docStream: nil, assemblyName: "NoPdb")
        Assert.True(result.Success)
        Assert.NotEmpty(pe.ToArray())
        if compilation.WorkBudget.MaxWorkers > 1 {
            Assert.True(measurement.GetCounter("emit.method-bodies.completed") >= 64)
            Assert.Equal(0, measurement.GetCounter("emit.method-bodies.buffered-sequence-points"))
        }
    }

    @Fact
    func CancellationDuringPublicationCommitsAllRequestedArtifacts() {
        let source = "package ParallelEmit\n" + IndependentFunctions()
        using let expectedPe = MemoryStream()
        using let expectedPdb = MemoryStream()
        using let expectedReference = MemoryStream()
        using let expectedDocumentation = MemoryStream()
        let baseline = Create(source)
        baseline.WorkBudget = CompilationWorkBudget(4)
        Assert.True(
            baseline.Emit(expectedPe, expectedPdb, expectedReference, expectedDocumentation, assemblyName: "AtomicEmit")
                .Success
        )
        using let cancellation = CancellationTokenSource()
        let compilation = Create(source)
        compilation.WorkBudget = CompilationWorkBudget(4, cancellationToken: cancellation.Token)
        using let pe = CancelOnWriteStream(cancellation)
        using let pdb = MemoryStream()
        using let reference = MemoryStream()
        using let documentation = MemoryStream()
        let result = compilation.Emit(pe, pdb, reference, documentation, assemblyName: "AtomicEmit")
        Assert.True(result.Success)
        Assert.True(cancellation.IsCancellationRequested)
        Assert.NotEmpty(expectedPe.ToArray())
        Assert.NotEmpty(expectedPdb.ToArray())
        Assert.NotEmpty(expectedReference.ToArray())
        Assert.NotEmpty(expectedDocumentation.ToArray())
        Assert.Equal(expectedPe.ToArray(), pe.ToArray())
        Assert.Equal(expectedPdb.ToArray(), pdb.ToArray())
        Assert.Equal(expectedReference.ToArray(), reference.ToArray())
        Assert.Equal(expectedDocumentation.ToArray(), documentation.ToArray())
    }

    private class CancelOnWriteStream : MemoryStream {
        private let cancellation CancellationTokenSource

        init(cancellation CancellationTokenSource) {
            this.cancellation = cancellation
        }

        override func Write(buffer[]uint8, offset int32, count int32) {
            base.Write(buffer, offset, count)
            this.cancellation.Cancel()
        }
    }

    shared {
        private func Create(
            source string,
            format DebugInformationFormat = DebugInformationFormat.Portable
        ) Compilation -> Compilation(SyntaxTree.Parse(SourceText.From(source, "parallel.gs"))){
            DebugInformation = DebugInformationOptions{Format: format, Deterministic: true, PdbFilePath: "parallel.pdb"}
        }

        private func IndependentFunctions() string -> string.Concat(
            Enumerable.Range(0, 64).Select(
                (index int32) -> "func F$index(x int32) int32 {\nvar result = x\n" + string.Concat(
                    Enumerable.Range(0, 96).Select((_ int32) -> "result = result + $index\n")
                ) +
                    "return result\n}\n"
            )
        )

        private func IndependentLambdas() string -> "func LoweringHost() {\n" + string.Concat(
            Enumerable.Range(0, 32).Select(
                (index int32) ->
                "let f$index = func(x int32) int32 {\n" + string.Concat(
                    Enumerable.Range(0, 64).Select(
                        (value int32) ->
                        "if x < -$value { return $value }\n"
                    )
                ) +
                    "return x\n}\n"
            )
        ) +
            "}\n"
    }
}
