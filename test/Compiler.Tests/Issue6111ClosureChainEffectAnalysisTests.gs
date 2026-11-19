// <copyright file="Issue6111ClosureChainEffectAnalysisTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Reflection
import System.Text
import Xunit
import Xunit.Abstractions

open class Issue6111ClosureChainEffectAnalysisTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(512)
    @InlineData(1024)
    func ClosureCallChain_DeepChains_CompileIlVerifyAndExecuteExactResult(count int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = BuildClosureChainLibrarySource(count)
        let dll = fixture.Compile(source, "closure-chain-${count}", false)
        IlVerifier.Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let probeType = assembly.GetType("Repro.Probe", throwOnError: true)!!
        let runMethod = probeType.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!!
        let result = cast[string](runMethod.Invoke(nil, nil))
        Assert.Equal("42", result)
    }

    @Fact
    func ClosureCallChain_AllocationGrowth_IsSubQuadraticAcrossChainLengths() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        // Warm up the compiler driver on the current thread before measuring allocations.
        let warmupDll = fixture.Compile(BuildClosureChainLibrarySource(4), "warmup", false, "--workers:1")
        IlVerifier.Verify(warmupDll)

        let counts = []int32{8, 32, 128, 512}
        let allocated = [counts.Length]int64
        for var i = 0; i < counts.Length; i++ {
            let count = counts[i]
            let source = BuildClosureChainLibrarySource(count)
            let sourceFile = Path.Combine(fixture.Directory, "scale-${count}.gs")
            let outPath = Path.Combine(fixture.Directory, "scale-${count}.dll")
            File.WriteAllText(sourceFile, source)
            let before = GC.GetAllocatedBytesForCurrentThread()
            let (code, diag) = CompileWithDriver(sourceFile, outPath)
            let bytes = GC.GetAllocatedBytesForCurrentThread() - before
            Assert.True(code == 0, diag)
            allocated[i] = bytes
            output.WriteLine("count=${count}: allocated=${bytes} B")
            IlVerifier.Verify(outPath)
            let assembly = EmittedFixture.Load(outPath)
            let probeType = assembly.GetType("Repro.Probe", throwOnError: true)!!
            let runMethod = probeType.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!!
            Assert.Equal("42", cast[string](runMethod.Invoke(nil, nil)))
        }

        // Pre-fix growth from 32 -> 128 jumped +107.6 MB for +96 callbacks (quadratic, ~16x for 4x callbacks)
        // and crashed at 512. With O(1) state sharing, 128 -> 512 (4x callbacks) stays well below 8x.
        let deltaSmall = Math.Max(allocated[2] - allocated[1], 1L)
        let deltaLarge = allocated[3] - allocated[2]
        output.WriteLine("delta(32->128)=${deltaSmall} B, delta(128->512)=${deltaLarge} B")
        Assert.True(
            deltaLarge < deltaSmall * 8L,
            "Expected sub-quadratic allocation growth: 32->128=${deltaSmall} B, 128->512=${deltaLarge} B"
        )
    }

    @Fact
    func ClosureCallChain_ArgumentDependentBranchingAndCyclicShapes_CompileIlVerifyAndExecute() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let sb = StringBuilder()
        sb.AppendLine("package ChainShapes")
        sb.AppendLine("import System")
        sb.AppendLine("func Main() {")
        sb.AppendLine("    var offset = 40")
        sb.AppendLine("    let leaf () -> int32 = func() int32 { return offset + 2 }")
        sb.AppendLine("    let apply0 ((() -> int32) -> int32) = func(fn () -> int32) int32 { return fn.Invoke() }")
        for var i = 1; i < 128; i++ {
            sb.AppendLine(
                "    let apply${i} ((() -> int32) -> int32) = func(fn () -> int32) int32 { return apply${i - 1}(fn) }"
            )
        }
        sb.AppendLine(
            "    let branch0 (bool) -> int32 = func(flag bool) int32 { if flag { return apply127(leaf) } else { return 0 } }"
        )
        for var i = 1; i < 128; i++ {
            sb.AppendLine(
                "    let branch${i} (bool) -> int32 = func(flag bool) int32 { if flag { return branch${i - 1}(true) } else { return -1 } }"
            )
        }
        sb.AppendLine("    var remaining = 3")
        sb.AppendLine("    var ping () -> int32 = () -> 0")
        sb.AppendLine("    var pong () -> int32 = () -> 0")
        sb.AppendLine("    ping = () -> {")
        sb.AppendLine("        if remaining <= 0 { return 1 }")
        sb.AppendLine("        remaining--")
        sb.AppendLine("        return pong()")
        sb.AppendLine("    }")
        sb.AppendLine("    pong = () -> {")
        sb.AppendLine("        if remaining <= 0 { return 2 }")
        sb.AppendLine("        remaining--")
        sb.AppendLine("        return ping()")
        sb.AppendLine("    }")
        sb.AppendLine("    Console.WriteLine(branch127(true))")
        sb.AppendLine("    Console.WriteLine(ping())")
        sb.AppendLine("}")
        let dll = fixture.Compile(sb.ToString(), "chain-shapes", true)
        IlVerifier.Verify(dll)
        Assert.Equal("42\n2\n", fixture.Run(dll))
    }

    shared {
        private func BuildClosureChainLibrarySource(count int32) string {
            let sb = StringBuilder()
            sb.AppendLine("package Repro")
            sb.AppendLine("import System")
            sb.AppendLine("shared class Probe {")
            sb.AppendLine("func Run() string {")
            sb.AppendLine("let run = func() string { return {")
            sb.AppendLine("var offset = 42")
            sb.AppendLine("let helper0 () -> string = func() string { return offset.ToString() }")
            for var i = 1; i < count; i++ {
                sb.AppendLine("let helper${i} () -> string = func() string { return helper${i - 1}() }")
            }
            sb.AppendLine("helper${count - 1}()")
            sb.AppendLine("} }")
            sb.AppendLine("return run()")
            sb.AppendLine("}")
            sb.AppendLine("}")
            return sb.ToString()
        }

        private func CompileWithDriver(sourceFile string, outPath string)(Code int32, Output string) {
            using let output = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(output)
            Console.SetError(output)
            try {
                let args = []string{
                    "/target:library",
                    "/targetframework:net10.0",
                    "/out:" + outPath,
                    "--workers:1",
                    sourceFile
                }
                return (Program.Main(args), output.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }
    }
}
