// <copyright file="Issue2082LambdaLiteralNamedDelegateEventEmitTests.cs" company="GSharp">
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

/// Issue #2082: assigning an inline lambda/func-literal to a field-like event
/// of a user-declared named delegate type via `+=` must adapt the lambda
/// to the declared named-delegate type, not erase it to the lambda's natural
/// CLR `Action`/`Func` shape. Previously the lambda kept its
/// closure-delegate CLR type, mismatching the event accessor's declared
/// parameter type and failing IL verification.
open class Issue2082LambdaLiteralNamedDelegateEventEmitTests {
    @Fact
    func LambdaLiteralAddedToNamedDelegateEvent_AdaptsToDeclaredType_RunsAndVerifies() {
        let source = `package Issue2082Pkg
import System

delegate TickHandler(count int32) void;

class Clock {
    public event Ticked TickHandler
}

func Main() {
    let c = Clock()
    c.Ticked += func(count int32) void { System.Console.WriteLine(count) }
}`
        Assert.Equal(string.Empty, CompileAndRun(source, invoke: false))
    }

    @Fact
    func LambdaLiteralAddedToNamedDelegateEvent_InvokedViaSnapshot_ProducesCorrectOutput() {
        let source = `package Issue2082Pkg2
import System

delegate TickHandler(count int32) void;

class Clock {
    event Ticked TickHandler

    func Subscribe() {
        Ticked += func(count int32) void { System.Console.WriteLine(count) }
    }

    func Fire(count int32) {
        let snapshot = Ticked
        if snapshot != nil {
            snapshot(count)
        }
    }
}

let c = Clock()
c.Subscribe()
c.Fire(42)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source, invoke: true))
    }

    shared {
        private func CompileAndRun(source string, invoke bool) string {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2082_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
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
                IlVerifier.Verify(outPath)
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
