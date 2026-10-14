// <copyright file="Issue2807AnonymousFunctionParameterAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2807: anonymous functions preserve parameter attributes in emitted metadata.
open class Issue2807AnonymousFunctionParameterAttributeEmitTests {
    @Fact
    func AnonymousFunctionParameters_PreserveAttributes() {
        let source = `package P

import System

class MarkerAttribute : Attribute {
}

func attributeCount(handler Func[int32, int32]) int32 {
    return handler.Method.GetParameters()[0].GetCustomAttributes(false).Length
}

func stringAttributeCount(handler Func[string, string?]) int32 {
    return handler.Method.GetParameters()[0].GetCustomAttributes(false).Length
}

let functionLiteral Func[int32, int32] = func(@Marker value int32) int32 {
    return value + 1
}
let arrowLambda Func[int32, int32] = (@Marker value int32) -> value + 1
let widenedAdapter Func[string, string?] = func(@Marker value string) string {
    return value
}

Console.WriteLine(attributeCount(functionLiteral))
Console.WriteLine(attributeCount(arrowLambda))
Console.WriteLine(stringAttributeCount(widenedAdapter))`
        Assert.Equal("1${Environment.NewLine}1${Environment.NewLine}1${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2807_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let processInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                processInfo.ArgumentList.Add("exec")
                processInfo.ArgumentList.Add("--runtimeconfig")
                processInfo.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                processInfo.ArgumentList.Add(outPath)
                using let process Process? = Process.Start(processInfo)
                let stdout = process!!.StandardOutput.ReadToEnd()
                let stderr = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`exited ` + "${process!!.ExitCode}" + `
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
