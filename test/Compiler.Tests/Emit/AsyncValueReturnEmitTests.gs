// <copyright file="AsyncValueReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Regression tests for issue #290: an `async func` that returns a value
/// type (so the kickoff returns `Task<T>` for a value `T`)
/// crashed `gsc` under the SDK build path. That path supplies reference
/// assemblies through a (cref:System.Reflection.MetadataLoadContext), and
/// constructing `Task<T>` with a host-runtime type argument threw
/// (cref:ArgumentException) ("was not loaded by the MetadataLoadContext
/// that loaded the generic type or method"). These tests reproduce the SDK path
/// by compiling with explicit `/reference` arguments, which forces the
/// binder onto the MetadataLoadContext-backed resolver.
open class AsyncValueReturnEmitTests {
    @Fact
    func Async_Func_Returning_Value_Types_Compiles_And_Runs_Through_MetadataLoadContext() {
        // Each async func below forces WrapAsTask / ResolveAsyncReturnClrType to
        // build Task<T> for a value (or reference) T while the binder is on the
        // MetadataLoadContext-backed resolver — the exact path that crashed in
        // #290. The runtime portion only needs to confirm the emitted assembly
        // loads and runs without the MetadataLoadContext mismatch.
        let source = `package P

import System
import System.Threading.Tasks

async func asyncInt() int32 {
    await Task.Delay(1)
    return 21 * 2
}

async func asyncBool() bool {
    await Task.Delay(1)
    return true
}

async func asyncFloat() float64 {
    await Task.Delay(1)
    return 3.5 + 1.0
}

async func asyncString() string {
    await Task.Delay(1)
    return "hi"
}

let ti = asyncInt()
let tb = asyncBool()
let tf = asyncFloat()
let ts = asyncString()
Console.WriteLine("done")`
        let output = CompileAndRunThroughMetadataLoadContext(source)
        Assert.Equal("done${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunThroughMetadataLoadContext(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_async_mlc_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // Passing /reference paths makes ReferenceResolver load them into an
                // isolated MetadataLoadContext, exactly as the SDK build does. Using
                // the host runtime's assemblies keeps the test self-contained.
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                let references = Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> Path.GetFileName(p).StartsWith("System.", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(Path.GetFileName(p), "mscorlib.dll", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(Path.GetFileName(p), "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                )
                    .ToArray()
                Assert.NotEmpty(references)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                    args.AddRange(references.Select((r string) -> ("/reference:" + r)))
                    args.Add(srcPath)
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
                Assert.True(File.Exists(outPath), "expected emitted assembly at $outPath")
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
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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
