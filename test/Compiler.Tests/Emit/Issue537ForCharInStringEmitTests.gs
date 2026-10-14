// <copyright file="Issue537ForCharInStringEmitTests.cs" company="GSharp">
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

/// Regression tests for issue #537: `for c in "abc"` (string iteration)
/// was rejected with GS0116 "Type 'string' is not indexable." The fix treats
/// `string` as indexed-iterable over `char`, using the fast
/// `string.get_Chars(int)` indexer path — the same lowering C# emits for
/// `foreach (char c in str)`.
open class Issue537ForCharInStringEmitTests {
    @Fact
    func ForRange_OverStringLiteral_IteratesCorrectCount() {
        let source = `package P
import System

var n = 0
for c in "abc" { n = n + 1 }
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverStringLiteral_YieldsCharsInOrder() {
        let source = `package P
import System

for c in "abc" {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        // 'a'=97, 'b'=98, 'c'=99
        Assert.Equal("97${Environment.NewLine}98${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverStringVariable_YieldsCharsInOrder() {
        let source = `package P
import System

var s = "xyz"
for c in s {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        // 'x'=120, 'y'=121, 'z'=122
        Assert.Equal("120${Environment.NewLine}121${Environment.NewLine}122${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverEmptyString_ZeroIterations() {
        let source = `package P
import System

var n = 0
for c in "" { n = n + 1 }
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverStringWithBmpNonAscii_IteratesCodeUnits() {
        // BMP-only non-ASCII: 'é' (U+00E9), '€' (U+20AC), '日' (U+65E5)
        // Each is a single UTF-16 code unit.
        let source = `package P
import System

for c in "é€日" {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        // U+00E9=233, U+20AC=8364, U+65E5=26085
        Assert.Equal("233${Environment.NewLine}8364${Environment.NewLine}26085${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverStringWithSurrogatePair_YieldsTwoCodeUnits() {
        // U+1F600 (😀) is a surrogate pair: D83D DE00 in UTF-16.
        // C#'s `foreach (char c in str)` yields the two surrogates separately.
        // We must match that behaviour.
        let source = `package P
import System

var s = "\uD83D\uDE00"
for c in s {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        // High surrogate: 0xD83D = 55357, Low surrogate: 0xDE00 = 56832
        Assert.Equal("55357${Environment.NewLine}56832${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverToCharArray_RegressionGuard() {
        // Regression guard: `s.ToCharArray()` was fixed by #545 (char[]),
        // ensure it still works after the string iteration change.
        let source = `package P
import System

var s = "hi"
for c in s.ToCharArray() {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        // 'h'=104, 'i'=105
        Assert.Equal("104${Environment.NewLine}105${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverString_WithKeyVariable_YieldsIndexAndChar() {
        let source = `package P
import System

for i, c in "AB" {
  Console.WriteLine(i)
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        // i=0, 'A'=65, i=1, 'B'=66
        Assert.Equal(
            "0${Environment.NewLine}65${Environment.NewLine}1${Environment.NewLine}66${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue537_").FullName
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
