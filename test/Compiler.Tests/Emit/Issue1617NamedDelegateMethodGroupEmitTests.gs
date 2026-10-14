// <copyright file="Issue1617NamedDelegateMethodGroupEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1617 (drift 3): `EmitMethodGroupToNamedDelegate` — the emit path
/// for binding a method group to a user-declared (named) `delegate` type —
/// was missing two fixes that its twin `EmitMethodGroup` already carried:
/// - #1397: an INTERFACE-typed receiver must dispatch via `ldvirtftn` (not `ldftn`) so the delegate
/// invokes the concrete implementation through interface dispatch.
/// - #1467: a receiver of a user-declared GENERIC type must resolve the function token through a
/// MemberRef parented at the constructed receiver TypeSpec, because a bare MethodDef of a method on a
/// generic type is not a valid delegate-ctor function token (ilverify `DelegateCtor`).
/// Both shapes previously emitted an invalid function token — failing ilverify
/// and/or throwing at runtime — and both now verify and invoke the correct
/// method. Each test uses UNIQUE type/delegate names because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
///
/// The interface-receiver case below was previously blocked by issue
/// #1716 — a separate, pre-existing MethodDef row-reservation ordering bug —
/// and skipped until that was fixed. See
/// (cref:Issue1716DelegateOverInterfaceRowReservationEmitTests) for a
/// standalone regression test covering the general row-reservation fix
/// itself.
open class Issue1617NamedDelegateMethodGroupEmitTests {
    @Fact
    func EndToEnd_NamedDelegate_MethodGroupOverInterfaceReceiver_Runs() {
        const source = `package i1617ifacemg
import System

interface IGreeter1617 {
    func Greet() string;
}

class Greeter1617 : IGreeter1617 {
    func Greet() string { return "hello-1617" }
}

delegate StringFn1617() string;

func Main() {
    var g IGreeter1617 = Greeter1617()
    var d StringFn1617 = g.Greet
    System.Console.WriteLine(d.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello-1617${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NamedDelegate_MethodGroupOverGenericReceiver_Runs() {
        const source = `package i1617genmg
import System

class Box1617[T] {
    var value T
    var tag int32
    init(v T, t int32) {
        value = v
        tag = t
    }
    func Tag() int32 { return tag }
}

delegate IntFn1617() int32;

func Main() {
    var b = Box1617[int32](42, 7)
    var d IntFn1617 = b.Tag
    System.Console.WriteLine(d.Invoke())
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1617mg_exe_").FullName
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
                } catch { }
            }
        }
    }
}
