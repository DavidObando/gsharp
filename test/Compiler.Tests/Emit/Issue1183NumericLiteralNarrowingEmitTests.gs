// <copyright file="Issue1183NumericLiteralNarrowingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #1183: emit/runtime coverage for C#-compatible numeric literal
/// narrowing/widening. Verifies the produced IL is verifiable and that the
/// runtime values match C# semantics: widened values are preserved, in-range
/// constants narrow to a correctly-typed constant, and an explicit
/// float→int narrowing truncates (e.g. (int)19.75 == 19).
open class Issue1183NumericLiteralNarrowingEmitTests {
    @Fact
    func ImplicitWidening_Int32ToInt64_PreservesValue() {
        let source = `package P

func Widen() int64 {
    var itemCount int32 = 42
    var widened int64 = itemCount
    return widened
}`
        let widen = GetMethod(CompileToAssembly(source), "Widen")
        Assert.Equal(42L, widen.Invoke(nil, nil))
    }

    @Fact
    func ExplicitNarrowing_Float64ToInt32_Truncates() {
        let source = `package P

func Truncate() int32 {
    var average float64 = 19.75
    var truncated int32 = int32(average)
    return truncated
}`
        let truncate = GetMethod(CompileToAssembly(source), "Truncate")
        Assert.Equal(19, truncate.Invoke(nil, nil))
    }

    @Fact
    func InRangeConstantNarrowing_ProducesCorrectlyTypedConstant() {
        let source = `package P

func NarrowByte() uint8 {
    var a uint8 = 200
    return a
}

func NarrowShort() int16 {
    var s int16 = -30000
    return s
}

func NarrowUInt() uint32 {
    var u uint32 = 5
    return u
}`
        let assembly = CompileToAssembly(source)
        let narrowByte = GetMethod(assembly, "NarrowByte")
        Assert.Equal(uint8(200), narrowByte.Invoke(nil, nil))
        Assert.Equal(typeof(uint8), narrowByte.ReturnType)
        let narrowShort = GetMethod(assembly, "NarrowShort")
        Assert.Equal(int16(-30000), narrowShort.Invoke(nil, nil))
        Assert.Equal(typeof(int16), narrowShort.ReturnType)
        let narrowUInt = GetMethod(assembly, "NarrowUInt")
        Assert.Equal(uint32(5), narrowUInt.Invoke(nil, nil))
        Assert.Equal(typeof(uint32), narrowUInt.ReturnType)
    }

    @Fact
    func NegativeInRangeConstant_NarrowsToSigned() {
        let source = `package P

func NegByte() int8 {
    var b int8 = -5
    return b
}`
        let negByte = GetMethod(CompileToAssembly(source), "NegByte")
        Assert.Equal(int8(-5), negByte.Invoke(nil, nil))
        Assert.Equal(typeof(int8), negByte.ReturnType)
    }

    @Fact
    func OverInt32Literals_InferWiderType_PreserveValue() {
        // C# §6.4.5.3: bare literals exceeding int32 infer the first fitting
        // type among uint32, int64, uint64 and (via #1183 constant-narrowing)
        // assign to a matching target with the correct runtime value.
        let source = `package P

func MaxUInt() uint32 {
    var u uint32 = 4294967295
    return u
}

func BigLong() int64 {
    let big int64 = 5000000000
    return big
}

func MaxULong() uint64 {
    let v uint64 = 18446744073709551615
    return v
}`
        let assembly = CompileToAssembly(source)
        let maxUInt = GetMethod(assembly, "MaxUInt")
        Assert.Equal(typeof(uint32), maxUInt.ReturnType)
        Assert.Equal(uint32.MaxValue, maxUInt.Invoke(nil, nil))
        let bigLong = GetMethod(assembly, "BigLong")
        Assert.Equal(typeof(int64), bigLong.ReturnType)
        Assert.Equal(5000000000L, bigLong.Invoke(nil, nil))
        let maxULong = GetMethod(assembly, "MaxULong")
        Assert.Equal(typeof(uint64), maxULong.ReturnType)
        Assert.Equal(uint64.MaxValue, maxULong.Invoke(nil, nil))
    }

    @Fact
    func OverInt32Literal_AsReturnValue_InfersUInt32() {
        // 4294967295 fits uint32 (not int32); returned directly with no target
        // assignment, the inferred literal type is uint32.
        let source = `package P

func DirectUInt() uint32 {
    return 4294967295
}`
        let directUInt = GetMethod(CompileToAssembly(source), "DirectUInt")
        Assert.Equal(typeof(uint32), directUInt.ReturnType)
        Assert.Equal(uint32.MaxValue, directUInt.Invoke(nil, nil))
    }

    @Fact
    func HexLiteralExceeding32Bits_WidensToInt64() {
        // Hex literals that fit 32 bits keep their bit-cast-to-int behaviour;
        // those exceeding 32 bits follow the §6.4.5.3 widening lattice.
        let source = `package P

func WideHex() int64 {
    let h int64 = 0x1_0000_0000
    return h
}`
        let wideHex = GetMethod(CompileToAssembly(source), "WideHex")
        Assert.Equal(typeof(int64), wideHex.ReturnType)
        Assert.Equal(4294967296L, wideHex.Invoke(nil, nil))
    }

    shared {
        private func GetMethod(assembly Assembly, name string) MethodInfo {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let method MethodInfo? = program.GetMethod(
                name,
                BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_1183_emit_").FullName
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
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            return EmittedFixture.Load(outPath)
        }
    }
}
