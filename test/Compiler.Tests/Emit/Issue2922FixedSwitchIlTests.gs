// <copyright file="Issue2922FixedSwitchIlTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Threading.Tasks
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests
import Xunit.Sdk

/// Issue #2922: fixed sources must become numeric unmanaged pointers before
/// switch control flow is emitted.
open class Issue2922FixedSwitchIlTests {
    @Theory
    @MemberData("PinKinds")
    func FixedSource_VerifiesLoadsAndRuns(
        name string,
        source string,
        expectedOutput string,
        ignoredVerificationErrors[]string
    ) {
        using let program = Compile(name, source)
        IlVerifier.Verify(
            program.AssemblyPath,
            additionalReferences: nil,
            ignoredErrorCodes: ignoredVerificationErrors,
            ignoredErrorScope: if ignoredVerificationErrors.Length == 0 {
                default(string?)
            } else {
                "<Program>\\.F$$"
            }
        )
        program.AssertLoadable()
        Assert.Equal(expectedOutput.Replace("\n", Environment.NewLine, StringComparison.Ordinal), program.Run())
    }

    @Fact
    func FixedControlFlowMatrix_Verifies() {
        using let program = Compile("MatrixVerify", MatrixSource)
        IlVerifier.Verify(program.AssemblyPath)
    }

    @Fact
    func FixedControlFlowMatrix_LoadsAndRuns() {
        using let program = Compile("MatrixRun", MatrixSource)
        program.AssertLoadable()
        Assert.Equal(ExpectedMatrixOutput, program.Run())
    }

    @Fact
    func SlicePin_ConvertsManagedPointerThroughUnsafeAsPointer() {
        using let program = Compile("Instruction", PinKinds().First()[1].ToString()!!)
        let assembly = program.Load()
        let method = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "<Program>")
            .GetMethod("F", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!!
        let instructions = IlInstructionReader.Read(method.GetMethodBody()!!.GetILAsByteArray()!!)
        let loadElementAddressIndex = Array.FindIndex(
            instructions,
            (instruction IlInstruction) -> instruction.OpCode == OpCodes.Ldelema
        )
        Assert.True(loadElementAddressIndex >= 0)
        Assert.True(loadElementAddressIndex + 1 < instructions.Length)
        let call = instructions[loadElementAddressIndex + 1]
        Assert.Equal(OpCodes.Call, call.OpCode)
        Assert.True((call.MetadataToken != nil))
        let calledMethod MethodBase? = method.Module.ResolveMethod(call.MetadataToken!!)
        Assert.Equal("AsPointer", calledMethod!!.Name)
    }

    @Fact
    func InstructionReader_DoesNotTreatOperandByteAsOpcode() {
        let il = []uint8{
            unchecked(uint8(OpCodes.Ldc_I4.Value)),
            unchecked(uint8(OpCodes.Ldelema.Value)),
            0,
            0,
            0,
            unchecked(uint8(OpCodes.Ret.Value))
        }
        Assert.Equal(1, Array.IndexOf(il, unchecked(uint8(OpCodes.Ldelema.Value))))
        let instructions = IlInstructionReader.Read(il)
        Assert.Equal(
            []OpCode{OpCodes.Ldc_I4, OpCodes.Ret},
            instructions.Select((instruction IlInstruction) -> instruction.OpCode)
        )
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

        func Load() Assembly -> EmittedFixture.Load(AssemblyPath)

        func AssertLoadable() -> Assert.NotEmpty(Load().GetTypes())

        func Run() string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add(AssemblyPath)
            using let process = Process.Start(startInfo)!!
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(10_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                throw XunitException("Compiled program timed out.")
            }
            Task.WaitAll(stdoutTask, stderrTask)
            Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `:
` + "${stderrTask.Result}"))
            return stdoutTask.Result.ReplaceLineEndings(Environment.NewLine)
        }

        func Dispose() {
            if Directory.Exists(this.directory) {
                Directory.Delete(this.directory, recursive: true)
            }
        }
    }

    shared {
        private let ExpectedMatrixOutput string = "2${Environment.NewLine}3${Environment.NewLine}12${Environment.NewLine}" +
            "12${Environment.NewLine}3${Environment.NewLine}3${Environment.NewLine}" +
            "2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}" +
            "12${Environment.NewLine}3${Environment.NewLine}3${Environment.NewLine}" +
            "2${Environment.NewLine}2${Environment.NewLine}SI${Environment.NewLine}"

        private const MatrixSource string = `package Issue2922.Matrix
import System

var trace = ""

struct Holder {
    public var Values []int32
}

func AllSwitch(x int32, xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            switch x {
                case 0 { return xs.Length }
                default { return 1 }
            }
        }
    }
}

func SomeSwitch(x int32, xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            switch x {
                case 0 { return xs.Length }
            }
        }
    }
    return 3
}

func BreakSwitch(x int32, xs []int32) int32 {
    var value = 0
    switchLoop: for {
        unsafe {
            fixed p *int32 = xs {
                switch x {
                    case 0 {
                        value = xs.Length
                        break switchLoop
                    }
                    default {
                        value = 1
                        break switchLoop
                    }
                }
            }
        }
    }
    return value + 10
}

func NestedSwitch(x int32, xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            switch x {
                case 0 {
                    switch xs.Length {
                        case 2 { return 12 }
                        default { return -1 }
                    }
                }
                default { return 1 }
            }
        }
    }
}

func LoopSwitch(xs []int32) int32 {
    var total = 0
    unsafe {
        fixed p *int32 = xs {
            for var i = 0; i < 2; i++ {
                switch i {
                    case 0 { total = total + xs.Length }
                    default { total = total + 1 }
                }
            }
        }
    }
    return total
}

func MultipleSwitch(x int32, xs []int32, ys []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            fixed q *int32 = ys {
                switch x {
                    case 0 { return xs.Length + ys.Length }
                    default { return 1 }
                }
            }
        }
    }
}

func StringSwitch(x int32, text string) int32 {
    unsafe {
        fixed p *uint16 = text {
            switch x {
                case 0 { return text.Length }
                default { return 1 }
            }
        }
    }
}

func StructFieldSwitch(x int32, holder Holder) int32 {
    unsafe {
        fixed p *int32 = holder.Values {
            switch x {
                case 0 { return holder.Values.Length }
                default { return 1 }
            }
        }
    }
}

func AllIf(x int32, xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            if x == 0 { return xs.Length }
            return 1
        }
    }
}

func NestedIf(x int32, xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            if x == 0 {
                if xs.Length == 2 { return 12 }
                return -1
            }
            return 1
        }
    }
}

func LoopIf(xs []int32) int32 {
    var total = 0
    unsafe {
        fixed p *int32 = xs {
            for var i = 0; i < 2; i++ {
                if i == 0 { total = total + xs.Length }
                else { total = total + 1 }
            }
        }
    }
    return total
}

func MultipleIf(x int32, xs []int32, ys []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            fixed q *int32 = ys {
                if x == 0 { return xs.Length + ys.Length }
                return 1
            }
        }
    }
}

func StringIf(x int32, text string) int32 {
    unsafe {
        fixed p *uint16 = text {
            if x == 0 { return text.Length }
            return 1
        }
    }
}

func StructFieldIf(x int32, holder Holder) int32 {
    unsafe {
        fixed p *int32 = holder.Values {
            if x == 0 { return holder.Values.Length }
            return 1
        }
    }
}

func VoidSwitch(x int32, xs []int32) {
    unsafe {
        fixed p *int32 = xs {
            switch x {
                case 0 { trace = trace + "S" }
                default { trace = trace + "X" }
            }
        }
    }
}

func VoidIf(x int32, xs []int32) {
    unsafe {
        fixed p *int32 = xs {
            if x == 0 { trace = trace + "I" }
            else { trace = trace + "X" }
        }
    }
}

let xs = []int32{1, 2}
let ys = []int32{3}
let holder = Holder{ Values: xs }
Console.WriteLine(AllSwitch(0, xs))
Console.WriteLine(SomeSwitch(1, xs))
Console.WriteLine(BreakSwitch(0, xs))
Console.WriteLine(NestedSwitch(0, xs))
Console.WriteLine(LoopSwitch(xs))
Console.WriteLine(MultipleSwitch(0, xs, ys))
Console.WriteLine(StringSwitch(0, "AB"))
Console.WriteLine(StructFieldSwitch(0, holder))
Console.WriteLine(AllIf(0, xs))
Console.WriteLine(NestedIf(0, xs))
Console.WriteLine(LoopIf(xs))
Console.WriteLine(MultipleIf(0, xs, ys))
Console.WriteLine(StringIf(0, "AB"))
Console.WriteLine(StructFieldIf(0, holder))
VoidSwitch(0, xs)
VoidIf(0, xs)
Console.WriteLine(trace)`

        /// Gets fixed source kinds whose old conv.u lowering failed verification.
        func PinKinds() sequence[[]object] {
            yield[]object{"Slice", `package Issue2922.Slice
import System
func F(x int32, xs []int32) int32 {
    unsafe {
        fixed p *int32 = xs {
            switch x {
                case 0 { return xs.Length }
                default { return 1 }
            }
        }
    }
}
Console.WriteLine(F(0, []int32{1, 2}))`, "2\n", Array.Empty[string]()}
            yield[]object{"String", `package Issue2922.String
import System
func F(x int32, text string) int32 {
    unsafe {
        fixed p *uint16 = text {
            switch x {
                case 0 { return text.Length }
                default { return 1 }
            }
        }
    }
}
Console.WriteLine(F(0, "AB"))
Console.WriteLine(F(0, ""))`, `2
0
`, Array.Empty[string]()}
            yield[]object{"Span", `package Issue2922.Span
import System
func F(x int32, xs []int32) int32 {
    var span Span[int32] = xs
    unsafe {
        fixed p *int32 = span {
            switch x {
                case 0 { return xs.Length }
                default { return 1 }
            }
        }
    }
}
Console.WriteLine(F(0, []int32{1, 2}))`, "2\n", []string{"StackUnexpected"}}
        }

        private func Compile(name string, source string?) Issue2922FixedSwitchIlTests.CompiledProgram {
            let directory = Directory.CreateTempSubdirectory("gs_i2922_${name}_").FullName
            let sourcePath = Path.Combine(directory, "Program.gs")
            let assemblyPath = Path.Combine(directory, "Program.dll")
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
            return Issue2922FixedSwitchIlTests.CompiledProgram(directory, assemblyPath)
        }
    }
}
