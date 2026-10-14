// <copyright file="Issue2725ConstrainedNullAssertedReceiverEmitTests.cs" company="GSharp">
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

/// Issue #2725: constrained member access over a null-asserted generic receiver
/// must reserve the addressable receiver spill consumed by the emitter.
class Issue2725ConstrainedNullAssertedReceiverEmitTests {
    @Fact
    func ExactOahuCoreFingerprint_NullAssertedConstrainedCount_RunsAndVerifies() {
        const Source = `package Oahu.Core
import System
import System.Collections.Generic

func CountText[T ICollection[object]](p T?) string {
    return p!!.Count.ToString()
}

func MutateText[T IList[object]](p T?) string {
    p!!.Add("three")
    p!![0] = "zero"
    return p!!.Count.ToString() + ":" + p!![0].ToString()
}

var values = List[object]{ "one", "two" }
Console.WriteLine(CountText[List[object]](values))
Console.WriteLine(MutateText[List[object]](values))`
        Assert.Equal("2${Environment.NewLine}3:zero${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    @Fact
    func IncompatibleConstraintArgument_RemainsRejected() {
        let syntax = SyntaxTree.Parse(SourceText.From(`package Oahu.Core.Negative
import System.Collections.Generic

func CountText[T ICollection[object]](p T?) string {
    return p!!.Count.ToString()
}

let invalid = CountText[int32](1)`))
        let compilation = Compilation(syntax)
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue2725.Negative")
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0152")
    }

    shared {
        private const ExactOahuCoreFingerprint string = "2f128c1866ee"

        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2725Emit", ExactOahuCoreFingerprint)
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
                Assert.True(exitCode == 0, (`Exact GS9998 fingerprint ` + "$ExactOahuCoreFingerprint" + ` must fall from 1 to 0.
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
