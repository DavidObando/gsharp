// <copyright file="Issue3566SequenceToNonGenericEnumerableTests.cs" company="GSharp">
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

/// Issue #3566 (emit side): the `sequence[T]` → non-generic
/// `System.Collections.IEnumerable` upcast the binder's semantic arm
/// admits must emit as a no-op reference conversion. Without the matching
/// `IsReferenceCompatible` arm the emitter threw NotSupportedException
/// (GS9998) for exactly the conversions the classifier had just accepted.
open class Issue3566SequenceToNonGenericEnumerableTests {
    @Fact
    func SequenceUpcastToIEnumerable_EmitsAndRuns() {
        const Source = `package Issue3566
import System
import System.Collections
import System.Linq

func Flatten(xs sequence[string]) IEnumerable {
    return xs
}

func Main() {
    let seq = []string{"a", "b", "c"}.AsEnumerable()
    var count = 0
    for item in Flatten(seq) {
        count = count + 1
    }
    Console.WriteLine(count.ToString())
}`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func OfTypeOnSequenceReceiver_EmitsAndRuns() {
        const Source = `package Issue3566
import System
import System.Linq

func CountStrings(xs sequence[object]) int32 {
    return xs.OfType[string]().Count()
}

func Main() {
    let items = []object{"a", 1, "b"}.AsEnumerable()
    Console.WriteLine(CountStrings(items).ToString())
}`
        Assert.Equal("2${Environment.NewLine}", CompileAndRun(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3566", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3566.dll")
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
