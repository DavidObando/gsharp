// <copyright file="Issue3501LambdaWhilePatternCaptureTests.cs" company="GSharp">
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

/// Issue #3501: a `while value is T binding { … }` inside a function literal
/// crashed emit with GS9998 ("Variable 'binding' has no local slot"). The
/// loop's bound shape places the body before the controlling condition, so
/// the lambda capture collector walked the pattern binding's reads before
/// `RewritePattern` recorded the declaration and misclassified the
/// binding as an enclosing-scope capture — the same order dependency inline
/// out-vars had (issue #1451). Pattern bindings are now pre-seeded.
open class Issue3501LambdaWhilePatternCaptureTests {
    @Fact
    func WhilePatternBindingInLambda_RunsCorrectly() {
        const Source = `package Issue3501
import System

class Box {
    let Inner object
    init(inner object) { Inner = inner }
}

func Unwrap(value object) object {
    let unwrapCore = func (start object) object {
        var current = start
        while current is Box inner {
            current = inner.Inner
        }
        return current
    }
    return unwrapCore(value)
}

func Main() {
    Console.WriteLine(Unwrap(Box(Box("x"))).ToString())
}`
        Assert.Equal("x${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func WhilePatternBindingInCapturingLambda_RunsCorrectly() {
        const Source = `package Issue3501
import System

class Box {
    let Inner object
    init(inner object) { Inner = inner }
}

func Unwrap(value object, depthLimit int32) object {
    var limit = depthLimit
    let unwrapCore = func (start object) object {
        var current = start
        while current is Box inner && limit > 0 {
            current = inner.Inner
            limit = limit - 1
        }
        return current
    }
    return unwrapCore(value)
}

func Main() {
    Console.WriteLine(Unwrap(Box(Box("x")), 1).ToString())
}`
        // depthLimit 1 unwraps exactly one Box; the result is the inner Box,
        // whose ToString is the class name.
        Assert.Equal("Issue3501.Box${Environment.NewLine}", CompileAndRun(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "issue3501lambda",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            try {
                let sourcePath = Path.Combine(outputDirectory, "Program.gs")
                let outputPath = Path.Combine(outputDirectory, "Issue3501Lambda.dll")
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
