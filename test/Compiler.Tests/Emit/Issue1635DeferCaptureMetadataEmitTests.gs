// <copyright file="Issue1635DeferCaptureMetadataEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1635 NB-1: `CaptureDeferArguments` rebuilds the deferred call
/// so it can run against eagerly-captured locals. The rebuild must carry
/// EVERY metadata property of the original bound call — not just the
/// receiver/target and arguments — or the deferred call emits wrong dispatch
/// or unverifiable IL. These tests round-trip through compile → IL-verify →
/// run for two scenarios the short reconstruction dropped:
/// - a `defer` on a constrained-interface instance call (issue #943), which needs
/// `ConstrainedReceiverTypeParameter`/`ConstrainedInterfaceType` to emit a valid
/// `constrained.`-prefixed `callvirt`;
/// - a `defer` on an imported generic instance method with an explicit type argument (issue #320),
/// which needs `TypeArgumentSymbols` to close the generic method correctly.
/// Before the fix, the constrained-call scenario throws
/// (cref:InvalidProgramException) at run time because the rebuilt
/// call loses the `constrained.` dispatch info.
open class Issue1635DeferCaptureMetadataEmitTests {
    @Fact
    func Defer_OnConstrainedInterfaceInstanceCall_PreservesConstrainedDispatch() {
        let source = `package p
import System

func Touch[T IComparable[T]](a T, b T) {
    defer a.CompareTo(b)
    Console.WriteLine("body")
}

Touch[int32](7, 3)
Console.WriteLine("done")`
        let output = CompileVerifyAndRun(source)
        Assert.Equal("body${Environment.NewLine}done${Environment.NewLine}", output)
    }

    @Fact
    func Defer_OnImportedInstanceGenericMethodWithExplicitTypeArgument_PreservesTypeArguments() {
        let source = `package p
import System
import System.Collections.Generic

func conv(x int32) string {
    Console.WriteLine(x.ToString())
    return x.ToString()
}

var list = List[int32]()
list.Add(1)
list.Add(2)
list.Add(3)
{
    defer list.ConvertAll[string](conv)
    Console.WriteLine("body")
}`
        let output = CompileVerifyAndRun(source)
        Assert.Equal(
            "body${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Defer_OnUserGenericInstanceCall_PreservesMethodTypeArguments() {
        let source = `package p
import System

class Marker1635 {
    func Mark[T](value int32) {
        Console.WriteLine(value)
    }
}

{
    let marker = Marker1635()
    defer marker.Mark[string](7)
    Console.WriteLine("body")
}`
        let output = CompileVerifyAndRun(source)
        Assert.Equal("body${Environment.NewLine}7${Environment.NewLine}", output)
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue1635_defer_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let srcPath = Path.Combine(workDir, "test.gs")
                let outPath = Path.Combine(workDir, "test.dll")
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                File.WriteAllText(Path.ChangeExtension(outPath, "runtimeconfig.json"), `{
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch {
                    // Best-effort cleanup; ignore.

                }
            }
        }
    }
}
