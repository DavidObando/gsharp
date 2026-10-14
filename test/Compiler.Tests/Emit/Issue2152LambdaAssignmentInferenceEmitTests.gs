// <copyright file="Issue2152LambdaAssignmentInferenceEmitTests.cs" company="GSharp">
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

/// Issue #2152 — a block-body lambda whose trailing expression is an
/// assignment infers a `void` return type on the target-less inference
/// path (overload resolution), so it matches an `Action`-style
/// `(int32) -> void` delegate parameter. These tests compile,
/// IL-verify, and run a lambda-with-assignment-body invoked through an
/// inferred void-delegate parameter, asserting the assignment took effect.
open class Issue2152LambdaAssignmentInferenceEmitTests {
    @Fact
    func OverloadedVoidDelegate_AssignmentBodyLambda_InfersVoid_AndRuns() {
        let source = `package P
import System

func run(a () -> void) { a() }
func run(b (int32) -> void) { b(9) }

var total = 0
run((x int32) -> { total = total + x })
Console.WriteLine(total)`
        let output = CompileAndRun(source)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    @Fact
    func OverloadedVoidDelegate_CompoundAssignmentBodyLambda_InfersVoid_AndRuns() {
        let source = `package P
import System

func run(a () -> void) { a() }
func run(b (int32) -> void) { b(5) }

var total = 3
run((x int32) -> { total += x })
Console.WriteLine(total)`
        let output = CompileAndRun(source)
        Assert.Equal("8${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string, referencePaths[]?string = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2152_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if referencePaths != nil {
                    for reference in referencePaths {
                        args.Add("/reference:" + reference)
                        File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true)
                    }
                }
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath, additionalReferences: referencePaths)
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
