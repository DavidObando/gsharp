// <copyright file="Issue2753TopLevelUsingLifetimeEmitTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

open class Issue2753TopLevelUsingLifetimeEmitTests {
    @Fact
    func AsyncTopLevelUsing_ClosureAndReturn_DisposesInReverseOrderAtProgramEnd() {
        const source = `package Probe
import System
import System.Threading.Tasks

class Outer : IDisposable {
    func Dispose() {
        Console.WriteLine("dispose:outer")
    }
    func Ping() {
        Console.WriteLine("ping:outer")
    }
}

class Inner : IDisposable {
    func Dispose() {
        Console.WriteLine("dispose:inner")
    }
}

class Holder {
    var Factory (() -> Outer)? = nil
    async func Invoke() Task[int32] {
        await Task.Yield()
        Factory!!().Ping()
        return 0
    }
}

using let outer = Outer()
using let inner = Inner()
let holder = Holder()
holder.Factory = () -> outer
Console.WriteLine("before")
return await holder.Invoke()`
        let result = CompileAndRun(source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(
            "before${Environment.NewLine}ping:outer${Environment.NewLine}dispose:inner${Environment.NewLine}dispose:outer${Environment.NewLine}",
            result.StandardOutput
        )
    }

    @Fact
    func AsyncTopLevelUsing_ExplicitTryCatchFinally_KeepsClosureAlive() {
        const source = `package Probe
import System
import System.Threading.Tasks

class Res : IDisposable {
    var Disposed bool = false
    func Dispose() {
        Disposed = true
        Console.WriteLine("disposed")
    }
    func Ping() {
        if Disposed {
            throw ObjectDisposedException("Res")
        }
        Console.WriteLine("ping")
    }
}

class Holder {
    var Factory (() -> Res)? = nil
    async func Invoke() Task[int32] {
        await Task.Yield()
        Factory!!().Ping()
        return 0
    }
}

using let resource = Res()
let holder = Holder()
holder.Factory = () -> resource
try {
    return await holder.Invoke()
} catch (ex Exception) {
    Console.WriteLine("caught")
    return 1
} finally {
    Console.WriteLine("restore")
}`
        let result = CompileAndRun(source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(
            "ping${Environment.NewLine}restore${Environment.NewLine}disposed${Environment.NewLine}",
            result.StandardOutput
        )
    }

    @Fact
    func AsyncLambdaUsingDeclaration_KeepsResourceAliveAcrossAwait() {
        const source = `package Probe
import System
import System.Threading.Tasks

class Res : IDisposable {
    var Disposed bool = false
    func Dispose() {
        Disposed = true
        Console.WriteLine("disposed")
    }
    func Ping() {
        if Disposed {
            throw ObjectDisposedException("Res")
        }
        Console.WriteLine("ping")
    }
}

await Task.Run(async () -> {
    using let resource = Res()
    await Task.Yield()
    resource.Ping()
})`
        let result = CompileAndRun(source)
        Assert.True(result.ExitCode == 0, (`exited ` + "${result.ExitCode}" + `
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
        Assert.Equal("ping${Environment.NewLine}disposed${Environment.NewLine}", result.StandardOutput)
    }

    @Fact
    func AsyncTopLevelUsing_UnhandledException_StillDisposes() {
        const source = `package Probe
import System
import System.Threading.Tasks

class Res : IDisposable {
    func Dispose() {
        Console.WriteLine("disposed")
    }
}

using let resource = Res()
Console.WriteLine("before")
await Task.Yield()
throw Exception("boom")`
        let result = CompileAndRun(source)
        Assert.NotEqual(0, result.ExitCode)
        Assert.Equal("before${Environment.NewLine}disposed${Environment.NewLine}", result.StandardOutput)
        Assert.Contains("boom", result.StandardError)
    }

    @Fact
    func MethodUsingDeclarations_PreserveNestedLexicalLifetimes() {
        const source = `package Probe
import System

class Outer : IDisposable {
    func Dispose() {
        Console.WriteLine("dispose:outer")
    }
}

class Inner : IDisposable {
    func Dispose() {
        Console.WriteLine("dispose:inner")
    }
}

func Run() {
    using let outer = Outer()
    {
        using let inner = Inner()
        Console.WriteLine("body")
    }
    Console.WriteLine("after")
}

Run()`
        let result = CompileAndRun(source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(
            "body${Environment.NewLine}dispose:inner${Environment.NewLine}after${Environment.NewLine}dispose:outer${Environment.NewLine}",
            result.StandardOutput
        )
    }

    @Fact
    func AsyncTopLevelUsing_MoveNextCleanupRegionsProtectRemainingStatements() {
        const source = `package Probe
import System
import System.Threading.Tasks

class Res : IDisposable {
    func Dispose() {}
    func Ping() {}
}

using let outer = Res()
using let inner = Res()
await Task.Yield()
outer.Ping()
inner.Ping()`
        let assemblyPath = Compile(source)
        try {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            let moveNext = metadata
                .TypeDefinitions
                .Select((handle TypeDefinitionHandle) -> metadata.GetTypeDefinition(handle))
                .Where(
                (type TypeDefinition) -> metadata.GetString(type.Name).Contains("<Main>$$", StringComparison.Ordinal)
            )
                .SelectMany(
                func (type TypeDefinition) IEnumerable[MethodDefinitionHandle] {
                    return type.GetMethods()
                }
            )
                .Select((handle MethodDefinitionHandle) -> metadata.GetMethodDefinition(handle))
                .Single((method MethodDefinition) -> metadata.GetString(method.Name) == "MoveNext")
            let body = pe.GetMethodBody(moveNext.RelativeVirtualAddress)
            let cleanupRegions = body
                .ExceptionRegions
                .Where((region ExceptionRegion) -> region.Kind == ExceptionRegionKind.Catch)
                .ToArray()
            Assert.Contains(
                cleanupRegions,
                (outer ExceptionRegion) -> cleanupRegions.Any(
                    (middle ExceptionRegion) -> Contains(outer, middle) && cleanupRegions.Any(
                        (inner ExceptionRegion) -> Contains(middle, inner)
                    )
                )
            )
        } finally {
            Directory.Delete(Path.GetDirectoryName(assemblyPath)!!, recursive: true)
        }
    }

    shared {
        private func Contains(outer ExceptionRegion, inner ExceptionRegion) bool -> outer.TryOffset < inner.TryOffset &&
            outer.TryOffset +
            outer.TryLength >= inner.TryOffset +
            inner.TryLength

        private func CompileAndRun(source string)(ExitCode int32, StandardOutput string, StandardError string) {
            let assemblyPath = Compile(source)
            let directory = Path.GetDirectoryName(assemblyPath)!!
            try {
                using let process = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                            assemblyPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )!!
                let standardOutput = process.StandardOutput.ReadToEnd().ReplaceLineEndings(Environment.NewLine)
                let standardError = process.StandardError.ReadToEnd().ReplaceLineEndings(Environment.NewLine)
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
                return (process.ExitCode, standardOutput, standardError)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Compile(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2753_").FullName
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let standardOutput = StringWriter()
            using let standardError = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOutput)
            Console.SetError(standardError)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `):
` + "$standardOutput" + `
` + "$standardError"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(outputPath)
            return outputPath
        }
    }
}
