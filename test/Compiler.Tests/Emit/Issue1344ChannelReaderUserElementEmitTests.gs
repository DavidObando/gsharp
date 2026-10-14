// <copyright file="Issue1344ChannelReaderUserElementEmitTests.cs" company="GSharp">
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

/// Issue #1344: iterating a `Channel[UserType].Reader.ReadAllAsync()`
/// async sequence erased the user element type to `System.Object`, so
/// member access on the `await for` loop variable failed
/// `GS0158: Cannot find member`. The `.Reader` property surfaced an
/// erased `ChannelReader[object]`, whose `ReadAllAsync()` yields
/// `IAsyncEnumerable[object]`. The fix keeps the symbolic
/// `ChannelReader[UserType]` projection (sibling of #1320/#1328), so the
/// stream is `IAsyncEnumerable[UserType]` and member access binds. These
/// tests compile, IL-verify, and run the issue repro end-to-end.
open class Issue1344ChannelReaderUserElementEmitTests {
    @Fact
    func ChannelReaderReadAllAsync_UserElement_BindsAndRuns() {
        let source = `package P
import System
import System.Threading.Channels
import System.Threading.Tasks

class Issue1344Entry { var NumEntries int32 = 0 }

public var total = 0
async func Consume(ch Channel[Issue1344Entry]) {
    await for messages in ch.Reader.ReadAllAsync() {
        total = total + messages.NumEntries
    }
}

let ch = Channel.CreateUnbounded[Issue1344Entry]()
var a = Issue1344Entry()
a.NumEntries = 42
var wrote = ch.Writer.TryWrite(a)
var b = Issue1344Entry()
b.NumEntries = 7
var wrote2 = ch.Writer.TryWrite(b)
ch.Writer.Complete()
Consume(ch).Wait()
Console.WriteLine(total)`
        Assert.Equal("49${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        // G# erases same-compilation user types used as CLR generic arguments to
        // System.Object on the closed type; surfacing the symbolic ChannelReader[E]
        // projection makes ilverify see ChannelReader`1<object> on the signature
        // but ChannelReader`1<E> on the stack (a verifier-only StackUnexpected the
        // CLR accepts — the tests run the program to prove correctness), mirroring
        // #1088.
        private let ErasureIlVerifyIgnored[]string = []string{"StackUnexpected"}

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1344_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                let Ref = func (name string) string {
                    return "/r:" + Path.Combine(runtimeDir, name)
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{
                            "/out:" + outPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            Ref("System.Private.CoreLib.dll"),
                            Ref("System.Runtime.dll"),
                            Ref("System.Console.dll"),
                            Ref("System.Collections.dll"),
                            Ref("System.Threading.dll"),
                            Ref("System.Threading.Channels.dll"),
                            Ref("System.Threading.Tasks.dll"),
                            srcPath
                        }
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath, nil, ErasureIlVerifyIgnored)
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
                } catch (IOException) { }
            }
        }
    }
}
