// <copyright file="Issue1071AsyncOverrideEmitTests.cs" company="GSharp">
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

/// Issue #1071: an `async func` validly overrides a base method declared
/// `func M() Task` / `func M() Task[T]`, and validly implements an
/// interface method declared the same way. This emit test compiles and runs a
/// program that dispatches through a <em>base reference</em> to an async
/// override and through an <em>interface reference</em> to an async
/// implementation, awaiting both and asserting the observable effects/values —
/// confirming the overriding/implementing async methods occupy proper
/// override / interface-impl slots and the produced assembly IL-verifies and
/// runs.
open class Issue1071AsyncOverrideEmitTests {
    @Fact
    func AsyncOverrideAndInterfaceImpl_DispatchThroughBaseAndInterface_RunsCorrectly() {
        let source = `package p

import System
import System.Threading.Tasks

open class Base {
    public open func DoAsync() Task;
}

open class Derived : Base {
    public override async func DoAsync() {
        await Task.CompletedTask
        Console.WriteLine("override-ran")
    }
}

interface I { func GetAsync() Task[int32]; }

class C : I {
    public async func GetAsync() int32 {
        await Task.CompletedTask
        return 42
    }
}

let b Base = Derived()
b.DoAsync().GetAwaiter().GetResult()
let i I = C()
let v = i.GetAsync().GetAwaiter().GetResult()
Console.WriteLine(v)`
        let output = CompileAndRunThroughMetadataLoadContext(source)
        Assert.Equal("override-ran${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func AsyncOverrideOfImportedTaskMethod_MatchesAwaitedReturnType() {
        let source = `package p

import System
import System.Net
import System.Net.Http
import System.Threading
import System.Threading.Tasks

open class Handler : HttpMessageHandler {
    protected override async func SendAsync(
        request HttpRequestMessage,
        cancellationToken CancellationToken) HttpResponseMessage {
        await Task.CompletedTask
        return HttpResponseMessage(HttpStatusCode.OK)
    }
}

let client = HttpClient(Handler())
let response = client.GetAsync("https://example.invalid").GetAwaiter().GetResult()
Console.WriteLine(response.StatusCode)`
        let output = CompileAndRunThroughMetadataLoadContext(source)
        Assert.Equal("OK${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRunThroughMetadataLoadContext(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1071_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
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
