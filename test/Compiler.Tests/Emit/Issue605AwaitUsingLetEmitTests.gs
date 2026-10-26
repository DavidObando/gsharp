// <copyright file="Issue605AwaitUsingLetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Linq
import System.Text
import System.Threading
import System.Threading.Tasks
import Xunit
import Xunit.Sdk

/// Issue #605: `await using let` support for types implementing
/// `IAsyncDisposable`. Tests cover user-defined G# classes, CLR types,
/// mixed IDisposable + IAsyncDisposable, exception safety, return semantics,
/// and negative diagnostics (outside async, async-only with sync using).
open class Issue605AwaitUsingLetEmitTests {
    @Fact
    func ObserveCaptures_FaultedCopiesPreservePrimaryAndBothErrors() {
        using let outputPipe = AnonymousPipeServerStream(PipeDirection.Out)
        using let errorPipe = AnonymousPipeServerStream(PipeDirection.Out)
        outputPipe.DisposeLocalCopyOfClientHandle()
        errorPipe.DisposeLocalCopyOfClientHandle()
        using let outputSource = MemoryStream([]uint8{1})
        using let errorSource = MemoryStream([]uint8{2})
        let outputCopy = outputSource.CopyToAsync(outputPipe)
        let errorCopy = errorSource.CopyToAsync(errorPipe)
        let captures = Task.WhenAll([]Task{outputCopy, errorCopy})
        using let cancellation = CancellationTokenSource()
        let primary = "timed out after 2000 ms"
        let failure = ObserveCaptures(captures, cancellation, primary)
        Assert.True(outputCopy.IsFaulted)
        Assert.True(errorCopy.IsFaulted)
        let errors = Assert.IsType[AggregateException](captures.Exception)
        Assert.Equal(2, errors.InnerExceptions.Count)
        Assert.Equal(primary + "; output capture failed: $errors", failure)
        Assert.True(cancellation.IsCancellationRequested)
    }

    @Theory
    @InlineData("\n")
    @InlineData("\r\n")
    func CompileAndRunBytes_TimeoutReportsBothStreamsAndStopsChild(outputNewLine string) {
        let source = `import System
import System.Threading
Console.Write("timeout-stdoutPAYLOAD_NEWLINE")
Console.Error.Write("timeout-stderrPAYLOAD_NEWLINE")
Thread.Sleep(Timeout.Infinite)`.Replace("PAYLOAD_NEWLINE", outputNewLine.Replace("\r", "\\r").Replace("\n", "\\n"))
        let exception = Assert.ThrowsAny[XunitException](
            func () object? {
                return CompileAndRunBytes(source, timeoutMilliseconds: 2_000)
            }
        )
        Assert.Contains("timed out after 2000 ms", exception.Message, StringComparison.Ordinal)
        Assert.Contains("kill requested; exited=True", exception.Message, StringComparison.Ordinal)
        Assert.Contains("stdout capture=RanToCompletion; stderr capture=RanToCompletion", exception.Message)
        Assert.EndsWith(
            "\nstdout:\ntimeout-stdout$outputNewLine\nstderr:\ntimeout-stderr$outputNewLine",
            exception.Message,
            StringComparison.Ordinal
        )
        let pid = int32.Parse(exception.Message.Split("pid=", StringSplitOptions.None)[1].Split(';')[0])
        try {
            using let child = Process.GetProcessById(pid)
            Assert.True(child.HasExited, "Timed-out child $pid is still running.")
        } catch (ArgumentException) { }
    }

    @Fact
    func AwaitUsingLet_AsyncValueTaskDisposeAsync_ExactTopLevelRepro() {
        let source = `import System
import System.Threading.Tasks
class Resource : IAsyncDisposable {
    async func DisposeAsync() ValueTask {
        await Task.Delay(1)
    }
}
await using let resource = Resource()`
        Assert.Equal([]uint8{}, CompileAndRunBytes(source))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func AwaitUsingLet_AsyncValueTaskDisposeAsync_AwaitsLifoCleanupOnce(fail bool) {
        let source = `import System
import System.Threading.Tasks

class Resource : IDisposable, IAsyncDisposable {
    var Name string = ""
    let Started TaskCompletionSource[bool] = TaskCompletionSource[bool]()
    let Release TaskCompletionSource[bool] = TaskCompletionSource[bool]()

    func Dispose() {
        Console.Write("wrong-sync;")
    }

    async func DisposeAsync() ValueTask {
        Console.Write("begin:" + Name + ";")
        Started.SetResult(true)
        await Release.Task
        Console.Write("end:" + Name + ";")
    }
}

func Acquire(resource Resource) Resource {
    Console.Write("acquire:" + resource.Name + ";")
    return resource
}

async func Exercise(outer Resource, inner Resource, fail bool) int32 {
    await using let first = Acquire(outer)
    defer Console.Write("defer;")
    await using let second = Acquire(inner)
    Console.Write("body;")
    if fail {
        throw InvalidOperationException("body")
    }
    return 7
}

let outer = Resource()
outer.Name = "outer"
let inner = Resource()
inner.Name = "inner"
let pending = Exercise(outer, inner, FAIL)
if !inner.Started.Task.IsCompleted {
    throw InvalidOperationException("inner cleanup did not start")
}
Console.Write("pending:" + pending.IsCompleted.ToString() + ";")
inner.Release.SetResult(true)
await outer.Started.Task
Console.Write("outer-pending:" + pending.IsCompleted.ToString() + ";")
outer.Release.SetResult(true)
try {
    Console.Write("result:" + (await pending).ToString() + ";")
} catch (ex InvalidOperationException) {
    Console.Write("caught:" + ex.Message + ";")
}`
        let tail = if fail {
            "caught:body;"
        } else {
            "result:7;"
        }
        let expected = "acquire:outer;acquire:inner;body;begin:inner;pending:False;" +
            "end:inner;defer;begin:outer;outer-pending:False;end:outer;" +
            tail
        Assert.Equal(
            Encoding.UTF8.GetBytes(expected),
            CompileAndRunBytes(
                source.Replace(
                    "FAIL",
                    if fail {
                        "true"
                    } else {
                        "false"
                    }
                )
            )
        )
    }

    @Fact
    func AwaitUsingLet_UserClassImplementsIAsyncDisposable_DisposeAsyncCalledAtScopeExit() {
        let source = `package Probe
import System
import System.Threading.Tasks

class AsyncResource : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        Console.WriteLine("disposed-async")
        return ValueTask.CompletedTask
    }
}

async func test() {
    await using let r = AsyncResource{}
    Console.WriteLine("inside")
}
test().GetAwaiter().GetResult()`
        let output = CompileAndRun(source)
        Assert.Equal("inside${Environment.NewLine}disposed-async${Environment.NewLine}", output)
    }

    @Fact
    func AwaitUsingLet_ClrClassImplementsIAsyncDisposable_DisposeAsyncCalledAtScopeExit() {
        // We use a sibling C# assembly that prints on DisposeAsync to confirm it's called.
        let csHelper = `using System;
using System.Threading.Tasks;

namespace AsyncHelpers
{
    public class ClrAsyncDisp : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            Console.WriteLine("clr-disposed-async");
            return ValueTask.CompletedTask;
        }
    }
}`
        let source = `package Probe
import System
import System.Threading.Tasks
import AsyncHelpers

async func test() {
    await using let r = ClrAsyncDisp()
    Console.WriteLine("inside-clr")
}
test().GetAwaiter().GetResult()`
        let output = CompileAndRunWithSiblingCs(source, csHelper)
        Assert.Equal("inside-clr${Environment.NewLine}clr-disposed-async${Environment.NewLine}", output)
    }

    @Fact
    func AwaitUsingLet_TypeImplementsBothSyncAndAsync_PrefersDisposeAsync() {
        let source = `package Probe
import System
import System.Threading.Tasks

class DualDisp : IDisposable, IAsyncDisposable {
    func Dispose() {
        Console.WriteLine("sync-dispose")
    }
    func DisposeAsync() ValueTask {
        Console.WriteLine("async-dispose")
        return ValueTask.CompletedTask
    }
}

async func test() {
    await using let d = DualDisp{}
    Console.WriteLine("body")
}
test().GetAwaiter().GetResult()`
        let output = CompileAndRun(source)
        // await using must call DisposeAsync, NOT Dispose.
        Assert.Equal("body${Environment.NewLine}async-dispose${Environment.NewLine}", output)
    }

    @Fact
    func AwaitUsingLet_DisposeAsyncCalledEvenOnException() {
        let source = `package Probe
import System
import System.Threading.Tasks

class SafeRes : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        Console.WriteLine("safe-dispose")
        return ValueTask.CompletedTask
    }
}

async func test() {
    try {
        await using let s = SafeRes{}
        Console.WriteLine("before-throw")
        throw Exception("boom")
    } catch (ex Exception) {
        Console.WriteLine("caught")
    }
}
test().GetAwaiter().GetResult()`
        let output = CompileAndRun(source)
        Assert.Equal(
            "before-throw${Environment.NewLine}safe-dispose${Environment.NewLine}caught${Environment.NewLine}",
            output
        )
    }

    @Fact
    func AwaitUsingLet_ReturnsValueFromScope_DisposesBeforeReturn() {
        // Tests that DisposeAsync runs when the scope completes normally
        // and a value is returned from the function.
        let source = `package Probe
import System
import System.Threading.Tasks

class TrackRes : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        Console.WriteLine("track-dispose")
        return ValueTask.CompletedTask
    }
}

async func compute() int32 {
    var result = 0
    {
        await using let t = TrackRes{}
        Console.WriteLine("computing")
        result = 42
    }
    return result
}

let result = compute().GetAwaiter().GetResult()
Console.WriteLine("result=" + result.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal(
            "computing${Environment.NewLine}track-dispose${Environment.NewLine}result=42${Environment.NewLine}",
            output
        )
    }

    @Fact
    func AwaitUsingLet_OutsideAsyncFunction_ErrorsWithPreciseGS() {
        let source = `package Probe
import System
import System.Threading.Tasks

class Res : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        return ValueTask.CompletedTask
    }
}

func test() {
    await using let r = Res{}
    Console.WriteLine("nope")
}
test()`
        let errors = CompileExpectingErrors(source)
        Assert.Contains(errors, (e string) -> e.Contains("GS0271"))
    }

    @Fact
    func UsingLet_OnIAsyncDisposableOnlyType_StillErrorsBecauseNoSyncDispose() {
        let source = `package Probe
import System
import System.Threading.Tasks

class AsyncOnly : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        Console.WriteLine("async-only")
        return ValueTask.CompletedTask
    }
}

func test() {
    using let r = AsyncOnly{}
    Console.WriteLine("nope")
}
test()`
        let errors = CompileExpectingErrors(source)
        Assert.Contains(errors, (e string) -> e.Contains("GS0119"))
    }

    @Fact
    func UsingLet_OnSyncIDisposable_StillWorks() {
        // Regression: ensure the 6.4 using-let fix is unaffected.
        let source = `package Probe
import System

class SyncRes : IDisposable {
    func Dispose() {
        Console.WriteLine("sync-disposed")
    }
}

func test() {
    using let s = SyncRes{}
    Console.WriteLine("sync-inside")
}
test()`
        let output = CompileAndRun(source)
        Assert.Equal("sync-inside${Environment.NewLine}sync-disposed${Environment.NewLine}", output)
    }

    shared {
        private func ObserveCaptures(
            captures Task,
            captureCancellation CancellationTokenSource,
            failure string
        ) string {
            let failures = List[string]()
            if failure.Length > 0 {
                failures.Add(failure)
            }
            let cleanupTimeout = TimeSpan.FromSeconds(5)
            try {
                if Task.WhenAny(captures, Task.Delay(cleanupTimeout)).GetAwaiter().GetResult() != captures {
                    failures.Add("output streams did not close within 5000 ms")
                    captureCancellation.Cancel()
                    if Task.WhenAny(captures, Task.Delay(cleanupTimeout)).GetAwaiter().GetResult() != captures {
                        let _ = captures.ContinueWith(
                            (task Task) -> task.Exception,
                            TaskContinuationOptions.OnlyOnFaulted
                        )
                        failures.Add("output capture did not stop after cancellation")
                        return string.Join("; ", failures)
                    }
                }
                if captures.IsFaulted {
                    failures.Add("output capture failed: ${captures.Exception}")
                } else if captures.IsCanceled {
                    failures.Add("output capture cancelled")
                }
                return string.Join("; ", failures)
            } finally {
                captureCancellation.Cancel()
            }
        }

        private func CompileAndRun(source string) string -> Encoding
            .UTF8
            .GetString(CompileAndRunBytes(source))
            .ReplaceLineEndings(Environment.NewLine)

        private func CompileAndRunBytes(source string, timeoutMilliseconds int32 = 30_000)[]uint8 {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue605_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                using let stdout = MemoryStream()
                using let stderr = MemoryStream()
                using let captureCancellation = CancellationTokenSource()
                let outputCopy = proc.StandardOutput.BaseStream.CopyToAsync(stdout, captureCancellation.Token)
                let errorCopy = proc.StandardError.BaseStream.CopyToAsync(stderr, captureCancellation.Token)
                let captures = Task.WhenAll([]Task{outputCopy, errorCopy})
                var failure = string.Empty
                try {
                    if !proc.WaitForExit(timeoutMilliseconds) {
                        failure = "timed out after $timeoutMilliseconds ms"
                    }
                } finally {
                    try {
                        if !proc.HasExited {
                            failure += "; kill requested"
                            try {
                                proc.Kill(entireProcessTree: true)
                            } catch (InvalidOperationException) when proc.HasExited {
                                failure += "; exited before kill"
                            } catch (ex Win32Exception) {
                                failure += "; kill failed: " + ex.Message
                            }
                            failure += "; exited=${proc.WaitForExit(5_000)}"
                        }
                    } finally {
                        failure = ObserveCaptures(captures, captureCancellation, failure)
                    }
                }
                let exit = if proc.HasExited {
                    proc.ExitCode.ToString()
                } else {
                    "<still-running>"
                }
                let output = if outputCopy.IsCompleted {
                    Encoding.UTF8.GetString(stdout.ToArray())
                } else {
                    "<unavailable: output capture did not stop>"
                }
                let error = if errorCopy.IsCompleted {
                    Encoding.UTF8.GetString(stderr.ToArray())
                } else {
                    "<unavailable: error capture did not stop>"
                }
                Assert.True(
                    failure.Length == 0 && proc.ExitCode == 0,
                    (
                        "dotnet exec $failure; pid=${proc.Id}; exit=$exit; " +
                            "stdout capture=${outputCopy.Status}; stderr capture=${errorCopy.Status}" +
                            `
stdout:
` +
                            output +
                            `
stderr:
` +
                            error
                    )
                )
                return stdout.ToArray()
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func CompileAndRunWithSiblingCs(gsSource string, csHelper string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue605_sibling_").FullName
            try {
                // Compile the C# helper into a sibling DLL.
                let csDir = Path.Combine(tempDir, "csref")
                Directory.CreateDirectory(csDir)
                File.WriteAllText(Path.Combine(csDir, "Lib.cs"), csHelper)
                File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>Helper</AssemblyName>
  </PropertyGroup>
</Project>`)
                RunDotnet(csDir, "restore")
                RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
                let csDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Helper.dll")
                Assert.True(File.Exists(csDll), "Helper.dll not found at $csDll")
                // Now compile the G# source referencing the helper.
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, gsSource)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/reference:" + csDll
                }
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
                File.Copy(csDll, Path.Combine(tempDir, "Helper.dll"), overwrite: true)
                IlVerifier.Verify(outPath, additionalReferences: []string{csDll})
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

        private func RunDotnet(workingDir string, args ...string) {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(60_000), "dotnet ${args[0]} timed out")
            Assert.True(proc.ExitCode == 0, (`dotnet ` + "${args[0]}" + ` failed:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        }

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

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue605_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
