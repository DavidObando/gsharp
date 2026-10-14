// <copyright file="Issue1226UnsignedElementIncrementEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1226: `++`/`--` (and `+=`/`-=` with an untyped
/// integer literal) on an array-element / indexer lvalue whose element type is
/// a non-`int32` integer (`uint8`, `uint16`, …) was rejected with
/// GS0129 because the synthetic increment constant `1` defaulted to
/// `int32` instead of the element type. The same operation already worked
/// for plain locals, fields, and `int32` array elements. The binder now
/// adapts the constant integer literal to the element type for the
/// element-access write-through path (mirroring the #1144 literal adaptation
/// performed by the local/field path). These tests compile and run real
/// programs end-to-end, asserting the in-place mutation of the element bytes.
open class Issue1226UnsignedElementIncrementEmitTests {
    @Fact
    func Uint8Element_Increment_StoresIncrementedByte() {
        let source = `package P
import System

var data = []uint8{10, 20, 30, 40}
data[1]++
Console.WriteLine(int32(data[1]))`
        Assert.Equal("21${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Uint8Element_Decrement_StoresDecrementedByte() {
        let source = `package P
import System

var data = []uint8{10, 20, 30, 40}
data[2]--
Console.WriteLine(int32(data[2]))`
        Assert.Equal("29${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Uint8Element_PlusEqualsLiteral_StoresSum() {
        let source = `package P
import System

var data = []uint8{10, 20, 30, 40}
data[0] += 1
Console.WriteLine(int32(data[0]))`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Uint8Element_MinusEqualsLiteral_StoresDifference() {
        let source = `package P
import System

var data = []uint8{10, 20, 30, 40}
data[3] -= 1
Console.WriteLine(int32(data[3]))`
        Assert.Equal("39${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Uint16Element_Increment_StoresIncrementedValue() {
        let source = `package P
import System

var data = []uint16{1000, 2000}
data[0]++
Console.WriteLine(int32(data[0]))`
        Assert.Equal("1001${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Uint32Element_Increment_StoresIncrementedValue() {
        let source = `package P
import System

var data = []uint32{100000, 200000}
data[1]++
Console.WriteLine(int32(data[1]))`
        Assert.Equal("200001${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int16Element_Increment_StoresIncrementedValue() {
        let source = `package P
import System

var data = []int16{-5, 7}
data[0]++
Console.WriteLine(int32(data[0]))`
        Assert.Equal("-4${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Uint8Element_BigEndianCounterIncrement_CarriesAcrossBytes() {
        // AES-CTR-style big-endian 128-bit counter increment: increment the
        // least-significant byte, carrying into more-significant bytes while the
        // current byte wraps to 0. Exercises `[]uint8` element `++` in a loop
        // with the wrap-around (overflow) behaviour of the unsigned element.
        let source = `package P
import System

func Increment(counter []uint8) {
    var i = 15
    for i >= 0 {
        counter[i]++
        if counter[i] != uint8(0) {
            return
        }
        i--
    }
}

var counter = []uint8{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255}
Increment(counter)
Console.WriteLine(int32(counter[15]))
Console.WriteLine(int32(counter[14]))

var wrap = []uint8{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255}
Increment(wrap)
Console.WriteLine(int32(wrap[15]))
Console.WriteLine(int32(wrap[14]))
Console.WriteLine(int32(wrap[13]))`
        // First counter: last byte 255 -> 0 with carry into byte 14 (0 -> 1).
        // Second counter: bytes 14,15 both 255 -> both 0, carry into byte 13.
        Assert.Equal(
            "0${Environment.NewLine}1${Environment.NewLine}0${Environment.NewLine}0${Environment.NewLine}1${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1226_").FullName
            try {
                return CompileAndRunImpl(source, tempDir)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunImpl(source string, tempDir string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
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
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
