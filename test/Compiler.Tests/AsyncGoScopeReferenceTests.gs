// <copyright file="AsyncGoScopeReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Regression tests for #291: spawning an `async func` with `go`
/// inside a `scope` must (a) join the spawned (cref:System.Threading.Tasks.Task)
/// before the scope completes and (b) emit valid IL for the go-thunk even when
/// the spawned func awaits an imported `Task<T>` instance method.
/// @remarks The defect only manifests in <em>cross-targeting</em> compilations — those
/// passing explicit `/reference` paths, which load BCL types through a
/// (cref:System.Reflection.MetadataLoadContext). In that context the
/// resolved `System.Threading.Tasks.Task` has a different (cref:Type)
/// identity than the gsc host's `Task`, so the old
/// `typeof(Task).IsAssignableFrom(...)` async detection returned false and
/// the go-thunk was emitted as an `Action` that discarded the spawned
/// `Task` (no join) and produced invalid IL when arguments were captured.
/// The default conformance harness compiles in the host context and therefore
/// cannot exercise this path, so this test drives the references path directly.
open class AsyncGoScopeReferenceTests {
    @Fact
    func GoScope_AsyncFuncs_JoinAndEmitValidIl_UnderReferences() {
        // Covers both void-like (no value) and value-returning async funcs, and
        // an await on an imported Task<T> instance method (StringReader.ReadToEndAsync).
        const source = `
package Demo

import System
import System.IO
import System.Threading.Tasks

var reader = StringReader("payload")

async func readIt(r StringReader) {
    var text = await r.ReadToEndAsync()
    Console.WriteLine("read=$text")
}

async func makeValue() int32 {
    await Task.Delay(5)
    Console.WriteLine("value=42")
    return 42
}

scope {
    go readIt(reader)
    go makeValue()
}

Console.WriteLine("done")
`
        let tempDir = Directory.CreateTempSubdirectory("gs_async_go_ref_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, "Program.dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            // Force the MetadataLoadContext reference path by passing the host's
            // own runtime assemblies as explicit references. These are always
            // present wherever the test runs.
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
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
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            Assert.True(File.Exists(outPath), "expected emitted assembly")
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
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + ` (invalid IL would surface as InvalidProgramException)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            let lines = stdout.ReplaceLineEndings(Environment.NewLine).Split(
                Environment.NewLine,
                StringSplitOptions.RemoveEmptyEntries
            )
            // Both spawned async tasks must have run to completion (structured join)...
            Assert.Contains("read=payload", lines)
            Assert.Contains("value=42", lines)
            // ...and the scope must join before the trailing top-level statement,
            // so "done" is the final line emitted.
            Assert.Equal("done", lines[^1])
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
