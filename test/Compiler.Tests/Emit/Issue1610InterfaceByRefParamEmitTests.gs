// <copyright file="Issue1610InterfaceByRefParamEmitTests.cs" company="GSharp">
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
import Xunit.Sdk

/// Issue #1610: interface methods with `ref`/`out`/`in`
/// parameters emitted by-value signatures on the abstract interface slot, so
/// implementing classes never matched the slot and the CLR threw
/// `TypeLoadException` ("does not have an implementation") at type load.
/// These tests compile through the real gsc driver, gate the output on
/// ilverify (which reported the missing implementation before the fix), and
/// execute the program out-of-process to prove interface dispatch works for
/// every ref kind.
open class Issue1610InterfaceByRefParamEmitTests {
    @Fact
    func InterfaceWithOutParam_ImplementedByClass_VerifiesAndRuns() {
        // Exact repro from issue #1610.
        let source = `package Repro
import System

interface Parser {
    func TryParse(s string, out result int32) bool;
}

class IntParser : Parser {
    func TryParse(s string, out result int32) bool {
        result = 42
        return true
    }
}

var p Parser = IntParser()
var r = 0
if p.TryParse("x", &r) {
    Console.WriteLine(r)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func InterfaceWithRefOutInParams_DispatchThroughInterface_VerifiesAndRuns() {
        let source = `package Mixed
import System

interface Mutator {
    func TryParse(s string, out result int32) bool;
    func Bump(ref counter int32, by int32);
    func Scale(in factor int32) int32;
}

class Impl : Mutator {
    func TryParse(s string, out result int32) bool {
        result = 42
        return true
    }

    func Bump(ref counter int32, by int32) {
        counter = counter + by
    }

    func Scale(in factor int32) int32 {
        return factor * 3
    }
}

var m Mutator = Impl()
var r = 0
if m.TryParse("x", &r) {
    Console.WriteLine(r)
}
var n = 5
m.Bump(&n, 10)
Console.WriteLine(n)
Console.WriteLine(m.Scale(&n))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}15${Environment.NewLine}45${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1610_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid — before
                // the fix ilverify reported the unimplemented interface method.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute — before
                // the fix the program died at type load with TypeLoadException.
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
