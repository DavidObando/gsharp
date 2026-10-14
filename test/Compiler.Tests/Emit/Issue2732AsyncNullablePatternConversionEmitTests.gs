// <copyright file="Issue2732AsyncNullablePatternConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2732: converting a value-type nullable to its underlying type must
/// emit a real nullable unwrap after async hoisting, including top-level state
/// machines and protected regions.
class Issue2732AsyncNullablePatternConversionEmitTests {
    @Fact
    func ExactOahuCliFingerprint_TopLevelAsyncPatternInTry_RunsAndVerifies() {
        const Source = `package Oahu.Cli
import System
import System.Threading.Tasks

await Task.Yield()
let rewriteResult int32? = 42
try {
    let __spill0 = rewriteResult
    var code int32
    if __spill0 is int32 {
        code = int32(__spill0)
        Console.WriteLine(code)
    }
} catch (ex Exception) {
    Console.WriteLine("failed")
}`
        Assert.Equal("42${Environment.NewLine}", CompileVerifyAndRun(Source, "Exact"))
    }

    @Fact
    func HoistedNullableParameter_ExplicitUnderlyingConversionInTry_RunsAndVerifies() {
        const Source = `package Issue2732.Generalized
import System
import System.Threading.Tasks

async func Unwrap(value int32?) int32 {
    await Task.Yield()
    try {
        return int32(value)
    } catch (ex InvalidOperationException) {
        return -1
    }
}

Console.WriteLine(Unwrap(17).Result)
Console.WriteLine(Unwrap(nil).Result)`
        Assert.Equal("17${Environment.NewLine}-1${Environment.NewLine}", CompileVerifyAndRun(Source, "Generalized"))
    }

    @Fact
    func NullableToUnderlyingConversion_RemainsExplicitOnly() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package Issue2732.Negative

func Invalid(value int32?) int32 {
    var result int32 = value
    return result
}`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2732.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0156")
    }

    shared {
        private const ExactOahuCliFingerprint string = "248fb4aeedcd"

        private func CompileVerifyAndRun(source string, caseName string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue2732AsyncNullablePatternConversionEmitTests",
                ExactOahuCliFingerprint,
                caseName
            )
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.True(exitCode == 0, (`StackUnexpected fingerprint ` + "$ExactOahuCliFingerprint" + ` must be clean.
`) + (`compile failed (` + "$exitCode" + `):
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
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
        }
    }
}
