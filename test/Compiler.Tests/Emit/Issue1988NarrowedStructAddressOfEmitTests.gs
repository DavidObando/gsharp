// <copyright file="Issue1988NarrowedStructAddressOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1988 (follow-up to #1917/#1982): `EmitAddressOf`'s
/// `BoundVariableExpression` case took the address of a smart-cast-narrowed
/// struct local (ADR-0069 — e.g. `&oa` after `oa is Money` narrows an
/// `object`-declared variable) via the raw `TryLoadVariableAddress`
/// path, pushing the address of the underlying `object` SLOT instead of an
/// unboxed pointer to the embedded `Money`. A subsequent `ldfld`
/// through that address recreates the exact #1917 ilverify defect
/// (`StackUnexpected: [found address of 'object'][expected ... 'Money']`).
/// Migrating to (cref:object)-narrowing-aware `TryLoadStructVariableAddress`
/// fixes it. The test checks the remaining pointer errors do not contain that
/// signature, scopes their suppression to `run`, and verifies runtime behavior.
open class Issue1988NarrowedStructAddressOfEmitTests {
    @Fact
    func AddressOf_NarrowedStructLocal_RunsAndDoesNotMistypeAsObjectAddress() {
        let source = `package P
import System

struct Wallet {
    var Cents int32
}

unsafe func run() {
    var a = Wallet{ Cents: 100 }
    var oa object = a
    if oa is Wallet {
        var p = &oa
        Console.WriteLine((*p).Cents)
    }
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    shared {
        private let PointerIlVerifyIgnored[]string = []string{"StackUnexpected", "UnmanagedPointer"}

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1988_").FullName
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
                try {
                    IlVerifier.Verify(outPath)
                } catch (ex XunitException) {
                    Assert.DoesNotContain("address of 'object'", ex.Message, StringComparison.Ordinal)
                }
                IlVerifier.Verify(
                    outPath,
                    ignoredErrorCodes: PointerIlVerifyIgnored,
                    ignoredErrorScope: "<Program>\\.run$$"
                )
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
