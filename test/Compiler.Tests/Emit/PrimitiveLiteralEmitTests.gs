// <copyright file="PrimitiveLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Phase 3 of #142: end-to-end emit-and-execute coverage for ADR-0044's
/// expanded primitive set. Each test compiles a tiny GSharp program that
/// stresses a literal value, an implicit widening, or an explicit
/// narrowing of one of the new primitive types and asserts that the
/// printed output matches the BCL's stringification of the same value.
open class PrimitiveLiteralEmitTests {
    @Fact
    func LongLiteral_Suffixed_RoundTripsThroughWriteLine() {
        let source = `package P
import System

let x = 9999999999L
Console.WriteLine(x)`
        Assert.Equal("9999999999${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Float32Literal_Suffixed_RoundTrips() {
        let source = `package P
import System

let x = 3.5F
Console.WriteLine(x)`
        Assert.Equal("3.5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Float64Literal_Default_RoundTrips() {
        let source = `package P
import System

let x = 2.5
Console.WriteLine(x)`
        Assert.Equal("2.5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DecimalLiteral_SmallValue_UsesIntCtor() {
        let source = `package P
import System

let x = 42M
Console.WriteLine(x)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DecimalLiteral_FractionalValue_UsesFiveArgCtor() {
        let source = `package P
import System

let x = 3.14M
Console.WriteLine(x)`
        Assert.Equal("3.14${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DecimalLiteral_Zero_UsesStaticField() {
        let source = `package P
import System

let x = 0M
Console.WriteLine(x)`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UnsuffixedInt_WidensImplicitlyTo_LongTarget() {
        // ADR-0044: `let x : long = 1` works without `1L`.
        let source = `package P
import System

let x int64 = 1
Console.WriteLine(x)`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExplicitNarrowing_LongToInt_Truncates() {
        let source = `package P
import System

let big = 4294967297L
let n = int32(big)
Console.WriteLine(n)`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExplicitNarrowing_Float64ToInt_Truncates() {
        let source = `package P
import System

let f = 3.9
let n = int32(f)
Console.WriteLine(n)`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Int_To_Object_Boxes_ForObjectParameter() {
        let source = `package P
import System

let n = 42
Console.WriteLine(n)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func CharLiteral_Prints_AsChar() {
        let source = `package P
import System

let c = 'A'
Console.WriteLine(c)`
        Assert.Equal("A${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_phase3_emit_").FullName
            try {
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
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
