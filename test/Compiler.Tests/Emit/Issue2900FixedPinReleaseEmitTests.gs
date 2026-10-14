// <copyright file="Issue2900FixedPinReleaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2900: every exit from a `fixed` body must run a finally handler
/// that clears the pinned local.
open class Issue2900FixedPinReleaseEmitTests {
    @Fact
    func BranchExits_UseLeaveThroughFinally_AndRun() {
        const Source = `package Issue2900.Branches
import System

func BreakOut(xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                break
            }
        }
    }
    return 1
}

func ContinueOut(xs []int32) int32 {
    var i = 0
    unsafe {
        for i < 3 {
            fixed p *int32 = xs {
                i = i + 1
                continue
            }
        }
    }
    return i
}

func GotoOut(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            goto done
        }
    }
    return -1
done:
    return 3
}

func NestedBreakOut(xs []int32) int32 {
    unsafe {
        outer: for {
            fixed p *int32 = xs {
                fixed q *int32 = xs {
                    break outer
                }
            }
        }
    }
    return 4
}

func NestedContinueOut(xs []int32) int32 {
    var i = 0
    unsafe {
        outer: for i < 2 {
            fixed p *int32 = xs {
                fixed q *int32 = xs {
                    i = i + 1
                    continue outer
                }
            }
        }
    }
    return i
}

func Main() {
    var xs = []int32{1}
    Console.WriteLine(BreakOut(xs))
    Console.WriteLine(ContinueOut(xs))
    Console.WriteLine(GotoOut(xs))
    Console.WriteLine(NestedBreakOut(xs))
    Console.WriteLine(NestedContinueOut(xs))
}`
        using let program = Compile(Source, "branches")
        Assert.Equal(
            "1${Environment.NewLine}3${Environment.NewLine}3${Environment.NewLine}4${Environment.NewLine}2${Environment.NewLine}",
            program.Run()
        )
        AssertEscapingLeave(program.ReadMethod("BreakOut"), expectedFinallyCount: 1)
        AssertEscapingLeave(program.ReadMethod("ContinueOut"), expectedFinallyCount: 1)
        AssertEscapingLeave(program.ReadMethod("GotoOut"), expectedFinallyCount: 1)
        let nested = program.ReadMethod("NestedBreakOut")
        let nestedRegions = nested
            .Regions
            .Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            .ToArray()
        Assert.Equal(2, nestedRegions.Length)
        let inner = nestedRegions.OrderBy((region ExceptionRegion) -> region.TryLength).First()
        let outer = nestedRegions.OrderByDescending((region ExceptionRegion) -> region.TryLength).First()
        Assert.True(Contains(outer, inner), "Inner fixed region must be nested inside outer fixed region.")
        Assert.Contains(
            nested.Instructions,
            (instruction IlInstruction) -> IsLeave(instruction.OpCode) &&
                IsInside(instruction.Offset, inner) &&
                instruction.BranchTarget >= outer.HandlerOffset +
                outer.HandlerLength
        )
        Assert.Equal(2, nestedRegions.Count((region ExceptionRegion) -> IsCleanupHandler(nested, region)))
        let nestedContinue = program.ReadMethod("NestedContinueOut")
        let continueRegions = nestedContinue
            .Regions
            .Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            .ToArray()
        Assert.Equal(2, continueRegions.Length)
        let continueInner = continueRegions.OrderBy((region ExceptionRegion) -> region.TryLength).First()
        let continueOuter = continueRegions.OrderByDescending((region ExceptionRegion) -> region.TryLength).First()
        Assert.Contains(
            nestedContinue.Instructions,
            (instruction IlInstruction) -> IsLeave(instruction.OpCode) &&
                IsInside(instruction.Offset, continueInner) &&
                instruction.BranchTarget >= continueOuter.HandlerOffset +
                continueOuter.HandlerLength
        )
        Assert.Equal(2, continueRegions.Count((region ExceptionRegion) -> IsCleanupHandler(nestedContinue, region)))
    }

    @Fact
    func ReturnAndThrow_RunProtectedCleanup_AndRun() {
        const Source = `package Issue2900.ReturnThrow
import System

class Box {
    public var Value int32
    public var Marker int32 = 5

    init(xs []int32) {
        unsafe {
            fixed p *int32 = xs {
                Value = *p
                return
            }
        }
        Value = -1
    }
}

class Finalizable {
    deinit {
        var xs = []int32{1}
        unsafe {
            fixed p *int32 = xs {
                return
            }
        }
    }
}

func ComputedReturn(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            return p[0] + p[1]
        }
    }
}

func ThrowOut(xs []int32) int32 {
    try {
        unsafe {
            fixed p *int32 = xs {
                throw InvalidOperationException("boom")
            }
        }
    } catch (ex InvalidOperationException) {
        return 9
    }
}

func VoidReturn(xs []int32) {
    unsafe {
        fixed p *int32 = xs {
            Console.WriteLine("void")
            return
        }
    }
}

func MixedReturn(xs []int32, fromFixed bool) int32 {
    if fromFixed {
        unsafe {
            fixed p *int32 = xs {
                return *p
            }
        }
    }

    return 2
}

func Main() {
    var xs = []int32{20, 22}
    let box = Box(xs)
    let finalizable = Finalizable{}
    Console.WriteLine(ComputedReturn(xs))
    Console.WriteLine(ThrowOut(xs))
    VoidReturn(xs)
    Console.WriteLine(box.Value)
    Console.WriteLine(box.Marker)
    Console.WriteLine(MixedReturn(xs, true))
    Console.WriteLine(MixedReturn(xs, false))
    GC.KeepAlive(finalizable)
}`
        using let program = Compile(
            Source,
            "return_throw",
            ignoredErrorScope: "(Box\\.\\.ctor|<Program>\\.(ComputedReturn|MixedReturn))$$"
        )
        Assert.Equal(
            "42${Environment.NewLine}9${Environment.NewLine}void${Environment.NewLine}20${Environment.NewLine}5${Environment.NewLine}20${Environment.NewLine}2${Environment.NewLine}",
            program.Run()
        )
        let returned = program.ReadMethod("ComputedReturn")
        AssertEscapingLeave(returned, expectedFinallyCount: 1)
        Assert.Contains(returned.Instructions, (instruction IlInstruction) -> IsLeave(instruction.OpCode))
        let thrown = program.ReadMethod("ThrowOut")
        let fixedRegion = Assert.Single(
            thrown.Regions,
            (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally
        )
        Assert.Contains(
            thrown.Instructions,
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Throw &&
                IsInside(instruction.Offset, fixedRegion)
        )
        AssertCleanupHandlers(thrown)
        AssertEscapingLeave(program.ReadMethod("VoidReturn"), expectedFinallyCount: 1)
        AssertEscapingLeave(program.ReadMethod("MixedReturn"), expectedFinallyCount: 1)
        let finalizer = program.ReadMethod("Finalize")
        Assert.Equal(2, finalizer.Regions.Count((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally))
        Assert.Contains(finalizer.Instructions, (instruction IlInstruction) -> IsLeave(instruction.OpCode))
        AssertCleanupHandlers(finalizer)
    }

    @Fact
    func StaticInitializerReturn_UsesSharedFixedEpilogue_AndRuns() {
        const Source = `package Issue2900.StaticInitializer
import System

class Holder {
    shared {
        var Total int32 = 0

        init {
            var xs = []int32{41}
            unsafe {
                fixed p *int32 = xs {
                    Total = *p
                    return
                }
            }
            Total = -1
        }
    }
}

func Main() {
    Console.WriteLine(Holder.Total)
}`
        using let program = Compile(Source, "static_initializer", ignoredErrorScope: "Holder\\.\\.cctor$$")
        Assert.Equal("41${Environment.NewLine}", program.Run())
        AssertEscapingLeave(program.ReadMethod(".cctor"), expectedFinallyCount: 1)
    }

    @Fact
    func EarlyBreak_ReleasesPinBeforeCompactingGc() {
        const Source = `package Issue2900.Movement
import System

func Released() bool {
    for var attempt = 0; attempt < 8; attempt++ {
        var xs = []uint8{uint8(1), uint8(2), uint8(3)}
        var before nint = 0
        unsafe {
            for {
                fixed p *uint8 = xs {
                    before = nint(p)
                    break
                }
            }
        }

        for var i = 0; i < 20000; i++ {
            var garbage = []uint8{uint8(4), uint8(5), uint8(6)}
            GC.KeepAlive(garbage)
        }
        GC.Collect(2, GCCollectionMode.Aggressive, true, true)
        GC.WaitForPendingFinalizers()

        unsafe {
            fixed p *uint8 = xs {
                if before != nint(p) {
                    return true
                }
            }
        }
    }

    return false
}

func Main() {
    Console.WriteLine(Released())
}`
        using let program = Compile(Source, "movement", ignoredErrorScope: "<Program>\\.Released$$")
        Assert.Equal("True${Environment.NewLine}", program.Run())
        let method = program.ReadMethod("Released")
        let regions = method
            .Regions
            .Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            .ToArray()
        Assert.Equal(2, regions.Length)
        Assert.Contains(
            regions,
            (region ExceptionRegion) -> method.Instructions.Count(
                (instruction IlInstruction) -> IsLeave(instruction.OpCode) &&
                    IsInside(instruction.Offset, region) &&
                    instruction.BranchTarget >= region.HandlerOffset +
                    region.HandlerLength
            ) >= 2
        )
        AssertCleanupHandlers(method)
    }

    @Fact
    func PinKinds_ZeroLengthAndNestedConstructs_VerifyAndRun() {
        const Source = `package Issue2900.Shapes
import System

public var trace = ""

class Resource : IDisposable {
    func Dispose() {
        trace = trace + "U"
    }
}

func ArrayPin(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            return *p
        }
    }
}

func FixedArrayPin(xs [1]int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            return *p
        }
    }
}

func EmptyPin(xs []int32) nint {
    unsafe {
        fixed p *int32 = xs {
            return nint(p)
        }
    }
}

func StringPin(s string) int32 {
    unsafe {
        fixed p *uint16 = s {
            return int32(*p)
        }
    }
}

func SpanPin(xs []int32) int32 {
    var span Span[int32] = xs
    unsafe {
        fixed p *int32 = span {
            return *p
        }
    }
}

func TryInsideFixed(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            try {
                return *p
            } finally {
                trace = trace + "T"
            }
        }
    }
}

func FixedInCatchAndFinally(xs []int32) {
    try {
        throw InvalidOperationException("x")
    } catch (ex InvalidOperationException) {
        unsafe {
            fixed p *int32 = xs {
                trace = trace + "C"
            }
        }
    } finally {
        unsafe {
            fixed p *int32 = xs {
                trace = trace + "F"
            }
        }
    }
}

func FixedInsideTry(xs []int32) int32 {
    try {
        unsafe {
            fixed p *int32 = xs {
                return *p
            }
        }
    } finally {
        trace = trace + "R"
    }
}

func ScopeUsingSwitchSelect(xs []int32) {
    scope {
        unsafe {
            fixed p *int32 = xs {
                trace = trace + "S"
            }
        }
    }
    {
        using let resource = Resource{}
        unsafe {
            fixed p *int32 = xs {
                trace = trace + "G"
            }
        }
    }
    switch xs[0] {
        case 7 {
            unsafe {
                fixed p *int32 = xs {
                    trace = trace + "W"
                }
            }
        }
    }
    let ch = chan[int32](1)
    ch <- 1
    select {
        case let value = <-ch {
            unsafe {
                fixed p *int32 = xs {
                    trace = trace + value.ToString()
                }
            }
        }
    }
}

func BreakFromSwitchAndSelect(xs []int32) {
    switchLoop: for {
        switch xs[0] {
            case 7 {
                unsafe {
                    fixed p *int32 = xs {
                        trace = trace + "B"
                        break switchLoop
                    }
                }
                trace = trace + "X"
            }
        }
    }
    let ch = chan[int32](1)
    ch <- 1
    selectLoop: for {
        select {
            case let value = <-ch {
                unsafe {
                    fixed p *int32 = xs {
                        trace = trace + "L"
                        break selectLoop
                    }
                }
                trace = trace + value.ToString()
            }
        }
    }
    trace = trace + "E"
}

var xs = []int32{7}
Console.WriteLine(ArrayPin(xs))
Console.WriteLine(FixedArrayPin([1]int32{8}))
Console.WriteLine(EmptyPin([]int32{}))
Console.WriteLine(StringPin("A"))
Console.WriteLine(SpanPin(xs))
Console.WriteLine(TryInsideFixed(xs))
Console.WriteLine(FixedInsideTry(xs))
FixedInCatchAndFinally(xs)
BreakFromSwitchAndSelect(xs)
ScopeUsingSwitchSelect(xs)
Console.WriteLine(trace)`
        using let program = Compile(
            Source,
            "shapes",
            ignoredErrorScope: "<Program>\\.(ArrayPin|FixedArrayPin|EmptyPin|StringPin|SpanPin|TryInsideFixed|FixedInsideTry)$$"
        )
        Assert.Equal(
            "7${Environment.NewLine}8${Environment.NewLine}0${Environment.NewLine}65${Environment.NewLine}7${Environment.NewLine}7${Environment.NewLine}7${Environment.NewLine}TRCFBLESGUW1${Environment.NewLine}",
            program.Run()
        )
        let spanPin = program.ReadMethod("SpanPin")
        let spanCleanup = Assert.Single(
            spanPin.Regions,
            (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally
        )
        let spanHandler = spanPin
            .Instructions
            .Where(
            (instruction IlInstruction) -> instruction.Offset >= spanCleanup.HandlerOffset &&
                instruction.Offset < spanCleanup.HandlerOffset +
                spanCleanup.HandlerLength
        )
            .ToArray()
        Assert.Equal(OpCodes.Ldc_I4_0, spanHandler[0].OpCode)
        Assert.Equal(OpCodes.Conv_U, spanHandler[1].OpCode)
        for methodName in[]string{
            "ArrayPin",
            "FixedArrayPin",
            "EmptyPin",
            "StringPin",
            "SpanPin",
            "TryInsideFixed",
            "FixedInsideTry",
            "FixedInCatchAndFinally",
            "BreakFromSwitchAndSelect",
            "ScopeUsingSwitchSelect"
        } {
            let method = program.ReadMethod(methodName)
            Assert.Contains(method.Regions, (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            AssertCleanupHandlers(method)
        }
    }

    @Fact
    func SwitchArmReturn_UsesSharedFixedEpilogue_AndRuns() {
        const Source = `package Issue2900.SwitchReturn
import System

func FromSwitch(xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            switch xs[0] {
                case 7 {
                    return *p + 1
                }
            }
        }
    }
    return -1
}

func Main() {
    Console.WriteLine(FromSwitch([]int32{7}))
}`
        using let program = Compile(Source, "switch_return", ignoredErrorScope: "<Program>\\.FromSwitch$$")
        Assert.Equal("8${Environment.NewLine}", program.Run())
        AssertEscapingLeave(program.ReadMethod("FromSwitch"), expectedFinallyCount: 1)
    }

    @Fact
    func SelectArmReturn_UsesSharedFixedEpilogue_AndRuns() {
        const Source = `package Issue2900.SelectReturn
import System

func FromSelect(xs []int32) int32 {
    let ch = chan[int32](1)
    ch <- 2
    unsafe {
        fixed p *int32 = xs {
            select {
                case let value = <-ch {
                    return *p + value
                }
            }
        }
    }
    return -1
}

func Main() {
    Console.WriteLine(FromSelect([]int32{7}))
}`
        using let program = Compile(Source, "select_return", ignoredErrorScope: "<Program>\\.FromSelect$$")
        Assert.Equal("9${Environment.NewLine}", program.Run())
        // Two regions since ADR-0174 D8: the select's own `finally`, which
        // returns its waiter, nested inside the one shared `fixed` epilogue.
        // A regression that duplicated the unpin per exit path would show three.
        // Only the epilogue carries the escaping `return`, so only it is checked
        // for the body-exit-plus-fallthrough pair.
        let fromSelect = program.ReadMethod("FromSelect")
        let selectFinallys = fromSelect
            .Regions
            .Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
            .OrderByDescending((region ExceptionRegion) -> region.TryLength)
            .ToArray()
        Assert.Equal(2, selectFinallys.Length)
        AssertEscapingLeaveInRegion(fromSelect, selectFinallys[0])
        AssertCleanupHandlers(fromSelect)
    }

    @Fact
    func AsyncAndIterator_WithLaterSuspension_VerifyAndRun() {
        const Source = `package Issue2900.StateMachines
import System
import System.Threading.Tasks

async func AfterFixed() Task[int32] {
    var xs = []int32{10}
    var value = 0
    unsafe {
        fixed p *int32 = xs {
            value = *p
        }
    }
    await Task.Yield()
    return value + 1
}

async func ReturnFromFixed(fromFixed bool) Task[int32] {
    var xs = []int32{10}
    if fromFixed {
        unsafe {
            fixed p *int32 = xs {
                return *p
            }
        }
    }
    await Task.Yield()
    return 12
}

func Values(xs []int32) sequence[int32] {
    var value = 0
    unsafe {
        fixed p *int32 = xs {
            value = *p
        }
    }
    yield value
    yield value + 1
}

func Main() {
    var xs = []int32{10}
    Console.WriteLine(AfterFixed().Result)
    Console.WriteLine(ReturnFromFixed(true).Result)
    Console.WriteLine(ReturnFromFixed(false).Result)
    for value in Values(xs) {
        Console.WriteLine(value)
    }
}`
        using let program = Compile(
            Source,
            "state_machines",
            ignoredErrorScope: "<(Values|AfterFixed|ReturnFromFixed)>d__\\d+\\.MoveNext$$"
        )
        Assert.Equal(
            "11${Environment.NewLine}10${Environment.NewLine}12${Environment.NewLine}10${Environment.NewLine}11${Environment.NewLine}",
            program.Run()
        )
        Assert.True(
            program.ReadAllMethods().Any(
                (method MethodIl) -> method.Regions.Any(
                    (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally
                ) &&
                    method
                    .Instructions
                    .Any((instruction IlInstruction) -> instruction.OpCode == OpCodes.Endfinally)
            ),
            "State-machine bodies must retain fixed cleanup regions."
        )
    }

    @Fact
    func SuspensionInsideFixed_ReportsGs0506_ButNestedLambdaIsAllowed() {
        const InvalidSource = `package Issue2900.SuspensionErrors
import System.Threading.Tasks

async func AwaitDirect() Task[int32] {
    var xs = []int32{1}
    unsafe {
        fixed p *int32 = xs {
            await Task.Yield()
        }
    }
    return 1
}

async func AwaitNested() Task[int32] {
    var xs = []int32{1}
    unsafe {
        fixed p *int32 = xs {
            fixed q *int32 = xs {
                await Task.Yield()
            }
        }
    }
    return 1
}

func YieldDirect() sequence[int32] {
    var xs = []int32{2}
    unsafe {
        fixed p *int32 = xs {
            yield *p
        }
    }
}`
        let diagnostics = CompileErrors(InvalidSource, "suspension_errors")
        Assert.Equal(3, diagnostics.Split("GS0506").Length - 1)
        Assert.Contains("'await' cannot appear inside a 'fixed' statement", diagnostics)
        Assert.Contains("'yield' cannot appear inside a 'fixed' statement", diagnostics)
        const ValidSource = `package Issue2900.NestedLambda
import System
import System.Threading.Tasks

func Main() {
    var xs = []int32{1}
    unsafe {
        fixed p *int32 = xs {
            let work = async () -> {
                await Task.Yield()
                return 7
            }
            Console.WriteLine(work().Result)
        }
    }
}`
        using let program = Compile(ValidSource, "nested_lambda")
        Assert.Equal("7${Environment.NewLine}", program.Run())
    }

    @Fact
    func SuspensionInsideFixed_AwaitForReportsGs0506() {
        const Source = `package Issue2900.AwaitForError
import System.Collections.Generic

async func Source() IAsyncEnumerable[int32] {
    yield 1
}

async func Run() {
    var xs = []int32{1}
    unsafe {
        fixed p *int32 = xs {
            await for item in Source() {
            }
        }
    }
}`
        let diagnostics = CompileErrors(Source, "await_for_error")
        Assert.Equal(1, diagnostics.Split("GS0506").Length - 1)
        Assert.Contains("'await' cannot appear inside a 'fixed' statement", diagnostics)
    }

    @Fact
    func SuspensionInsideFixed_AwaitUsingReportsGs0506() {
        const Source = `package Issue2900.AwaitUsingError
import System
import System.Threading.Tasks

class Resource : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        return ValueTask.CompletedTask
    }
}

async func Run() {
    var xs = []int32{1}
    unsafe {
        fixed p *int32 = xs {
            await using let resource = Resource{}
        }
    }
}`
        let diagnostics = CompileErrors(Source, "await_using_error")
        Assert.Equal(1, diagnostics.Split("GS0506").Length - 1)
        Assert.Contains("'await' cannot appear inside a 'fixed' statement", diagnostics)
    }

    private class CompiledProgram : IDisposable {
        private let directory string

        init(directory string, assemblyPath string) {
            this.directory = directory
            AssemblyPath = assemblyPath
        }

        prop AssemblyPath string {
            get;
        }

        func Run() string {
            using let process = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(AssemblyPath, ".runtimeconfig.json"),
                        AssemblyPath
                    },
                    WorkingDirectory = this.directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )!!
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("dotnet exec timed out")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `:
` + "$stderr"))
            return stdout
        }

        func ReadMethod(methodName string) MethodIl {
            return Assert.Single(ReadAllMethods(), (method MethodIl) -> method.Name == methodName)
        }

        func ReadAllMethods()[]MethodIl {
            using let stream = File.OpenRead(AssemblyPath)
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            return metadata
                .MethodDefinitions
                .Select(
                (handle MethodDefinitionHandle) -> Issue2900FixedPinReleaseEmitTests.ReadMethod(pe, metadata, handle)
            )
                .ToArray()
        }

        func Dispose() {
            try {
                Directory.Delete(this.directory, recursive: true)
            } catch { }
        }
    }

    private data class MethodIl(Name string, Instructions[]IlInstruction, Regions[]ExceptionRegion) : IEquatable[
        MethodIl
    ] { }

    shared {
        private let FixedIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        private func AssertEscapingLeave(method MethodIl, expectedFinallyCount int32) {
            let regions = method
                .Regions
                .Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally)
                .ToArray()
            Assert.Equal(expectedFinallyCount, regions.Length)
            for region in regions {
                AssertEscapingLeaveInRegion(method, region)
            }
            AssertCleanupHandlers(method)
        }

        private func AssertEscapingLeaveInRegion(method MethodIl, region ExceptionRegion) {
            Assert.True(
                method.Instructions.Count(
                    (instruction IlInstruction) -> IsLeave(instruction.OpCode) &&
                        IsInside(instruction.Offset, region) &&
                        instruction.BranchTarget >= region.HandlerOffset +
                        region.HandlerLength
                ) >= 2,
                "Expected body exit plus normal fallthrough leave in ${method.Name}."
            )
        }

        private func AssertCleanupHandlers(method MethodIl) {
            Assert.Contains(
                method.Regions,
                (region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Finally &&
                    IsCleanupHandler(method, region)
            )
        }

        private func IsCleanupHandler(method MethodIl, region ExceptionRegion) bool {
            let handler = method
                .Instructions
                .Where(
                (instruction IlInstruction) -> instruction.Offset >= region.HandlerOffset &&
                    instruction.Offset < region.HandlerOffset +
                    region.HandlerLength
            )
                .ToArray()
            return handler.Any(
                (instruction IlInstruction) -> instruction.OpCode.Name!!.StartsWith("stloc", StringComparison.Ordinal)
            ) &&
                handler[^1].OpCode == OpCodes.Endfinally
        }

        private func Contains(
            outer ExceptionRegion,
            inner ExceptionRegion
        ) bool -> outer.TryOffset <= inner.TryOffset &&
            outer.TryOffset +
            outer.TryLength >= inner.HandlerOffset +
            inner.HandlerLength

        private func IsInside(offset int32, region ExceptionRegion) bool -> offset >= region.TryOffset &&
            offset < region.TryOffset +
            region.TryLength

        private func IsLeave(opcode OpCode) bool -> opcode == OpCodes.Leave || opcode == OpCodes.Leave_S

        private func Compile(
            source string,
            tag string,
            ignoredErrorScope string? = nil
        ) Issue2900FixedPinReleaseEmitTests
            .CompiledProgram {
            let directory = Directory.CreateTempSubdirectory("gs_i2900_${tag}_").FullName
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            IlVerifier.Verify(
                assemblyPath,
                additionalReferences: nil,
                ignoredErrorCodes: if ignoredErrorScope == nil {
                    default([]?string)
                } else {
                    FixedIlVerifyIgnored
                },
                ignoredErrorScope: ignoredErrorScope
            )
            return Issue2900FixedPinReleaseEmitTests.CompiledProgram(directory, assemblyPath)
        }

        private func CompileErrors(source string, tag string) string {
            let directory = Directory.CreateTempSubdirectory("gs_i2900_${tag}_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.NotEqual(0, exitCode)
                return stdout.ToString() + stderr.ToString()
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func ReadMethod(pe PEReader, metadata MetadataReader, handle MethodDefinitionHandle) MethodIl {
            let definition = metadata.GetMethodDefinition(handle)
            let name = metadata.GetString(definition.Name)
            if definition.RelativeVirtualAddress == 0 {
                return MethodIl(name, Array.Empty[IlInstruction](), Array.Empty[ExceptionRegion]())
            }
            let body = pe.GetMethodBody(definition.RelativeVirtualAddress)
            return MethodIl(
                name,
                IlInstructionReader.Read(body.GetILBytes() ?? Array.Empty[uint8]()),
                body.ExceptionRegions.ToArray()
            )
        }
    }
}
