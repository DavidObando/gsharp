// <copyright file="Issue3527SharedMemberVsPackageFunctionEmitTests.cs" company="GSharp">
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

/// Issue #3527 — inside a `shared` member body, an unqualified call whose
/// name collides with a same-named PACKAGE-level function silently bound the
/// package function instead of the enclosing type's own `shared` sibling
/// method, with no diagnostic. This proves the fix end-to-end: the minimal
/// two-file repro from the issue now compiles, emits verifiable IL, and
/// executes the type's own method.
open class Issue3527SharedMemberVsPackageFunctionEmitTests {
    @Fact
    func EndToEnd_SharedMethodBareCall_PrefersOwnSharedSibling_OverPackageFunction() {
        // The exact repro from the issue, split across two files in the same
        // package: Helper.gs declares a package-level `check`, Main.gs
        // declares a class whose `shared` block ALSO declares a private
        // `check`. `Run`'s bare `check()` call must bind its own sibling and
        // increment `count`, so `Main` returns 0.
        const helperSource = `package i3527sharedvspkg

func check() {
}`
        const mainSource = `package i3527sharedvspkg

class Checks {
  shared {
    private var count int32

    private func check() {
      count++
    }

    public func Run() int32 {
      check()
      return count
    }
  }
}

func Main() int32 {
  return Checks.Run() == 1 ? 0 : 1
}`
        let exitCode = CompileAndRun(helperSource, mainSource)
        Assert.Equal(0, exitCode)
    }

    shared {
        private func CompileAndRun(sources ...string) int32 {
            let tempDir = Directory.CreateTempSubdirectory("gs_3527_exe_").FullName
            try {
                let dllPath = Path.Combine(tempDir, "test.dll")
                let srcPaths = [sources.Length]string
                for var i = 0; i < sources.Length; i++ {
                    srcPaths[i] = Path.Combine(tempDir, "test$i.gs")
                    File.WriteAllText(srcPaths[i], sources[i])
                }
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                args.AddRange(srcPaths)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0 || proc.ExitCode == 1, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return proc.ExitCode
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
