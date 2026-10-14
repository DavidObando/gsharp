// <copyright file="Issue1088ConstructedGenericIdentityEmitTests.cs" company="GSharp">
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

/// Issue #1088 end-to-end coverage. Assigning the result of a constructed
/// generic factory method (e.g. `Channel.CreateBounded[BufferEntry](...)`)
/// to a variable of the SAME constructed generic type
/// (`Channel[BufferEntry]`) used to report a false
/// `GS0155: Cannot convert type 'Channel`1[BufferEntry]' to
/// 'Channel`1[BufferEntry]'` when the type argument was a
/// <em>same-compilation</em> user type (whose `ClrType` is `null`
/// during binding and erases to `object` on the closed
/// `ImportedTypeSymbol`).
///
/// The binder-level fix is covered by
/// `Issue1088GenericIdentityTests`; these tests additionally round-trip
/// the scenario through compile → IL-verify → run so a regression in the
/// constructed-generic identity comparison is caught end-to-end (the failing
/// case never even emitted, so an executable test is the strongest guard).
open class Issue1088ConstructedGenericIdentityEmitTests {
    @Fact
    func Channel_Factory_To_Same_Constructed_Generic_Roundtrips() {
        // The exact issue #1088 repro, lifted into an executable program: a
        // static factory returns Channel[BufferEntry] (a concrete BCL generic
        // class) and is assigned to a Channel[BufferEntry] local. The user type
        // BufferEntry erases to object on the closed ClrType, so this is the
        // path that spuriously failed before the fix.
        let source = `package P
import System
import System.Threading.Channels

class BufferEntry {
}

func make() Channel[BufferEntry] {
    return Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
}

var ch Channel[BufferEntry] = make()
var wrote = ch.Writer.TryWrite(BufferEntry())
Console.WriteLine(wrote)
Console.WriteLine(ch.Reader.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func Channel_Field_Of_Same_Constructed_Generic_Roundtrips() {
        // The field-initializer variant from the issue (FrameFilterBase's
        // private let filterChannel Channel[BufferEntry] = ...).
        let source = `package P
import System
import System.Threading.Channels

class BufferEntry {
}

class Holder {
    private let filterChannel Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))

    func WriteOne() bool {
        return this.filterChannel.Writer.TryWrite(BufferEntry())
    }
}

var h = Holder()
Console.WriteLine(h.WriteOne())`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    shared {
        // G# erases same-compilation user types used as CLR generic arguments to
        // System.Object on the closed type (the very erasure that #1088 is about).
        // When such a constructed BCL generic (e.g. Channel[BufferEntry]) flows
        // through a member that re-projects the argument (ch.Writer ->
        // ChannelWriter[BufferEntry]), ilverify sees ChannelWriter`1<object> on the
        // signature but ChannelWriter`1<BufferEntry> on the stack and reports a
        // verifier-only StackUnexpected. The CLR runtime accepts the erased form
        // (the tests below prove this by executing the program), so the code is
        // ignored here exactly as the unsafe-pointer emit tests do.
        private let ErasureIlVerifyIgnored[]string = []string{"StackUnexpected"}

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1088_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // System.Threading.Channels is not part of gsc's default implicit
                // reference set, so pass the relevant framework assemblies
                // explicitly (mirrors the binder test's reference resolver).
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
                            Ref("System.Threading.Channels.dll"),
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
                } catch { }
            }
        }
    }
}
