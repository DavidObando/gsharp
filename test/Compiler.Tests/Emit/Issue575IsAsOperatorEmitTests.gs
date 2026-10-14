// <copyright file="Issue575IsAsOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #575: expression-level `is` (type-test) and `as` (safe-cast) operators.
/// Each test compiles via in-process `gsc`, IL-verifies the PE, then runs
/// under `dotnet exec` and asserts captured stdout.
open class Issue575IsAsOperatorEmitTests {
    @Fact
    func Is_RefType_ReturnsTrue_WhenMatch() {
        let source = `package Test
import System
import System.Text.Json.Nodes

let node JsonNode = JsonArray()
let result = node is JsonArray
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Is_RefType_ReturnsFalse_WhenMismatch() {
        let source = `package Test
import System
import System.Text.Json.Nodes

let node JsonNode = JsonValue.Create(42)
let result = node is JsonArray
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func Is_ValueType_ReturnsTrue_WhenMatch() {
        let source = `package Test
import System

let boxed object = 5
let result = boxed is Int32
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Is_OnNull_ReturnsFalse() {
        let source = `package Test
import System

let x String? = nil
let result = x is String
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func As_RefType_ReturnsInstance_WhenMatch() {
        let source = `package Test
import System
import System.Text.Json.Nodes

let node JsonNode = JsonArray()
let arr = node as JsonArray
let check = arr is JsonArray
Console.WriteLine(check)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func As_RefType_ReturnsNull_WhenMismatch() {
        let source = `package Test
import System
import System.Text.Json.Nodes

let node JsonNode = JsonValue.Create(42)
let arr = node as JsonArray
let check = arr is JsonArray
Console.WriteLine(check)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}", output)
    }

    @Fact
    func As_OnNull_ReturnsNull() {
        let source = `package Test
import System

let x String? = nil
let s = x as String
Console.WriteLine(s == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func As_ValueType_RequiresNullable_DefaultMatchesCSharp() {
        let source = `package Test
import System

let boxed object = 42
let result = boxed as Int32?
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Is_PrecedenceVsEquality() {
        // (x is T) == true should parse as: ((x is T) == true)
        let source = `package Test
import System

let x object = "hello"
let result = (x is String) == true
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func Is_PrecedenceVsLogical() {
        // a is T && b is U should parse as: (a is T) && (b is U)
        let source = `package Test
import System

let a object = "hello"
let b object = 42
let result = a is String && b is Int32
Console.WriteLine(result)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func As_OnNonNullableValueType_ErrorsWithPreciseGS() {
        let source = `package Test
import System

let boxed object = 42
let result = boxed as Int32
Console.WriteLine(result)`
        let (exitCode, stdout, _) = CompileAndRunRaw(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0270", stdout)
    }

    @Fact
    func PatternLevel_Is_InSwitch_StillWorks() {
        // Regression: the existing pattern-level `identifier is Type` syntax
        // in switch arms must continue to parse and compile correctly.
        let source = `package Test
import System

let x object = "hello"
switch x {
    case s is String {
        Console.WriteLine(s)
    }
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func PatternLevel_Is_InSwitch_ValueType_StillWorks() {
        let source = `package Test
import System

let x object = 99
switch x {
    case n is Int32 {
        Console.WriteLine(n)
    }
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue575_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
                args.Add(srcPath)
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
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                if proc.ExitCode != 0 {
                    return (
                        proc.ExitCode,
                        stdout.ReplaceLineEndings(Environment.NewLine),
                        stderr.ReplaceLineEndings(Environment.NewLine)
                    )
                }
                return (
                    0,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
