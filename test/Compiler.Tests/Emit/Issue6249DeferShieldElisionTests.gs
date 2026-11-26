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

    @Fact
    func DirectDriver_SkipsReferenceAssembly_WhenCopyingBundledRuntimeOverrides() {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_6249_reflib_" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
        try {
            let refDir = Path.Combine(tempDir, "ref")
            let libDir = Path.Combine(tempDir, "lib")
            let appDir = Path.Combine(tempDir, "app")
            Directory.CreateDirectory(refDir)
            Directory.CreateDirectory(libDir)
            Directory.CreateDirectory(appDir)

            let runtimeSrc = Path.Combine(tempDir, "RuntimeOverride.gs")
            File.WriteAllText(runtimeSrc, `package Gsharp.Runtime.Values
public shared class OverrideApi {
    public func Value() int32 -> 42
}`)
            let refPath = Path.Combine(refDir, "Gsharp.Runtime.Values.dll")
            let libPath = Path.Combine(libDir, "Gsharp.Runtime.Values.dll")
            InvokeGsc(
                []string{
                    "/out:" + libPath,
                    "/refout:" + refPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    runtimeSrc
                },
                excludeRuntimeValues: true
            )
            Assert.True(File.Exists(refPath))
            Assert.True(File.Exists(libPath))

            let appSrc = Path.Combine(tempDir, "App.gs")
            File.WriteAllText(appSrc, `import Gsharp.Runtime.Values
import System
func Main() {
    Console.WriteLine(OverrideApi.Value())
}`)
            let appOut = Path.Combine(appDir, "App.dll")
            // Supply ref/ BEFORE lib/ to verify ReferenceAssemblyAttribute skips ref/
            // and selects the implementation DLL.
            InvokeGsc(
                []string{
                    "/out:" + appOut,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/reference:" + refPath,
                    "/reference:" + libPath,
                    appSrc
                },
                excludeRuntimeValues: true
            )

            let copiedRuntime = Path.Combine(appDir, "Gsharp.Runtime.Values.dll")
            Assert.True(File.Exists(copiedRuntime), "Implementation runtime should be copied beside output.")
            Assert.Equal(File.ReadAllBytes(libPath), File.ReadAllBytes(copiedRuntime))

            let (exitCode, stdout, stderr) = RunDotnet(appOut)
            Assert.True(exitCode == 0, "App must run with implementation DLL. Exit ${exitCode}:\n${stderr}")
            Assert.Equal("42", stdout.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func DirectDriver_RefreshesCopiedRuntime_WhenSwitchingToOlderTimestampOverride() {
        let tempDir = Path.Combine(AppContext.BaseDirectory, "gs_6249_switch_" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(tempDir)
        try {
            let v1Dir = Path.Combine(tempDir, "v1")
            let v2Dir = Path.Combine(tempDir, "v2")
            let appDir = Path.Combine(tempDir, "app")
            Directory.CreateDirectory(v1Dir)
            Directory.CreateDirectory(v2Dir)
            Directory.CreateDirectory(appDir)

            let v1Src = Path.Combine(tempDir, "V1.gs")
            File.WriteAllText(v1Src, `package Gsharp.Runtime.Values
public shared class OverrideApi {
    public func Tag() string -> "v1"
}`)
            let v1Path = Path.Combine(v1Dir, "Gsharp.Runtime.Values.dll")
            InvokeGsc(
                []string{"/out:" + v1Path, "/target:library", "/targetframework:net10.0", "/nowarn:GS9100", v1Src},
                excludeRuntimeValues: true
            )

            let v2Src = Path.Combine(tempDir, "V2.gs")
            File.WriteAllText(v2Src, `package Gsharp.Runtime.Values
public shared class OverrideApi {
    public func Tag() string -> "v2"
}`)
            let v2Path = Path.Combine(v2Dir, "Gsharp.Runtime.Values.dll")
            InvokeGsc(
                []string{"/out:" + v2Path, "/target:library", "/targetframework:net10.0", "/nowarn:GS9100", v2Src},
                excludeRuntimeValues: true
            )

            // Make v2 intentionally older than v1 to prove content-based refresh.
            let v1Time = DateTime.UtcNow
            File.SetLastWriteTimeUtc(v1Path, v1Time)
            File.SetLastWriteTimeUtc(v2Path, v1Time.AddHours(-2.0))

            let appSrc = Path.Combine(tempDir, "App.gs")
            File.WriteAllText(appSrc, `import Gsharp.Runtime.Values
import System
func Main() {
    Console.WriteLine(OverrideApi.Tag())
}`)
            let appOut = Path.Combine(appDir, "App.dll")

            InvokeGsc(
                []string{
                    "/out:" + appOut,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/reference:" + v1Path,
                    appSrc
                },
                excludeRuntimeValues: true
            )
            let (exit1, stdout1, stderr1) = RunDotnet(appOut)
            Assert.True(exit1 == 0, "v1 run failed:\n${stderr1}")
            Assert.Equal("v1", stdout1.Trim())

            // Recompile into the same output directory with the older-dated v2 override.
            InvokeGsc(
                []string{
                    "/out:" + appOut,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/reference:" + v2Path,
                    appSrc
                },
                excludeRuntimeValues: true
            )
            let copiedRuntime = Path.Combine(appDir, "Gsharp.Runtime.Values.dll")
            Assert.Equal(File.ReadAllBytes(v2Path), File.ReadAllBytes(copiedRuntime))

            let (exit2, stdout2, stderr2) = RunDotnet(appOut)
            Assert.True(exit2 == 0, "v2 run failed:\n${stderr2}")
            Assert.Equal("v2", stdout2.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    private func InvokeGsc(extraArgs[]string, excludeRuntimeValues bool) {
        let args = List[string](extraArgs)
        for reference in TrustedPlatformAssemblies() {
            if excludeRuntimeValues && string.Equals(
                Path.GetFileNameWithoutExtension(reference),
                "Gsharp.Runtime.Values",
                StringComparison.OrdinalIgnoreCase
            ) {
                continue
            }
            args.Add("/reference:" + reference)
        }
        using let compileOut = StringWriter()
        using let compileErr = StringWriter()
        let prevOut = Console.Out
        let prevErr = Console.Error
        Console.SetOut(compileOut)
        Console.SetError(compileErr)
        var exitCode = 0
        try {
            exitCode = Program.Main(args.ToArray())
        } finally {
            Console.SetOut(prevOut)
            Console.SetError(prevErr)
        }
        let log = compileOut.ToString() + compileErr.ToString()
        Assert.True(exitCode == 0, "gsc failed (exit ${exitCode}):\n${log}")
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
