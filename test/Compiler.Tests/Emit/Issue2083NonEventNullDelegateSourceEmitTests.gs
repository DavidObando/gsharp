// <copyright file="Issue2083NonEventNullDelegateSourceEmitTests.cs" company="GSharp">
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

/// Issue #2083: PR #2079 (issue #2066) made the delegate-to-delegate
/// adaptation sequence unconditionally null-guarded, which silently turned a
/// null non-nullable delegate source into a null result instead of the
/// pre-#2079 fail-fast (cref:ArgumentException). The fix restores the
/// throw for every source *except* a field-like event's backing field (the
/// one case, per #2066, where a non-nullable static type genuinely can be
/// null at runtime). This test proves a plain (non-event) non-nullable
/// class-field of an anonymous function type, when read as null and adapted
/// to a named delegate type, still throws instead of silently producing
/// null.
open class Issue2083NonEventNullDelegateSourceEmitTests {
    @Fact
    func NullableFunctionLocal_NullAtRuntime_AdaptsToNullableNamedDelegate() {
        let source = `package Issue2083Pkg
import System

delegate Handler() void;

func UseHandler(h Handler?) {
    h?()
    Console.WriteLine("ok")
}

let missing (() -> void)? = nil
UseHandler(missing)`
        let (exitCode, stdout, stderr) = CompileAndRun(source)
        Assert.Equal(0, exitCode)
        Assert.Equal("ok${Environment.NewLine}", stdout)
        Assert.Equal(string.Empty, stderr)
    }

    @Fact
    func NonEventNonNullableFieldSource_NullAtRuntime_ThrowsInsteadOfSilentlyNull() {
        let source = `package Issue2083Pkg
import System

delegate Handler() void;

class Box {
    var H (() -> void)
}

func UseHandler(h Handler) {
    Console.WriteLine("called")
}

let b = Box{}
UseHandler(b.H)`
        let (exitCode, stdout, stderr) = CompileAndRun(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("ArgumentException", stdout + stderr)
    }

    shared {
        private func CompileAndRun(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2083_" + Guid.NewGuid().ToString("N"))
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
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
