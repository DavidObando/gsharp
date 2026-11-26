// <copyright file="Issue6249DeferShieldElisionTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #6249: plain synchronous `defer` must elide the unused cancellation
/// shield so emitted assemblies do not pull in `Gsharp.Runtime.Channels`, while
/// suspending `defer` inside `scope` still keeps the shield and completes
/// cleanup after cancellation.
class Issue6249DeferShieldElisionTests {
    private const RunTimeout int32 = 30000

    @Fact
    func PlainSynchronousDefer_DoesNotReferenceChannelsRuntime_AndRunsCleanup() {
        let source = `package Repro

import System
import System.Text
import System.Threading

class Guarded {
    private let gate object = Object()
    private var value int32 = 0

    func SetAndRead(next int32) int32 {
        Monitor.Enter(gate)
        defer Monitor.Exit(gate)
        value = next
        return value
    }

    func LifoTrace(sb StringBuilder) {
        defer sb.Append("1")
        defer sb.Append("2")
        sb.Append("body:")
    }
}

func Main() {
    let g = Guarded()
    Console.WriteLine(g.SetAndRead(42))
    // Re-acquiring the monitor proves defer Monitor.Exit ran.
    Console.WriteLine(g.SetAndRead(99))
    let sb = StringBuilder()
    g.LifoTrace(sb)
    Console.WriteLine(sb.ToString())
}`
        let (refs, output) = CompileAndRun("plain_defer", source)
        Assert.DoesNotContain("Gsharp.Runtime.Channels", refs)
        Assert.Equal("42|99|body:21", output)
    }

    @Fact
    func SuspendingDeferInScope_KeepsShield_AndCompletesCleanup() {
        let source = `import System
import System.Threading

func Record(ch chan[int32], value int32) {
    ch <- value
}

func Main() {
    let ch = chan[int32](2)
    scope {
        defer Record(ch, 7)
    }
    Console.WriteLine(<-ch)
}`
        let (refs, output) = CompileAndRun("suspending_defer_scope", source)
        Assert.Contains("Gsharp.Runtime.Channels", refs)
        Assert.Equal("7", output)
    }

    private func CompileAndRun(name string, source string)(HashSet[string], string) {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_6249_" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
        try {
            let srcPath = Path.Combine(tempDir, name + ".gs")
            let outPath = Path.Combine(tempDir, name + ".dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
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
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            let log = compileOut.ToString() + compileErr.ToString()
            Assert.True(File.Exists(outPath), "${name} must compile. Log:\n${log}")
            IlVerifier.Verify(outPath)
            let refs = ReadAssemblyReferences(outPath)
            let (exitCode, stdout, stderr) = RunDotnet(outPath)
            Assert.True(exitCode == 0, "${name} must run to completion. Exit ${exitCode}:\n${stderr}")
            let lines = stdout
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
            return (refs, string.Join("|", lines))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    private func ReadAssemblyReferences(assemblyPath string) HashSet[string] {
        let refs = HashSet[string](StringComparer.OrdinalIgnoreCase)
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        for handle in reader.AssemblyReferences {
            refs.Add(reader.GetString(reader.GetAssemblyReference(handle).Name))
        }
        return refs
    }

    private func TrustedPlatformAssemblies() IEnumerable[string] {
        let raw = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
        if string.IsNullOrEmpty(raw) {
            return Array.Empty[string]()
        }
        return raw.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
    }

    private func RunDotnet(assemblyPath string)(int32, string, string) {
        let configPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json")
        File.WriteAllText(
            configPath,
            `{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.0"}}}`
        )
        let psi = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        psi.ArgumentList.Add("exec")
        psi.ArgumentList.Add(assemblyPath)
        using let proc = Process.Start(psi)!!
        let stdoutTask = proc.StandardOutput.ReadToEndAsync()
        let stderrTask = proc.StandardError.ReadToEndAsync()
        let exited = proc.WaitForExit(RunTimeout)
        if !exited {
            proc.Kill(entireProcessTree: true)
            throw TimeoutException("Timed out running " + assemblyPath)
        }
        return (proc.ExitCode, stdoutTask.GetAwaiter().GetResult(), stderrTask.GetAwaiter().GetResult())
    }
}
