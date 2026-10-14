// <copyright file="Issue3214TopLevelAwaitForEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3214 — a statement-level top-level await (`await for … { }`,
/// `await using …`) carries its `await` as a keyword on the
/// statement syntax, so the ADR-0066 D3 pre-scan that flags the synthesized
/// `<Main>$` as async never saw it: the entry point stayed
/// synchronous and emit failed with GS9998 ("AwaitExpression is not yet
/// supported by the emitter") once the await-for lowering introduced its
/// `MoveNextAsync` awaits. The pre-scan now recognizes the statement
/// forms, and the existing #1904 async-entry machinery (state-machine
/// lowering plus the synchronous kickoff drive) does the rest. These facts
/// run the real `gsc`-compiled process — the file-mode surface.
/// Each fact uses a UNIQUE package name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed (see Issue1502 emit tests).
open class Issue3214TopLevelAwaitForEmitTests {
    @Fact
    func TopLevelAwaitFor_DrainsAsyncEnumerable_AndExitsZero() {
        const source = `package i3214awaitfor
import System
import System.Collections.Generic
import System.Threading.Tasks

async func Counts() IAsyncEnumerable[int32] {
    yield 1
    await Task.Yield()
    yield 2
    await Task.Yield()
    yield 3
}

var total = 0
await for v in Counts() {
    total = total + v
}
Console.WriteLine(total)`
        let output = CompileAndRun(source, expectedExitCode: 0)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    @Fact
    func TopLevelAwaitFor_ReturnValue_BecomesProcessExitCode() {
        const source = `package i3214awaitforexit
import System.Collections.Generic
import System.Threading.Tasks

async func Counts() IAsyncEnumerable[int32] {
    yield 20
    await Task.Yield()
    yield 22
}

var total = 0
await for v in Counts() {
    total = total + v
}
return total`
        CompileAndRun(source, expectedExitCode: 42)
    }

    @Fact
    func TopLevelAwaitUsing_DisposesAsynchronously() {
        const source = `package i3214awaitusing
import System
import System.Threading.Tasks

class Resource : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        Console.WriteLine("disposed")
        return ValueTask.CompletedTask
    }
}

{
    await using let r = Resource{}
    Console.WriteLine("body")
}
Console.WriteLine("after")`
        let output = CompileAndRun(source, expectedExitCode: 0)
        Assert.Equal("body${Environment.NewLine}disposed${Environment.NewLine}after${Environment.NewLine}", output)
    }

    shared {
        /// Copied verbatim from `Issue1904AsyncEntryPointEmitTests.CompileAndRun`
        /// (test/Compiler.Tests/Emit/Issue1904AsyncEntryPointEmitTests.cs): compiles
        /// with the real gsc driver, ilverifies, and runs the produced executable
        /// out-of-process so the CLR's entry-point signature validation is part of
        /// the assertion surface.
        private func CompileAndRun(source string, expectedExitCode int32) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3214_exe_").FullName
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
                Assert.True(
                    proc.ExitCode == expectedExitCode,
                    (`expected exit ` + "$expectedExitCode" + `, got ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                )
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
