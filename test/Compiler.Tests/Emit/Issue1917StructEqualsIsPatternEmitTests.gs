// <copyright file="Issue1917StructEqualsIsPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1917: a struct method shadowing `object.Equals(object)` whose
/// body narrows the parameter with an `is` type-test
/// (`obj is Money && Cents == obj.Cents`, ADR-0069 smart-cast) emitted
/// IL that ilverify rejects with `StackUnexpected: [found address of
/// 'object'][expected readonly address of 'Money']`. The struct's field
/// access on the narrowed parameter re-loaded the ORIGINAL `object`-typed
/// argument slot's address instead of unboxing/narrowing it to the pattern's
/// target type first, so the CLR JIT tolerated the mismatched stack shape but
/// ilverify's stricter typed-stack model did not.
open class Issue1917StructEqualsIsPatternEmitTests {
    @Fact
    func StructEqualsOverride_IsPatternSmartCastFieldAccess_RunsAndIlVerifies() {
        let source = `package P
import System

struct Money {
    var Cents int32
    func Equals(obj object?) bool {
        return obj is Money && Cents == obj.Cents
    }
}

var a = Money{ Cents: 100 }
var b = Money{ Cents: 100 }
var c = Money{ Cents: 200 }
var oa object = a
Console.WriteLine(oa.Equals(b))
Console.WriteLine(oa.Equals(c))
Console.WriteLine(oa.Equals("not money"))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1917_").FullName
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
