// <copyright file="Issue3130GsiReferenceOptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import System
import System.IO
import Xunit

/// Issue #3130 / ADR-0156 Phase 1: `gsi` gains gsc's `/r:` reference
/// channel in script mode, and the referenced assembly resolves both at
/// compile time (the import binds) and at runtime (the emitted program's load
/// context loads it from the supplied path). The library is compiled by gsc
/// into a scratch directory so it is invisible to the test host's own probing
/// paths — the negative case below proves the reference channel is the only
/// thing making the positive cases pass.
@Collection("ConsoleIo")
open class Issue3130GsiReferenceOptionTests {
    @Fact
    func ReferenceOption_LoadsAssemblyForCompileAndRun() {
        const PackageName = "Widgets3130A"
        let directory = CreateTestDirectory("ReferenceOption_LoadsAssemblyForCompileAndRun")
        let libraryPath = CompileLibrary(directory, PackageName)
        let result = RunGsi(directory, PackageName, "/r:" + libraryPath)
        Assert.Equal(string.Empty, result.StandardError)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("42${Environment.NewLine}", result.StandardOutput)
    }

    @Fact
    func ReferenceKeywordAlias_IsAccepted() {
        const PackageName = "Widgets3130B"
        let directory = CreateTestDirectory("ReferenceKeywordAlias_IsAccepted")
        let libraryPath = CompileLibrary(directory, PackageName)
        let result = RunGsi(directory, PackageName, "/reference:" + libraryPath)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("42${Environment.NewLine}", result.StandardOutput)
    }

    @Fact
    func WithoutReference_TheImportFailsToBind() {
        // Discriminating witness for the reference channel: the identical
        // script must fail without /r:, so the passing cases above cannot be
        // passing for a reason other than the supplied reference.
        const PackageName = "Widgets3130C"
        let directory = CreateTestDirectory("WithoutReference_TheImportFailsToBind")
        CompileLibrary(directory, PackageName)
        let result = RunGsi(directory, PackageName)
        Assert.Equal(1, result.ExitCode)
        Assert.Equal(string.Empty, result.StandardOutput)
        Assert.Contains(
            "error GS0130: Function 'Doubler' doesn't exist.",
            result.StandardError,
            StringComparison.Ordinal
        )
    }

    shared {
        // Each test uses its own package name: an assembly loaded (even into an
        // unloaded, collectible context) by one test must not be able to satisfy
        // another test's import through the in-process resolver's view of loaded
        // assemblies.
        private const LibrarySourceTemplate string = `package {0}

import System

class Doubler(Factor int32) {{
    func Apply(value int32) int32 {{
        return value * Factor
    }}
}}`

        private const ScriptSourceTemplate string = `import System
import {0}

Console.WriteLine(Doubler(2).Apply(21))`

        private func CreateTestDirectory(name string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue3130GsiReferenceOptionTests", name)
            Directory.CreateDirectory(directory)
            return directory
        }

        private func CompileLibrary(directory string, packageName string) string {
            let librarySourcePath = Path.Combine(directory, "widgets.gs")
            let libraryPath = Path.Combine(directory, packageName + ".dll")
            File.WriteAllText(librarySourcePath, string.Format(LibrarySourceTemplate, packageName))
            let (exitCode, stdout, stderr) = Capture(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/target:library", "/out:" + libraryPath, librarySourcePath})
            )
            Assert.True(exitCode == 0, "library compile failed: $stdout$stderr")
            Assert.True(File.Exists(libraryPath))
            return libraryPath
        }

        private func RunGsi(directory string, packageName string, additionalArguments ...string)(
            ExitCode int32,
            StandardOutput string,
            StandardError string
        ) {
            let sourcePath = Path.Combine(directory, "script.gs")
            File.WriteAllText(sourcePath, string.Format(ScriptSourceTemplate, packageName))
            let arguments = [additionalArguments.Length + 1]string
            additionalArguments.CopyTo(arguments, 0)
            arguments[^1] = sourcePath
            return Capture(() -> GSharp.Repl.Program.Main(arguments))
        }

        private func Capture(action() -> int32)(ExitCode int32, StandardOutput string, StandardError string) {
            using let stdout = StringWriter{NewLine: Environment.NewLine}
            using let stderr = StringWriter{NewLine: Environment.NewLine}
            let previousOut = Console.Out
            let previousError = Console.Error
            var exitCode int32
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                exitCode = action()
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (
                exitCode,
                stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                stderr.ToString().ReplaceLineEndings(Environment.NewLine)
            )
        }
    }
}
