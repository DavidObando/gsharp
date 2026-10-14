// <copyright file="Issue3501SpanForeachTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #3501: `for x in span` over a `Span[T]` / `ReadOnlySpan[T]`.
/// The span enumerator's `Current` returns `ref T`, so the element
/// read must auto-dereference (ADR-0056 §1) — both in the binder (loop
/// variable types as `T`, not `T@`) and in the lowered IL
/// (`ldind` after `get_Current`). The enumerator is also byref-like:
/// on runtimes where ref structs implement `IDisposable` the disposal
/// wrap must be skipped because interface dispatch would box.
open class Issue3501SpanForeachTests {
    @Fact
    func SpanForeach_ElementValuesAndSlice_RunCorrectly() {
        const Source = `package Issue3501
import System

func Main() {
    var arr = []uint8{1, 2, 3, 42, 5}
    let span = arr.AsSpan()
    var sum = 0
    var hits = 0
    for b in span {
        if b != 42 {
            sum = sum + int32(b)
        } else {
            hits = hits + 1
        }
    }
    let tail = span.Slice(1)
    var tsum = 0
    for b in tail {
        tsum = tsum + int32(b)
    }
    Console.WriteLine(sum.ToString() + " " + hits.ToString() + " " + tsum.ToString())
}`
        Assert.Equal("11 1 52${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func ReadOnlySpanForeach_SumsElements() {
        const Source = `package Issue3501
import System

func Total(data System.ReadOnlySpan[int32]) int32 {
    var total = 0
    for value in data {
        total = total + value
    }
    return total
}

func Main() {
    var arr = []int32{10, 20, 12}
    Console.WriteLine(Total(arr.AsSpan()).ToString())
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3501", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3501.dll")
                File.WriteAllText(sourcePath, source)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                var previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$standardOut" + `
stderr:
` + "$standardError"))
                IlVerifier.Verify(outputPath)
                let assembly = EmittedFixture.Load(outputPath)
                let _ = assembly.GetTypes()
                let entryPoint = assembly.EntryPoint ??
                    throw InvalidOperationException("Emitted assembly has no entry point.")
                previousOut = Console.Out
                using let output = StringWriter()
                Console.SetOut(output)
                try {
                    entryPoint.Invoke(
                        nil,
                        if entryPoint.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                }
                return output.ToString()
            } finally {
                try {
                    Directory.Delete(outputDirectory, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
