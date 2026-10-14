// <copyright file="Issue3145ConstructorRefStructLivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #3145: constructor bodies run async ref-struct liveness analysis.
@Collection("ConsoleIo")
open class Issue3145ConstructorRefStructLivenessTests {
    @Theory
    @MemberData("Drivers")
    func ConstructorAsyncLambda_RefStructLiveAcrossAwait_ReportsGS0219(
        driver Issue3145ConstructorRefStructLivenessTests.Driver
    ) {
        let result = Run(UnsafeSource, driver)
        Assert.Equal(1, result.ExitCode)
        Assert.Equal([]string{"GS0219"}, result.DiagnosticIds)
    }

    @Theory
    @MemberData("Drivers")
    func ConstructorAsyncLambda_RefStructDeadBeforeAwait_HasNoDiagnostics(
        driver Issue3145ConstructorRefStructLivenessTests.Driver
    ) {
        let result = Run(SafeSource, driver)
        Assert.Equal(0, result.ExitCode)
        Assert.Empty(result.DiagnosticIds)
    }

    enum Driver {
        BareCompiler,
        CompilerEmission,
        GsiScript
    }

    private data class DriverResult(ExitCode int32, DiagnosticIds[]string) : IEquatable[
        Issue3145ConstructorRefStructLivenessTests.DriverResult
    ] { }

    shared {
        private const UnsafeSource string = `import System
import System.Threading.Tasks

class Holder {
    var Value int32

    init(values []int32) {
        let read = async func() int32 {
            var span ReadOnlySpan[int32] = values
            await Task.Yield()
            return span.Length
        }
        Value = read().Result
    }
}
`

        private const SafeSource string = `import System
import System.Threading.Tasks

class Holder {
    var Value int32

    init(values []int32) {
        let read = async func() int32 {
            var span ReadOnlySpan[int32] = values
            var length = span.Length
            await Task.Yield()
            return length
        }
        Value = read().Result
    }
}
`

        func Drivers() sequence[[]object] {
            for driver in Enum.GetValues[Issue3145ConstructorRefStructLivenessTests.Driver]() {
                yield[]object{driver}
            }
        }

        private func Run(
            source string,
            driver Issue3145ConstructorRefStructLivenessTests.Driver
        ) Issue3145ConstructorRefStructLivenessTests
            .DriverResult {
            let root = Path.Combine(
                GetRepositoryRoot(),
                "out",
                "test-artifacts",
                "issue3145-$driver-${Guid.NewGuid():N}"
            )
            Assert.False(Directory.Exists(root))
            Directory.CreateDirectory(root)
            try {
                let sourceDirectory = Directory.CreateDirectory(Path.Combine(root, "source")).FullName
                let outputDirectory = Directory.CreateDirectory(Path.Combine(root, "output")).FullName
                Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory))
                let sourcePath = Path.Combine(sourceDirectory, "Probe.gs")
                File.WriteAllText(sourcePath, source)
                let result = switch driver {
                    case Issue3145ConstructorRefStructLivenessTests
                        .Driver
                        .BareCompiler: Issue3145ConstructorRefStructLivenessTests.Capture(
                        () -> GSharp.Compiler.Program.Main([]string{sourcePath})
                    )
                    case Issue3145ConstructorRefStructLivenessTests
                        .Driver
                        .CompilerEmission: Issue3145ConstructorRefStructLivenessTests
                        .Capture(
                        () -> GSharp
                            .Compiler
                            .Program
                            .Main([]string{"/out:" + Path.Combine(outputDirectory, "Probe.dll"), sourcePath})
                    )
                    case Issue3145ConstructorRefStructLivenessTests
                        .Driver
                        .GsiScript: Issue3145ConstructorRefStructLivenessTests.Capture(
                        () -> GSharp.Repl.Program.Main([]string{sourcePath})
                    )
                    default: throw InvalidOperationException("Unexpected driver $driver.")
                }
                let ids = Regex
                    .Matches(result.StandardOutput + result.StandardError, "\\bGS\\d{4}\\b")
                    .Select((match Match) -> match.Value)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy((id string) -> id, StringComparer.Ordinal)
                    .ToArray()
                return Issue3145ConstructorRefStructLivenessTests.DriverResult(result.ExitCode, ids)
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private func Capture(action() -> int32)(ExitCode int32, StandardOutput string, StandardError string) {
            using let output = StringWriter()
            using let error = StringWriter()
            let previousOutput = Console.Out
            let previousError = Console.Error
            Console.SetOut(output)
            Console.SetError(error)
            try {
                return (action(), output.ToString(), error.ToString())
            } finally {
                Console.SetOut(previousOutput)
                Console.SetError(previousError)
            }
        }

        private func GetRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            return directory?.FullName ?? throw InvalidOperationException("Could not locate repository root.")
        }
    }
}
