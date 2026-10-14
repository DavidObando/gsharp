// <copyright file="Issue1459ImportedArgImplicitConvEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1459 — calls to imported (CLR/BCL) methods did not apply a
/// user-defined / BCL `op_Implicit` conversion to coerce an argument to
/// the resolved parameter type, so the emitter pushed the source type directly
/// and produced unverifiable IL
/// (`StackUnexpected: found ref 'uint8[]' expected value 'ReadOnlySpan`1<uint8>'`).
/// The fix routes imported-call argument coercion through the same
/// user-defined-conversion fallback used by user functions
/// (`ConversionClassifier.BindClrParameterConversions` now invokes
/// `TryApplyUserDefinedImplicitArgumentConversion` when no built-in
/// conversion applies), covering `[]T -> ReadOnlySpan[T]`,
/// `Span[T] -> ReadOnlySpan[T]`, and `Memory[T] -> ReadOnlyMemory[T]`
/// for any constructed generic with an implicit operator — not just
/// `ReadOnlySpan<byte>`.
open class Issue1459ImportedArgImplicitConvEmitTests {
    @Fact
    func EndToEnd_ByteArrayToReadOnlySpan_AtStaticImportedMethod_Runs() {
        let source = `package Probe1459a
import System
import System.Buffers.Binary

func Main() {
    let arr = [4]uint8
    arr[0] = 0
    arr[1] = 0
    arr[2] = 1
    arr[3] = 0
    let v = BinaryPrimitives.ReadUInt32BigEndian(arr)
    Console.WriteLine(v)
}`
        let output = CompileAndRun(source)
        Assert.Equal("256${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ByteArrayToReadOnlySpan_AtInstanceImportedMethod_Runs() {
        let source = `package Probe1459b
import System
import System.IO

func Main() {
    let ms = MemoryStream()
    let arr = [4]uint8
    ms.Write(arr)
    Console.WriteLine(ms.Length)
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SpanToReadOnlySpan_AtInstanceImportedMethod_Runs() {
        let source = `package Probe1459c
import System
import System.IO

func Main() {
    let ms = MemoryStream()
    let arr = [4]uint8
    let sp = Span[uint8](arr)
    ms.Write(sp)
    Console.WriteLine(ms.Length)
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MemoryToReadOnlyMemory_AtImportedConstructor_Runs() {
        let source = `package Probe1459d
import System
import System.Buffers

func Main() {
    let arr = [4]uint8
    let mem = Memory[uint8](arr)
    let seq = ReadOnlySequence[uint8](mem)
    Console.WriteLine(seq.Length)
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonByteArrayToReadOnlySpan_Generalizes_Runs() {
        // Proves the fix is not byte-specific: []int32 -> ReadOnlySpan[int32]
        // resolves the constructed-generic op_Implicit too.
        let source = `package Probe1459e
import System

func Sum(s ReadOnlySpan[int32]) int32 {
    var t = 0
    var i = 0
    while i < s.Length {
        t = t + s[i]
        i = i + 1
    }
    return t
}

func Main() {
    let arr = [3]int32
    arr[0] = 5
    arr[1] = 9
    arr[2] = 2
    Console.WriteLine(Sum(arr))
}`
        let output = CompileAndRun(source)
        Assert.Equal("16${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1459_exe_").FullName
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
