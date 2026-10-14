// <copyright file="Issue1211CompositeLiteralPropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1211: end-to-end emit tests proving a composite literal
/// `T{Field: value}` assigns settable `prop` auto-property members
/// by calling the property's setter/init accessor (not a `stfld`). Each
/// test compiles via `gsc`, runs `ilverify`, executes the produced
/// assembly, and asserts the property values round-trip — which can only hold
/// if the setter/init accessor actually ran.
open class Issue1211CompositeLiteralPropEmitTests {
    @Fact
    func ClassCompositeLiteral_GetInitAndGetSetProps_RoundTrip() {
        let source = `package Probe
import System

class C {
    prop TrackId int32 { get; init; }
    prop Name string { get; set }
    var Count int32
}

var c = C{TrackId: 7, Name: "abc", Count: 5}
Console.WriteLine(c.TrackId)
Console.WriteLine(c.Name)
Console.WriteLine(c.Count)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}abc${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func StructCompositeLiteral_GetInitAndGetSetProps_RoundTrip() {
        let source = `package Probe
import System

struct P {
    prop X int32 { get; init; }
    prop Y int32 { get; set }
    var Z int32
}

var p = P{X: 1, Y: 2, Z: 3}
Console.WriteLine(p.X)
Console.WriteLine(p.Y)
Console.WriteLine(p.Z)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}", output)
    }

    @Fact
    func ClassCompositeLiteral_InheritedProperty_RoundTrip() {
        let source = `package Probe
import System

open class Base {
    prop Id int32 { get; init; }
}

class Derived : Base {
    prop Extra int32 { get; set }
}

var d = Derived{Id: 5, Extra: 6}
Console.WriteLine(d.Id)
Console.WriteLine(d.Extra)`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1211_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
