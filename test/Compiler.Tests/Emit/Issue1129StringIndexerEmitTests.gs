// <copyright file="Issue1129StringIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1129: indexing a `string` with `s[i]` was rejected with
/// GS0116. .NET's `string` exposes `char this[int]`
/// (`get_Chars`), so `s[i]` yields the `char` at that position.
/// The binder now maps `string[int]` to a `BoundIndexExpression` with
/// a `char` result; emit already lowered that node to
/// `System.String.get_Chars(int)` (issue #537). These tests compile and
/// run real programs end-to-end.
open class Issue1129StringIndexerEmitTests {
    @Fact
    func StringIndex_ByConstant_YieldsCharCode() {
        // Acceptance criteria #2: end-to-end `s[1]` of "ABCD" is 'B' = 66.
        let source = `package P
import System

var s = "ABCD"
let c = s[1]
Console.WriteLine(int32(c))`
        let output = CompileAndRun(source)
        Assert.Equal("66${Environment.NewLine}", output)
    }

    @Fact
    func StringIndex_FirstChar_YieldsCharCode() {
        let source = `package P
import System

var s = "ABCD"
Console.WriteLine(int32(s[0]))`
        let output = CompileAndRun(source)
        // 'A' = 65
        Assert.Equal("65${Environment.NewLine}", output)
    }

    @Fact
    func StringIndex_ByVariable_YieldsCharCode() {
        // Acceptance criteria #3: indexing with a non-constant int variable.
        let source = `package P
import System

var s = "ABCD"
var i = 2
Console.WriteLine(int32(s[i]))`
        let output = CompileAndRun(source)
        // 'C' = 67
        Assert.Equal("67${Environment.NewLine}", output)
    }

    @Fact
    func StringIndex_PrintedAsChar() {
        let source = `package P
import System

var s = "ABCD"
Console.WriteLine(s[3])`
        let output = CompileAndRun(source)
        Assert.Equal("D${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1129_").FullName
            try {
                return CompileAndRunImpl(source, tempDir)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunImpl(source string, tempDir string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
            psi.ArgumentList.Add(outPath)
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
