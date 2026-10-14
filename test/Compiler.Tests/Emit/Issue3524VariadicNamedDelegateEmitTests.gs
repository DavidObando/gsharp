// <copyright file="Issue3524VariadicNamedDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3524: a variadic parameter whose element type is a user-declared
/// named G# delegate crashed emit with GS9998 (`NotSupportedException:
/// Cannot resolve element type token for 'Spec'.`) from
/// `ImportedMemberRefFactory.GetElementTypeToken`. The method's
/// element-token cases handled structs/enums/interfaces but had no branch
/// for `DelegateTypeSymbol`,
/// so encoding the variadic parameter's slice/array element type (the named
/// delegate) fell through to the terminal throw. The same named delegate
/// worked fine as an ordinary, non-variadic parameter.
open class Issue3524VariadicNamedDelegateEmitTests {
    @Fact
    func EndToEnd_VariadicNamedDelegateParameter_Runs() {
        const source = `package FindingVariadicNamedDelegateArray

delegate Spec(value float64) float64;

func Apply(value float64, specs ... Spec) float64 {
  return specs[0](value)
}

func Main() int32 {
  let result = Apply(3.0, (value float64) -> value * 2.0)
  return result == 6.0 ? 0 : 1
}`
        let exitCode = CompileAndRun(source)
        Assert.Equal(0, exitCode)
    }

    shared {
        private func CompileAndRun(source string) int32 {
            let tempDir = Directory.CreateTempSubdirectory("gs_3524_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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
