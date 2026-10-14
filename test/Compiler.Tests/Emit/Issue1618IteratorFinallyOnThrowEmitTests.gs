// <copyright file="Issue1618IteratorFinallyOnThrowEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1618 — an iterator's `try { … yield … } finally { … }` was
/// lowered by removing the CLR protected region and inlining the try body
/// followed by the finally, so the finally only ran on NORMAL completion.
/// If the try body threw (after resuming from a yield), the exception
/// propagated out of `MoveNext` and the finally was silently skipped —
/// a P0 violation of try/finally semantics (user cleanup such as closing a
/// file or releasing a lock would never run).
///
/// The fix keeps the user try/finally as a real CLR protected region in
/// `MoveNext`, so the runtime itself guarantees the finally runs on
/// every exit path (normal completion, an exception, or an early
/// return/break), while a `yield` suspend-leave is told apart via a state
/// guard so it does NOT prematurely run the finally.
///
/// Each fact uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed.
open class Issue1618IteratorFinallyOnThrowEmitTests {
    @Fact
    func Iterator_TryBodyThrowsAfterYield_RunsFinally_ThenPropagates() {
        // Runtime repro from the issue: `try { yield 1; Int32.Parse("boom") }
        // finally { ... }`, consumer catches. The finally must run even
        // though the try body throws instead of completing normally.
        const source = `package i1618throw
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        Int32.Parse("boom")
    } finally {
        Console.WriteLine("FINALLY RAN")
    }
}

func Main() int32 {
    try {
        for v in gen() {
            Console.WriteLine(v)
        }
    } catch (e Exception) {
        Console.WriteLine("caught")
    }
    Console.WriteLine("done")
    return 0
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "1${Environment.NewLine}FINALLY RAN${Environment.NewLine}caught${Environment.NewLine}done${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Iterator_TryFinally_NormalCompletion_RunsFinallyExactlyOnce() {
        const source = `package i1618normal
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
    } finally {
        Console.WriteLine("FINALLY RAN")
    }
}

func Main() int32 {
    for v in gen() {
        Console.WriteLine(v)
    }
    return 0
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}FINALLY RAN${Environment.NewLine}", output)
    }

    @Fact
    func Iterator_TryFinally_EarlyBreak_RunsFinallyOnceViaDispose() {
        const source = `package i1618break
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
        yield 3
    } finally {
        Console.WriteLine("FINALLY RAN")
    }
}

func Main() int32 {
    for v in gen() {
        Console.WriteLine(v)
        if v == 1 {
            break
        }
    }
    return 0
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}FINALLY RAN${Environment.NewLine}", output)
    }

    @Fact
    func Iterator_NestedTryFinally_ThrowInInnerAfterYield_RunsInnerThenOuterFinally() {
        // Nested try/finally inside an iterator: inner try yields then
        // throws. Both finallies must run, innermost first, before the
        // exception reaches the consumer's catch. Exercises the planner's
        // transitive suspend-state accumulation across nested protected
        // regions and inner-entry-inside-outer-region routing.
        const source = `package i1618nested
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            Int32.Parse("boom")
        } finally {
            Console.WriteLine("inner")
        }
    } finally {
        Console.WriteLine("outer")
    }
}

func Main() int32 {
    try {
        for v in gen() {
            Console.WriteLine(v)
        }
    } catch (e Exception) {
        Console.WriteLine("caught")
    }
    Console.WriteLine("done")
    return 0
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "1${Environment.NewLine}inner${Environment.NewLine}outer${Environment.NewLine}caught${Environment.NewLine}done${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Iterator_TryThrowsBeforeAnyYield_RunsFinally_ThenPropagates() {
        // The try body throws before ever reaching a yield (state machine
        // still at its initial dispatch point). A different yield elsewhere
        // in the method makes this an iterator. Finally must still run.
        const source = `package i1618prethrow
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        Int32.Parse("boom")
        yield 1
    } finally {
        Console.WriteLine("FINALLY RAN")
    }
    yield 2
}

func Main() int32 {
    try {
        for v in gen() {
            Console.WriteLine(v)
        }
    } catch (e Exception) {
        Console.WriteLine("caught")
    }
    Console.WriteLine("done")
    return 0
}`
        let output = CompileAndRun(source)
        Assert.Equal("FINALLY RAN${Environment.NewLine}caught${Environment.NewLine}done${Environment.NewLine}", output)
    }

    @Fact
    func Iterator_MultipleSequentialTryFinally_BothRun_ThrowInSecondCaught() {
        // Two independent (non-nested) try/finally regions in sequence
        // within the same iterator. First completes normally; second
        // yields then throws. Both finallies must run, in source order,
        // and the throw in the second must be caught after "b" prints.
        const source = `package i1618sequential
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
    } finally {
        Console.WriteLine("a")
    }
    try {
        yield 2
        Int32.Parse("boom")
    } finally {
        Console.WriteLine("b")
    }
}

func Main() int32 {
    try {
        for v in gen() {
            Console.WriteLine(v)
        }
    } catch (e Exception) {
        Console.WriteLine("caught")
    }
    Console.WriteLine("done")
    return 0
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "1${Environment.NewLine}a${Environment.NewLine}2${Environment.NewLine}b${Environment.NewLine}caught${Environment.NewLine}done${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1618_exe_").FullName
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
