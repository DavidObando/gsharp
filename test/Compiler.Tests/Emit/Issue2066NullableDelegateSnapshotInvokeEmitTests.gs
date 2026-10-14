// <copyright file="Issue2066NullableDelegateSnapshotInvokeEmitTests.cs" company="GSharp">
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

/// Issue #2066: assigning a field-like event to a nullable local of its
/// delegate type, null-guarding the local (smart-cast narrows
/// `TickHandler?` to `TickHandler`), then invoking it with call
/// syntax must bind and run identically to invoking the event directly. The
/// direct call-syntax binder previously keyed off the declared (nullable)
/// `VariableSymbol.Type` rather than any active smart-cast narrowing, so
/// the narrowed local's delegate-invoke branch never matched.
open class Issue2066NullableDelegateSnapshotInvokeEmitTests {
    @Fact
    func NarrowedNullableNamedDelegateLocal_SnapshotOfFieldLikeEvent_InvokesWhenGuarded() {
        let source = `package Issue2066Pkg
import System

delegate TickHandler(count int32) void;

class Clock {
    event Ticked TickHandler

    func Subscribe() {
        Ticked += (count int32) -> Console.WriteLine(count)
    }

    func Fire(count int32) {
        let snapshot TickHandler? = Ticked
        if snapshot != nil {
            snapshot(count)
        }
    }
}

let c = Clock()
c.Fire(1)
c.Subscribe()
c.Fire(42)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func NarrowedNullableAnonymousFunctionTypeLocal_SnapshotOfFieldLikeEvent_InvokesWhenGuarded() {
        let source = `package Issue2066Pkg
import System

class Counter {
    event Bumped (int32) -> void

    func Subscribe() {
        Bumped += (n int32) -> Console.WriteLine(n)
    }

    func Fire(n int32) {
        let snapshot ((int32) -> void)? = Bumped
        if snapshot != nil {
            snapshot(n)
        }
    }
}

let c = Counter()
c.Fire(1)
c.Subscribe()
c.Fire(7)`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2066_" + Guid.NewGuid().ToString("N"))
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
