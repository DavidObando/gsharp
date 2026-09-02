// <copyright file="Issue2900FixedPinReleaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2900: every exit from a <c>fixed</c> body must run a finally handler
/// that clears the pinned local.
/// </summary>
public class Issue2900FixedPinReleaseEmitTests
{
    private static readonly string[] FixedIlVerifyIgnored =
    {
        "Unverifiable",
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
        "ExpectedNumericType",
    };

    [Fact]
    public void BranchExits_UseLeaveThroughFinally_AndRun()
    {
        const string Source = """
            package Issue2900.Branches
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
            }
            """;

        using var program = Compile(Source, "branches");
        Assert.Equal($"1{Environment.NewLine}3{Environment.NewLine}3{Environment.NewLine}4{Environment.NewLine}2{Environment.NewLine}", program.Run());

        AssertEscapingLeave(program.ReadMethod("BreakOut"), expectedFinallyCount: 1);
        AssertEscapingLeave(program.ReadMethod("ContinueOut"), expectedFinallyCount: 1);
        AssertEscapingLeave(program.ReadMethod("GotoOut"), expectedFinallyCount: 1);

        var nested = program.ReadMethod("NestedBreakOut");
        var nestedRegions = nested.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally).ToArray();
        Assert.Equal(2, nestedRegions.Length);
        var inner = nestedRegions.OrderBy(region => region.TryLength).First();
        var outer = nestedRegions.OrderByDescending(region => region.TryLength).First();
        Assert.True(Contains(outer, inner), "Inner fixed region must be nested inside outer fixed region.");
        Assert.Contains(
            nested.Instructions,
            instruction => IsLeave(instruction.OpCode)
                && IsInside(instruction.Offset, inner)
                && instruction.BranchTarget >= outer.HandlerOffset + outer.HandlerLength);
        Assert.Equal(2, nestedRegions.Count(region => IsCleanupHandler(nested, region)));

        var nestedContinue = program.ReadMethod("NestedContinueOut");
        var continueRegions = nestedContinue.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally).ToArray();
        Assert.Equal(2, continueRegions.Length);
        var continueInner = continueRegions.OrderBy(region => region.TryLength).First();
        var continueOuter = continueRegions.OrderByDescending(region => region.TryLength).First();
        Assert.Contains(
            nestedContinue.Instructions,
            instruction => IsLeave(instruction.OpCode)
                && IsInside(instruction.Offset, continueInner)
                && instruction.BranchTarget >= continueOuter.HandlerOffset + continueOuter.HandlerLength);
        Assert.Equal(2, continueRegions.Count(region => IsCleanupHandler(nestedContinue, region)));
    }

    [Fact]
    public void ReturnAndThrow_RunProtectedCleanup_AndRun()
    {
        const string Source = """
            package Issue2900.ReturnThrow
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
            }
            """;

        using var program = Compile(
            Source,
            "return_throw",
            ignoredErrorScope: @"(Box\.\.ctor|<Program>\.(ComputedReturn|MixedReturn))$");
        Assert.Equal($"42{Environment.NewLine}9{Environment.NewLine}void{Environment.NewLine}20{Environment.NewLine}5{Environment.NewLine}20{Environment.NewLine}2{Environment.NewLine}", program.Run());

        var returned = program.ReadMethod("ComputedReturn");
        AssertEscapingLeave(returned, expectedFinallyCount: 1);
        Assert.Contains(returned.Instructions, instruction => IsLeave(instruction.OpCode));

        var thrown = program.ReadMethod("ThrowOut");
        var fixedRegion = Assert.Single(thrown.Regions, region => region.Kind == ExceptionRegionKind.Finally);
        Assert.Contains(
            thrown.Instructions,
            instruction => instruction.OpCode == OpCodes.Throw && IsInside(instruction.Offset, fixedRegion));
        AssertCleanupHandlers(thrown);

        AssertEscapingLeave(program.ReadMethod("VoidReturn"), expectedFinallyCount: 1);
        AssertEscapingLeave(program.ReadMethod("MixedReturn"), expectedFinallyCount: 1);

        var finalizer = program.ReadMethod("Finalize");
        Assert.Equal(2, finalizer.Regions.Count(region => region.Kind == ExceptionRegionKind.Finally));
        Assert.Contains(finalizer.Instructions, instruction => IsLeave(instruction.OpCode));
        AssertCleanupHandlers(finalizer);
    }

    [Fact]
    public void StaticInitializerReturn_UsesSharedFixedEpilogue_AndRuns()
    {
        const string Source = """
            package Issue2900.StaticInitializer
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
            }
            """;

        using var program = Compile(
            Source,
            "static_initializer",
            ignoredErrorScope: @"Holder\.\.cctor$");
        Assert.Equal($"41{Environment.NewLine}", program.Run());
        AssertEscapingLeave(program.ReadMethod(".cctor"), expectedFinallyCount: 1);
    }

    [Fact]
    public void EarlyBreak_ReleasesPinBeforeCompactingGc()
    {
        const string Source = """
            package Issue2900.Movement
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
            }
            """;

        using var program = Compile(
            Source,
            "movement",
            ignoredErrorScope: @"<Program>\.Released$");
        Assert.Equal($"True{Environment.NewLine}", program.Run());
        var method = program.ReadMethod("Released");
        var regions = method.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally).ToArray();
        Assert.Equal(2, regions.Length);
        Assert.Contains(
            regions,
            region => method.Instructions.Count(instruction =>
                IsLeave(instruction.OpCode)
                && IsInside(instruction.Offset, region)
                && instruction.BranchTarget >= region.HandlerOffset + region.HandlerLength) >= 2);
        AssertCleanupHandlers(method);
    }

    [Fact]
    public void PinKinds_ZeroLengthAndNestedConstructs_VerifyAndRun()
    {
        const string Source = """
            package Issue2900.Shapes
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
            Console.WriteLine(trace)
            """;

        using var program = Compile(
            Source,
            "shapes",
            ignoredErrorScope:
                @"<Program>\.(ArrayPin|FixedArrayPin|EmptyPin|StringPin|SpanPin|TryInsideFixed|FixedInsideTry)$");
        Assert.Equal($"7{Environment.NewLine}8{Environment.NewLine}0{Environment.NewLine}65{Environment.NewLine}7{Environment.NewLine}7{Environment.NewLine}7{Environment.NewLine}TRCFBLESGUW1{Environment.NewLine}", program.Run());

        var spanPin = program.ReadMethod("SpanPin");
        var spanCleanup = Assert.Single(
            spanPin.Regions,
            region => region.Kind == ExceptionRegionKind.Finally);
        var spanHandler = spanPin.Instructions
            .Where(instruction => instruction.Offset >= spanCleanup.HandlerOffset
                && instruction.Offset < spanCleanup.HandlerOffset + spanCleanup.HandlerLength)
            .ToArray();
        Assert.Equal(OpCodes.Ldc_I4_0, spanHandler[0].OpCode);
        Assert.Equal(OpCodes.Conv_U, spanHandler[1].OpCode);

        foreach (var methodName in new[]
        {
            "ArrayPin",
            "FixedArrayPin",
            "EmptyPin",
            "StringPin",
            "SpanPin",
            "TryInsideFixed",
            "FixedInsideTry",
            "FixedInCatchAndFinally",
            "BreakFromSwitchAndSelect",
            "ScopeUsingSwitchSelect",
        })
        {
            var method = program.ReadMethod(methodName);
            Assert.Contains(method.Regions, region => region.Kind == ExceptionRegionKind.Finally);
            AssertCleanupHandlers(method);
        }
    }

    [Fact]
    public void SwitchArmReturn_UsesSharedFixedEpilogue_AndRuns()
    {
        const string Source = """
            package Issue2900.SwitchReturn
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
            }
            """;

        using var program = Compile(
            Source,
            "switch_return",
            ignoredErrorScope: @"<Program>\.FromSwitch$");
        Assert.Equal($"8{Environment.NewLine}", program.Run());
        AssertEscapingLeave(program.ReadMethod("FromSwitch"), expectedFinallyCount: 1);
    }

    [Fact]
    public void SelectArmReturn_UsesSharedFixedEpilogue_AndRuns()
    {
        const string Source = """
            package Issue2900.SelectReturn
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
            }
            """;

        using var program = Compile(
            Source,
            "select_return",
            ignoredErrorScope: @"<Program>\.FromSelect$");
        Assert.Equal($"9{Environment.NewLine}", program.Run());
        AssertEscapingLeave(program.ReadMethod("FromSelect"), expectedFinallyCount: 1);
    }

    [Fact]
    public void AsyncAndIterator_WithLaterSuspension_VerifyAndRun()
    {
        const string Source = """
            package Issue2900.StateMachines
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
            }
            """;

        using var program = Compile(
            Source,
            "state_machines",
            ignoredErrorScope:
                @"<(Values|AfterFixed|ReturnFromFixed)>d__\d+\.MoveNext$");
        Assert.Equal($"11{Environment.NewLine}10{Environment.NewLine}12{Environment.NewLine}10{Environment.NewLine}11{Environment.NewLine}", program.Run());
        Assert.True(
            program.ReadAllMethods().Any(method =>
                method.Regions.Any(region => region.Kind == ExceptionRegionKind.Finally)
                && method.Instructions.Any(instruction => instruction.OpCode == OpCodes.Endfinally)),
            "State-machine bodies must retain fixed cleanup regions.");
    }

    [Fact]
    public void SuspensionInsideFixed_ReportsGs0506_ButNestedLambdaIsAllowed()
    {
        const string InvalidSource = """
            package Issue2900.SuspensionErrors
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
            }
            """;

        var diagnostics = CompileErrors(InvalidSource, "suspension_errors");
        Assert.Equal(3, diagnostics.Split("GS0506").Length - 1);
        Assert.Contains("'await' cannot appear inside a 'fixed' statement", diagnostics);
        Assert.Contains("'yield' cannot appear inside a 'fixed' statement", diagnostics);

        const string ValidSource = """
            package Issue2900.NestedLambda
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
            }
            """;

        using var program = Compile(ValidSource, "nested_lambda");
        Assert.Equal($"7{Environment.NewLine}", program.Run());
    }

    [Fact]
    public void SuspensionInsideFixed_AwaitForReportsGs0506()
    {
        const string Source = """
            package Issue2900.AwaitForError
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
            }
            """;

        var diagnostics = CompileErrors(Source, "await_for_error");
        Assert.Equal(1, diagnostics.Split("GS0506").Length - 1);
        Assert.Contains("'await' cannot appear inside a 'fixed' statement", diagnostics);
    }

    [Fact]
    public void SuspensionInsideFixed_AwaitUsingReportsGs0506()
    {
        const string Source = """
            package Issue2900.AwaitUsingError
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
            }
            """;

        var diagnostics = CompileErrors(Source, "await_using_error");
        Assert.Equal(1, diagnostics.Split("GS0506").Length - 1);
        Assert.Contains("'await' cannot appear inside a 'fixed' statement", diagnostics);
    }

    private static void AssertEscapingLeave(MethodIl method, int expectedFinallyCount)
    {
        var regions = method.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally).ToArray();
        Assert.Equal(expectedFinallyCount, regions.Length);
        foreach (var region in regions)
        {
            Assert.True(
                method.Instructions.Count(instruction =>
                    IsLeave(instruction.OpCode)
                    && IsInside(instruction.Offset, region)
                    && instruction.BranchTarget >= region.HandlerOffset + region.HandlerLength) >= 2,
                $"Expected body exit plus normal fallthrough leave in {method.Name}.");
        }

        AssertCleanupHandlers(method);
    }

    private static void AssertCleanupHandlers(MethodIl method)
    {
        Assert.Contains(
            method.Regions,
            region => region.Kind == ExceptionRegionKind.Finally && IsCleanupHandler(method, region));
    }

    private static bool IsCleanupHandler(MethodIl method, ExceptionRegion region)
    {
        var handler = method.Instructions
            .Where(instruction => instruction.Offset >= region.HandlerOffset
                && instruction.Offset < region.HandlerOffset + region.HandlerLength)
            .ToArray();
        return handler.Any(instruction => instruction.OpCode.Name!.StartsWith("stloc", StringComparison.Ordinal))
            && handler[^1].OpCode == OpCodes.Endfinally;
    }

    private static bool Contains(ExceptionRegion outer, ExceptionRegion inner)
        => outer.TryOffset <= inner.TryOffset
            && outer.TryOffset + outer.TryLength >= inner.HandlerOffset + inner.HandlerLength;

    private static bool IsInside(int offset, ExceptionRegion region)
        => offset >= region.TryOffset && offset < region.TryOffset + region.TryLength;

    private static bool IsLeave(OpCode opcode)
        => opcode == OpCodes.Leave || opcode == OpCodes.Leave_S;

    private static CompiledProgram Compile(
        string source,
        string tag,
        string ignoredErrorScope = null)
    {
        var directory = Directory.CreateTempSubdirectory($"gs_i2900_{tag}_").FullName;
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(
            exitCode == 0,
            $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
        IlVerifier.Verify(
            assemblyPath,
            additionalReferences: null,
            ignoredErrorCodes: ignoredErrorScope is null ? null : FixedIlVerifyIgnored,
            ignoredErrorScope: ignoredErrorScope);
        return new CompiledProgram(directory, assemblyPath);
    }

    private static string CompileErrors(string source, string tag)
    {
        var directory = Directory.CreateTempSubdirectory($"gs_i2900_{tag}_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + assemblyPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.NotEqual(0, exitCode);
            return stdout + stderr.ToString();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static MethodIl ReadMethod(PEReader pe, MetadataReader metadata, MethodDefinitionHandle handle)
    {
        var definition = metadata.GetMethodDefinition(handle);
        var name = metadata.GetString(definition.Name);
        if (definition.RelativeVirtualAddress == 0)
        {
            return new MethodIl(name, Array.Empty<IlInstruction>(), Array.Empty<ExceptionRegion>());
        }

        var body = pe.GetMethodBody(definition.RelativeVirtualAddress);
        return new MethodIl(
            name,
            IlInstructionReader.Read(body.GetILBytes() ?? Array.Empty<byte>()),
            body.ExceptionRegions.ToArray());
    }

    private sealed class CompiledProgram : IDisposable
    {
        private readonly string directory;

        public CompiledProgram(string directory, string assemblyPath)
        {
            this.directory = directory;
            AssemblyPath = assemblyPath;
        }

        public string AssemblyPath { get; }

        public string Run()
        {
            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(AssemblyPath, ".runtimeconfig.json"),
                    AssemblyPath,
                },
                WorkingDirectory = this.directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            })!;
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(30_000))
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit();
                Assert.Fail("dotnet exec timed out");
            }

            var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
            var stderr = stderrTask.GetAwaiter().GetResult();
            Assert.True(process.ExitCode == 0, $"dotnet exec exited {process.ExitCode}:\n{stderr}");
            return stdout;
        }

        public MethodIl ReadMethod(string methodName)
        {
            return Assert.Single(ReadAllMethods(), method => method.Name == methodName);
        }

        public MethodIl[] ReadAllMethods()
        {
            using var stream = File.OpenRead(AssemblyPath);
            using var pe = new PEReader(stream);
            var metadata = pe.GetMetadataReader();
            return metadata.MethodDefinitions
                .Select(handle => Issue2900FixedPinReleaseEmitTests.ReadMethod(pe, metadata, handle))
                .ToArray();
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(this.directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private sealed record MethodIl(
        string Name,
        IlInstruction[] Instructions,
        ExceptionRegion[] Regions);
}
