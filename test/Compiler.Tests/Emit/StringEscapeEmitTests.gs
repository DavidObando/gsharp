// <copyright file="StringEscapeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #531: end-to-end emit-and-execute coverage for backslash escape
/// sequences in double-quoted string literals.
open class StringEscapeEmitTests {
    @Fact
    func Newline_Escape_ProducesLength3() {
        let source = `package P
import System

let s = "a\nb"
Console.WriteLine(s.Length)`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Tab_Escape_ProducesTab() {
        let source = `package P
import System

let s = "a\tb"
Console.WriteLine(s)`
        Assert.Equal("a\tb${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Unicode_Escape_ProducesCharacter() {
        let source = `package P
import System

let s = "\u00e9"
Console.WriteLine(s)`
        Assert.Equal("é${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Backslash_Escape_ProducesLiteral() {
        let source = `package P
import System

let s = "a\\b"
Console.WriteLine(s.Length)`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Quote_Escape_ProducesQuote() {
        let source = `package P
import System

let s = "say \"hi\""
Console.WriteLine(s)`
        Assert.Equal("say \"hi\"${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Hex_Escape_ProducesCharacter() {
        let source = `package P
import System

let s = "\x41"
Console.WriteLine(s)`
        Assert.Equal("A${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func RawString_DoesNotProcessEscapes() {
        let source = (`package P
import System

let s = ` + "`" + `a\nb` + "`" + `
Console.WriteLine(s.Length)`)
        Assert.Equal("4${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InterpolatedString_EscapesInLiteralSegment() {
        let source = `package P
import System

let x = 42
let s = "val:\t${x}\n"
Console.WriteLine(s.Length)`
        // "val:\t" = 5 chars + "42" = 2 chars + "\n" = 1 char = 8
        Assert.Equal("8${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_str_esc_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
