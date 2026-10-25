// <copyright file="Issue1026FixedEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import GSharp.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection.Emit
import System.Text
import Xunit

/// Issue #1026 / ADR-0125: end-to-end emit + execution tests for the
/// `fixed` statement (`fixed <name> *T = <source> { ... }`).
/// The statement pins a managed array/slice or string and binds an unmanaged
/// `*T` pointer to its first element, emitting a CLR `pinned` local
/// (mirroring C# `fixed (T* p = expr) { }`). Each test compiles via
/// `gsc` and executes the produced assembly under `dotnet exec` to
/// assert runtime behavior.
///
/// Code that pins a buffer and dereferences an unmanaged pointer is
/// <em>unverifiable by design</em>: ilverify reports the usual
/// unmanaged-pointer / by-ref codes at the pin and dereference sites. Those
/// specific codes are passed to `ignoredErrorCodes` so the gate still
/// catches NEW unrelated verification regressions while tolerating the
/// inherent unsafety, rather than skipping ilverify globally.
open class Issue1026FixedEmitTests {
    @Fact
    func InferredImportedByteArray_ExactIssue5266_ReachesArrayPinLowering() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`import System.Text

unsafe {
    let bytes = Encoding.UTF8.GetBytes("x")
    fixed value *uint8 = bytes {
        System.Console.WriteLine(value[0])
    }
}`, "inferred", true)
        IlVerifier.Verify(assembly, nil, FixedIlVerifyIgnored)
        Assert.Equal(Encoding.UTF8.GetBytes("120" + Environment.NewLine), RunBytes(assembly, fixture.Directory))
        let entryPoint = EmittedFixture.Load(assembly)
            .EntryPoint ??
            throw InvalidOperationException("Missing entry point")
        let body = entryPoint.GetMethodBody() ?? throw InvalidOperationException("Missing entry point body")
        Assert.Contains(body.LocalVariables, (local) -> local.IsPinned && local.LocalType == typeof([]uint8))
        let instructions = IlInstructionReader.Read(body.GetILAsByteArray() ?? Array.Empty[uint8]())
        Assert.Contains(instructions, (instruction) -> instruction.OpCode == OpCodes.Ldelema)
        Assert.Contains(instructions, (instruction) -> instruction.OpCode == OpCodes.Ldind_U1)
    }

    @Fact
    func ImportedArrayMembers_PinOriginalStorageAndEvaluateSourceOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        using let contract = CSharpFixture(`#nullable enable
namespace PinContracts {
    public sealed class PinBuffer {
        public byte[] Data = new byte[] { 120 };
        public int Reads;
        public byte[] Value { get { Reads++; return Data; } }
        public int[] Numbers() { Reads++; return new int[] { 42 }; }
    }
}`)
        File.Copy(contract.AssemblyPath, Path.Combine(fixture.Directory, Path.GetFileName(contract.AssemblyPath)))
        let assembly = fixture.Compile(`import System
import PinContracts
unsafe {
    let owner = PinBuffer()
    let inferred = owner.Data
    let annotated []uint8 = inferred
    fixed p *uint8 = inferred { p[0] = uint8(121) }
    fixed p *uint8 = owner.Value {
        Console.WriteLine(p[0])
        p[0] = uint8(122)
    }
    Console.WriteLine(annotated[0])
    Console.WriteLine(owner.Data[0])
    Console.WriteLine(Object.ReferenceEquals(inferred, owner.Data))
    fixed p *int32 = owner.Numbers() { Console.WriteLine(p[0]) }
    Console.WriteLine(owner.Reads)
}`, "members", true, "/r:" + contract.AssemblyPath)
        IlVerifier.Verify(assembly, []string{contract.AssemblyPath}, FixedIlVerifyIgnored)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                string.Join(Environment.NewLine, []string{"121", "122", "122", "True", "42", "2", ""})
            ),
            RunBytes(assembly, fixture.Directory)
        )
    }

    @Theory
    @InlineData("Bytes", "int32")
    @InlineData("Matrix", "uint8")
    @InlineData("Names", "uint8")
    @InlineData("Maybe", "uint8")
    func ImportedArrayPin_RejectionsKeepLocatedGS0401AndEmitNoPE(member string, pointee string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        using let contract = CSharpFixture(`#nullable enable
namespace PinContracts {
    public static class Pins {
        public static byte[] Bytes() => new byte[1];
        public static byte[,] Matrix() => new byte[1, 1];
        public static string[] Names() => new string[] { "x" };
        public static byte[]? Maybe() => null;
    }
}`)
        let (code, output) = fixture.TryCompile(
            "import PinContracts\nunsafe {\n    fixed value *$pointee = Pins.$member() { }\n}",
            "rejected",
            true,
            "/r:" + contract.AssemblyPath
        )
        Assert.NotEqual(0, code)
        let endColumn = 33 + member.Length
        Assert.Contains("rejected.gs(3,26,3,$endColumn): error GS0401:", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
    }

    @Fact
    func ArrayPin_WriteRead_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var buf = []uint8{uint8(0), uint8(0), uint8(0)}
    fixed pD *uint8 = buf {
        pD[0] = uint8(65)
        pD[1] = uint8(66)
        pD[2] = uint8(67)
    }
    Console.WriteLine(int32(buf[0]))
    Console.WriteLine(int32(buf[1]))
    Console.WriteLine(int32(buf[2]))
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("65${Environment.NewLine}66${Environment.NewLine}67${Environment.NewLine}", output)
    }

    @Fact
    func StringPin_ReadChars_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var total = 0
    fixed pC *uint16 = "ABC" {
        for var i = 0; i < 3; i++ {
            total = total + int32(pC[i])
        }
    }
    Console.WriteLine(total)
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        // 'A'(65) + 'B'(66) + 'C'(67) = 198
        Assert.Equal("198${Environment.NewLine}", output)
    }

    @Fact
    func OahuPattern_FixedBytePointer_CompilesAndRuns() {
        // Equivalent of the Oahu case `fixed (byte* pD = destination)` where
        // `destination` is a `byte[]`: copy bytes through the pinned pointer.
        let source = `package Probe
import System

unsafe func copyByte(destination []uint8, value uint8) {
    fixed pD *uint8 = destination {
        *pD = value
    }
}

unsafe func run() {
    var dst = []uint8{uint8(0), uint8(0)}
    copyByte(dst, uint8(42))
    Console.WriteLine(int32(dst[0]))
    Console.WriteLine(int32(dst[1]))
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("42${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EmptyArrayPin_NullPointer_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var buf = []uint8{}
    fixed pD *uint8 = buf {
        Console.WriteLine(nint(pD))
    }
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    shared {
        private func RunBytes(assembly string, directory string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            start.ArgumentList.Add(assembly)
            using let process = Process.Start(start) ?? throw InvalidOperationException("Failed to start dotnet")
            using let stdout = MemoryStream()
            let output = process.StandardOutput.BaseStream.CopyToAsync(stdout)
            let error = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                throw TimeoutException("Pinned array witness timed out")
            }
            output.GetAwaiter().GetResult()
            Assert.Equal("", error.GetAwaiter().GetResult())
            Assert.Equal(0, process.ExitCode)
            return stdout.ToArray()
        }

        private let FixedIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        private func CompileAndRun(source string, ilVerifyIgnored[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1026_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                // Pinning + unmanaged-pointer dereference is unverifiable by
                // design; tolerate the specific pointer/by-ref codes while still
                // gating on other verification regressions.
                IlVerifier.Verify(outPath, nil, ilVerifyIgnored)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
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
                } catch {
                    // ignored

                }
            }
        }
    }
}
