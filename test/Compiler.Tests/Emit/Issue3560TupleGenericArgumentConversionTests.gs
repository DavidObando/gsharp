// <copyright file="Issue3560TupleGenericArgumentConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

class Issue3560TupleGenericArgumentConversionTests {
    @Fact
    func ListAdd_TupleLiteralNullableLift_CompileVerifyAndRun() {
        const Source = `package Issue3560

import System
import System.Collections.Generic

func Add(values List[(string, int32, int32?)]) {
    values.Add(("a", 1, 2))
}

let values = List[(string, int32, int32?)]()
Add(values)

Console.WriteLine(values[0].Item3)`
        Assert.Equal("2${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    @Fact
    func ListAdd_TupleLiteralNil_CompileVerifyAndRun() {
        const Source = `package Issue3560

import System
import System.Collections.Generic

func Add(values List[(string, int32, int32?)]) {
    values.Add(("b", 2, nil))
}

let values = List[(string, int32, int32?)]()
Add(values)

Console.WriteLine(values[0].Item3 == nil)`
        Assert.Equal("True${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    @Fact
    func ListAdd_NamedTupleLiteralNullableLift_CompileVerifyAndRun() {
        const Source = `package Issue3560

import System
import System.Collections.Generic

let values = List[(string, int32, int32?)]()
values.Add(item: ("a", 1, 2))

Console.WriteLine(values[0].Item3)`
        Assert.Equal("2${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    @Fact
    func ListAdd_NamedTupleLiteralNil_CompileVerifyAndRun() {
        const Source = `package Issue3560

import System
import System.Collections.Generic

let values = List[(string, int32, int32?)]()
values.Add(item: ("b", 2, nil))

Console.WriteLine(values[0].Item3 == nil)`
        Assert.Equal("True${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    shared {
        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3560TupleGenericArgumentConversionTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3560.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths() {
                    arguments.Add("/r:" + reference)
                }
                arguments.Add(sourcePath)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$standardOut$standardError")
                IlVerifier.Verify(outputPath)
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
