// <copyright file="Issue2787IteratorUsingEarlyExitEmitTests.cs" company="GSharp">
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

/// Issue #2787: control flow may bypass or re-enter a using declaration, so
/// cleanup must track initialization and all emitted branches must remain legal.
open class Issue2787IteratorUsingEarlyExitEmitTests {
    @Fact
    func Using_LeaveAndReenter_DisposesResourceOnce() {
        const source = `package i2787reentersync
import System

public var trace = ""

class Resource : IDisposable {
    init() {
        trace = trace + "+"
    }
    func Dispose() {
        trace = trace + "-"
    }
}

func run() {
    var pass = 0
    {
        using let resource = Resource{}
        inside:
        {
            trace = trace + "B"
            if pass == 0 {
                pass = 1
                goto outside
            }
            goto done
        }
    }
    outside:
    {
        trace = trace + "O"
        pass = 2
        goto inside
    }
    done:
    {
    }
}

run()
Console.WriteLine(trace)`
        Assert.Equal("+B-OB${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AwaitUsing_LeaveAndReenter_DisposesResourceOnce() {
        const source = `package i2787reenterasync
import System
import System.Threading.Tasks

public var trace = ""

class Resource : IAsyncDisposable {
    init() {
        trace = trace + "+"
    }
    func DisposeAsync() ValueTask {
        trace = trace + "-"
        return ValueTask.CompletedTask
    }
}

async func run() {
    var pass = 0
    {
        await using let resource = Resource{}
        await Task.Yield()
        inside:
        {
            trace = trace + "B"
            if pass == 0 {
                pass = 1
                goto outside
            }
            goto done
        }
    }
    outside:
    {
        trace = trace + "O"
        pass = 2
        goto inside
    }
    done:
    {
    }
}

run().GetAwaiter().GetResult()
Console.WriteLine(trace)`
        Assert.Equal("+B-OB${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GotoIntoCatch_IsRejected() {
        const source = `package i2787catchentry
import System

func run() {
    goto handler
    try {
        throw Exception("boom")
    } catch (ex Exception) {
        handler:
        {
        }
    }
}`
        Assert.Contains(CompileExpectingErrors(source), (line string) -> line.Contains("GS0498"))
    }

    @Fact
    func GotoIntoFinally_IsRejected() {
        const source = `package i2787finallyentry

func run() {
    goto handler
    try {
    } finally {
        handler:
        {
        }
    }
}`
        Assert.Contains(CompileExpectingErrors(source), (line string) -> line.Contains("GS0498"))
    }

    @Fact
    func GotoWithinExceptionHandlers_RemainsLegal() {
        const source = `package i2787handlerlocal
import System

public var trace = ""

func run() {
    try {
        throw Exception("boom")
    } catch (ex Exception) {
        goto caught
        caught:
        {
            trace = trace + "C"
        }
    }
    try {
    } finally {
        goto cleaned
        cleaned:
        {
            trace = trace + "F"
        }
    }
}

run()
Console.WriteLine(trace)`
        Assert.Equal("CF${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OrdinaryMethod_GotoBeforeUsing_SkipsUninitializedCleanup() {
        const source = `package i2787ordinarysync
import System

public var trace = ""

class Resource : IDisposable {
    init() {
        trace = trace + "+"
    }
    func Dispose() {
        trace = trace + "-"
    }
}

func run(skip bool) {
    if skip {
        goto done
    }
    using let resource = Resource{}
    trace = trace + "B"
    done:
    {
        trace = trace + "E"
    }
}

run(true)
trace = trace + "|"
run(false)
Console.WriteLine(trace)`
        Assert.Equal("E|+BE-${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func OrdinaryAsyncMethod_GotoBeforeUsing_SkipsUninitializedCleanup() {
        const source = `package i2787ordinaryasync
import System
import System.Threading.Tasks

public var trace = ""

class Resource : IDisposable {
    init() {
        trace = trace + "+"
    }
    func Dispose() {
        trace = trace + "-"
    }
}

async func run(skip bool) {
    if skip {
        goto done
    }
    using let resource = Resource{}
    await Task.Yield()
    trace = trace + "B"
    done:
    {
        trace = trace + "E"
    }
}

run(true).GetAwaiter().GetResult()
trace = trace + "|"
run(false).GetAwaiter().GetResult()
Console.WriteLine(trace)`
        Assert.Equal("E|+BE-${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AsyncIterator_MissingFileGotoBeforeUsing_EnumeratesEmpty() {
        const source = `package i2787missing
import System
import System.IO
import System.Collections.Generic
import System.Threading.Tasks

async func read(path string) IAsyncEnumerable[int32] {
    if !File.Exists(path) {
        goto done
    }
    using let reader = StreamReader(path)
    while await reader.ReadLineAsync() != nil {
        yield 1
    }
    done:
    {
    }
}

async func run() {
    var count = 0
    await for value in read(Path.Combine(Path.GetTempPath(), "i2787-" + Guid.NewGuid().ToString("n"))) {
        count++
    }
    Console.WriteLine("count=" + count.ToString())
}
run().GetAwaiter().GetResult()`
        Assert.Equal("count=0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func SyncIterator_GotoBeforeUsing_SkipsCleanup() {
        const source = `package i2787syncskip
import System
import System.Collections.Generic

public var trace = ""

class Resource : IDisposable {
    init() {
        trace = trace + "+"
    }
    func Dispose() {
        trace = trace + "-"
    }
}

func values(skip bool) IEnumerable[int32] {
    if skip {
        goto done
    }
    using let resource = Resource{}
    yield 1
    done:
    {
    }
}

for value in values(true) {
    trace = trace + "value"
}
Console.WriteLine(trace)`
        Assert.Equal(Environment.NewLine, CompileAndRun(source))
    }

    @Fact
    func AsyncIterator_NestedUsings_EarlyConsumerBreak_DisposesInReverseOrder() {
        const source = `package i2787order
import System
import System.Collections.Generic
import System.Threading.Tasks

public var trace = ""

class Resource : IDisposable {
    private let name string
    init(name string) {
        this.name = name
        trace = trace + "+" + name
    }
    func Dispose() {
        trace = trace + "-" + name
    }
}

async func values() IAsyncEnumerable[int32] {
    using let outer = Resource("A")
    {
        using let inner = Resource("B")
        await Task.Yield()
        yield 1
        yield 2
    }
}

async func run() {
    let enumerator = values().GetAsyncEnumerator()
    await enumerator.MoveNextAsync()
    await enumerator.DisposeAsync()
}
run().GetAwaiter().GetResult()
Console.WriteLine(trace)`
        Assert.Equal("+A+B-B-A${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AsyncIterator_GotoBetweenUsings_DisposesOnlyInitializedResource() {
        const source = `package i2787partial
import System
import System.Collections.Generic

public var trace = ""

class Resource : IDisposable {
    private let name string
    init(name string) {
        this.name = name
        trace = trace + "+" + name
    }
    func Dispose() {
        trace = trace + "-" + name
    }
}

async func values() IAsyncEnumerable[int32] {
    using let first = Resource("A")
    goto done
    using let second = Resource("B")
    yield 1
    done:
    {
    }
}

async func run() {
    await for value in values() {
        trace = trace + "value"
    }
}
run().GetAwaiter().GetResult()
Console.WriteLine(trace)`
        Assert.Equal("+A-A${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AsyncIterator_GotoAndException_DisposeInitializedResource() {
        const source = `package i2787exits
import System
import System.Collections.Generic

public var trace = ""

class Resource : IDisposable {
    init() {
        trace = trace + "+"
    }
    func Dispose() {
        trace = trace + "-"
    }
}

async func values(mode int32) IAsyncEnumerable[int32] {
    using let resource = Resource{}
    if mode == 0 {
        goto done
    }
    yield 1
    throw Exception("boom")
    done:
    {
    }
}

async func run() {
    await for value in values(0) {
        trace = trace + "value"
    }
    trace = trace + "|"
    try {
        await for value in values(1) {
        }
    } catch (ex Exception) {
        trace = trace + "!"
    }
}
run().GetAwaiter().GetResult()
Console.WriteLine(trace)`
        Assert.Equal("+-|+-!${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AsyncIterator_AwaitUsing_DisposesOnlyInitializedResources() {
        const source = `package i2787awaitusing
import System
import System.Collections.Generic
import System.Threading.Tasks

public var trace = ""

class Resource : IAsyncDisposable {
    init() {
        trace = trace + "+"
    }
    func DisposeAsync() ValueTask {
        trace = trace + "-"
        return ValueTask.CompletedTask
    }
}

async func values(skip bool) IAsyncEnumerable[int32] {
    if skip {
        goto done
    }
    await using let resource = Resource{}
    yield 1
    done:
    {
    }
}

async func run() {
    await for value in values(true) {
        trace = trace + "bad"
    }
    let enumerator = values(false).GetAsyncEnumerator()
    await enumerator.MoveNextAsync()
    await enumerator.DisposeAsync()
}
run().GetAwaiter().GetResult()
Console.WriteLine(trace)`
        Assert.Equal("+-${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Using_Return_DisposesInitializedResourcesInReverseOrder() {
        const source = `package i2787return
import System

public var trace = ""

class Resource : IDisposable {
    private let name string
    init(name string) {
        this.name = name
        trace = trace + "+" + name
    }
    func Dispose() {
        trace = trace + "-" + name
    }
}

func value() int32 {
    using let outer = Resource("A")
    using let inner = Resource("B")
    return 42
}

Console.WriteLine(value().ToString() + ":" + trace)`
        Assert.Equal("42:+A+B-B-A${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_2787_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(assemblyPath)
                let processInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                processInfo.ArgumentList.Add("exec")
                processInfo.ArgumentList.Add("--runtimeconfig")
                processInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
                processInfo.ArgumentList.Add(assemblyPath)
                using let process = Process.Start(processInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let directory = Directory.CreateTempSubdirectory("gs_2787_error_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let assemblyPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + assemblyPath, "/target:library", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.NotEqual(0, exitCode)
                return (compileOut.ToString() + compileErr.ToString())
                    .Split(Environment.NewLine)
                    .Where((line string) -> !string.IsNullOrWhiteSpace(line))
                    .ToList()
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }
    }
}
