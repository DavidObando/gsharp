// <copyright file="Issue3750ElidedExtensionHolderEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3750 — cs2gs lowers a C# extension-holder `static class` to
/// top-level receiver-clause funcs and keeps the (now empty) holder alive when
/// something still names it in a `typeof`. This is the gsc-side proof that
/// the shape cs2gs emits does not merely bind: the empty holder reaches
/// metadata as a real type in the emitted assembly, so
/// `typeof(Holder).Assembly.Location` — the idiom both migrated call sites
/// use — answers the emitted assembly, while the lifted extension still
/// dispatches through the receiver form.
open class Issue3750ElidedExtensionHolderEmitTests {
    @Fact
    func EndToEnd_TypeOfRetainedExtensionHolder_ResolvesAndNamesEmittedAssembly() {
        let source = `package Probe3750
import System

class NamedParamsExtensionFixture3750 {
}

func (source string) Describe3750(statusCode int32) string ->
    source + ":" + statusCode.ToString()

func Main() {
    let holder = typeof(NamedParamsExtensionFixture3750)
    Console.WriteLine(holder.Name)
    Console.WriteLine(holder.Assembly.Location == typeof(Probe3750Marker).Assembly.Location)
    Console.WriteLine("ok".Describe3750(200))
}

class Probe3750Marker {
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "NamedParamsExtensionFixture3750${Environment.NewLine}True${Environment.NewLine}ok:200${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3750_exe_").FullName
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) {
                    // Best-effort cleanup of the temp compile directory.

                } catch (UnauthorizedAccessException) {
                    // Best-effort cleanup of the temp compile directory.

                }
            }
        }
    }
}
