// <copyright file="Issue3840DefaultInterfaceMethodBareMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3840 end-to-end: an UNQUALIFIED read/write of the enclosing
/// interface's own property from inside a DEFAULT INTERFACE METHOD body must
/// bind to the implicit `this` receiver, exactly as the same spelling does
/// in a class body.
///
/// The implicit-member pseudo-variables the binder seeds into a member body's
/// scope were only ever built for a (cref:GSharp.Core.CodeAnalysis.Symbols.StructSymbol)
/// receiver, so inside a DIM the bare spelling reported GS0125 "Variable 'Name'
/// doesn't exist" while `this.Name` bound and dispatched correctly — the
/// two spellings disagreed only in an interface.
///
/// The test EXECUTES the emitted assembly through an implementation that does
/// NOT override the default methods, so the assertions prove the DIM body ran
/// and read the implementation's state (guarding the emitted-session DIM
/// dispatch of #572/#608), not merely that the binder stopped objecting.
open class Issue3840DefaultInterfaceMethodBareMemberEmitTests {
    @Fact
    func BareInterfaceMemberInsideDefaultMethodBody_VerifiesAndRuns() {
        const Source = `package Demo
import System

interface IBase {
    prop Name string {
        get;
        set;
    }
}

interface IGreeter : IBase {
    prop Count int32 {
        get;
        set;
    }

    func Tag() string {
        return "tag"
    }

    // Bare READ of an own property, of an INHERITED interface's
    // property, and of a sibling default method.
    func Greeting() string {
        return "Hello, " + Name + "! " + Tag()
    }

    // Bare WRITE (own and inherited).
    func Rename(next string) {
        Name = next
    }

    // Bare COMPOUND write.
    func Bump() {
        Count += 2
    }

    // Bare name as the HEAD of an accessor chain.
    func Describe() string {
        return Count.ToString() + "/" + Name.Length.ToString()
    }
}

interface IBox[T] {
    prop Value T {
        get;
        set;
    }

    func Describe() string {
        return "box:" + Value.ToString()
    }
}

// Neither implementation overrides a default method.
class Greeter : IGreeter {
    prop Name string {
        get;
        set;
    }

    prop Count int32 {
        get;
        set;
    }
}

class IntBox : IBox[int32] {
    prop Value int32 {
        get;
        set;
    }
}

let greeter IGreeter = Greeter()
greeter.Rename("world")
greeter.Bump()
greeter.Bump()
Console.WriteLine(greeter.Greeting())
Console.WriteLine(greeter.Describe())

let box IBox[int32] = IntBox()
box.Value = 41
Console.WriteLine(box.Describe())`
        let expected = string.Join(Environment.NewLine, "Hello, world! tag", "4/5", "box:41") + Environment.NewLine
        Assert.Equal(expected, CompileVerifyAndRun(Source))
    }

    /// Anti-vacuity guard: a bare name inside a DIM that names NOTHING on the
    /// interface must still report GS0125. The fix must not turn the diagnostic
    /// off, only route the names that genuinely resolve.
    @Fact
    func UnknownBareNameInsideDefaultMethodBody_StillReportsUndefinedVariable() {
        const Source = `package Demo

interface IGreeter {
    prop Name string {
        get;
    }

    func Greeting() string {
        return "Hello, " + Nope
    }
}`
        let (exitCode, output) = Compile(Source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0125", output, StringComparison.Ordinal)
        Assert.Contains("Nope", output, StringComparison.Ordinal)
    }

    /// Anti-vacuity guard: a bare WRITE to a get-only interface property inside
    /// a DIM must report "cannot assign", not silently succeed and not fall back
    /// to GS0125 "doesn't exist".
    @Fact
    func BareWriteToGetOnlyInterfaceProperty_ReportsCannotAssign() {
        const Source = `package Demo

interface IGreeter {
    prop Name string {
        get;
    }

    func Rename(next string) {
        Name = next
    }
}`
        let (exitCode, output) = Compile(Source)
        Assert.NotEqual(0, exitCode)
        Assert.DoesNotContain("GS0125", output, StringComparison.Ordinal)
        Assert.Contains("Name", output, StringComparison.Ordinal)
    }

    shared {
        private func Compile(source string)(ExitCode int32, Output string) {
            let directory = Directory.CreateTempSubdirectory("gs_issue3840_").FullName
            try {
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
                        []string{"/out:" + outputPath, "/target:library", "/targetframework:net10.0", sourcePath}
                    )
                    return (exitCode, stdout.ToString() + stderr.ToString())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileVerifyAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3840_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process Process? = Process.Start(startInfo)
                let runtimeOutput = process!!.StandardOutput.ReadToEnd()
                let runtimeError = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`runtime failed:
` + "$runtimeOutput" + `
` + "$runtimeError"))
                return runtimeOutput.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
