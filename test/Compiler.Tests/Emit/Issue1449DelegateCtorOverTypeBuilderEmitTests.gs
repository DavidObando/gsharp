// <copyright file="Issue1449DelegateCtorOverTypeBuilderEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Runtime.InteropServices
import Xunit

/// Issue #1449 — emitting a function-literal event handler whose delegate type
/// is a constructed generic (`Action<object, EventArgs>`) crashed
/// with GS9998 "NotSupportedException: TypeBuilder generic instantiation does
/// not support resolving members." The delegate's CLR type is realized as a
/// reflection-emit `TypeBuilderInstantiation` (the event sender slot is a
/// host-runtime `object` while the `EventArgs` argument is loaded
/// through the reference (cref:System.Reflection.MetadataLoadContext)),
/// so calling `GetConstructors()` on it throws. The emitter now resolves
/// the delegate's canonical `(object, IntPtr)` constructor from the open
/// generic definition instead.
///
/// Reproducing the crash requires compiling with explicit reference assemblies
/// so the BCL types flow through a MetadataLoadContext (matching how gsc is
/// driven in real builds); the in-process default reference set resolves every
/// type to a host runtime type and never produces the mixed-context
/// instantiation. The tests therefore pass the host shared framework as
/// `/r:` references.
open class Issue1449DelegateCtorOverTypeBuilderEmitTests {
    @Fact
    func EndToEnd_NonCapturingEventHandlerLambda_Runs() {
        // Action<object, EventArgs>-shaped delegate ctor over a
        // TypeBuilderInstantiation, no-capture closure branch.
        let source = `package Issue1449NoCapture
import System

class Notifier1449NC {
    event Updated (object?, EventArgs) -> void

    func Raise() {
        Updated?(this, EventArgs())
    }
}

func Main() {
    let n = Notifier1449NC()
    n.Updated += (s object?, e EventArgs) -> Console.WriteLine("handled")
    n.Raise()
}`
        let output = CompileAndRun(source)
        Assert.Equal("handled${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_CapturingEventHandlerLambda_Runs() {
        // Same constructed-generic delegate ctor, but the handler captures an
        // outer variable so it flows through the capture-bearing closure
        // branch.
        let source = `package Issue1449Capture
import System

class Counter1449C {
    var total int32 = 0
}

class Notifier1449C {
    event Updated (object?, EventArgs) -> void

    func Raise() {
        Updated?(this, EventArgs())
    }
}

func Main() {
    let c = Counter1449C()
    let n = Notifier1449C()
    n.Updated += (s object?, e EventArgs) -> Console.WriteLine(c.total + 5)
    n.Raise()
    n.Raise()
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1449_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // Issue #1449 only reproduces when BCL types are resolved through a
                // MetadataLoadContext (engaged by passing explicit /r: references),
                // which is how gsc is invoked in real builds. Reference the host
                // shared framework so EventArgs is an MLC type while the event
                // sender stays a host-runtime object — the mixed-context
                // instantiation that produced the original crash.
                let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                for refDll in Directory.GetFiles(runtimeDir, "*.dll") {
                    args.Add("/r:" + refDll)
                }
                args.Add(srcPath)
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
