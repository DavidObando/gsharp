// <copyright file="Issue687ColorColorEmitTests.cs" company="GSharp">
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

/// Issue #687: end-to-end emit + runtime validation for the C# "color color"
/// rule and the qualified-namespace-path escape hatch. A class with a field
/// whose name shadows an imported type (`Path string` alongside
/// `System.IO.Path`) must compile, the static call `Path.Combine`
/// inside the method body must bind against `System.IO.Path`, and the
/// fully-qualified `System.IO.Path.Combine(...)` spelling must continue
/// to work as an escape hatch.
open class Issue687ColorColorEmitTests {
    @Fact
    func ColorColor_FieldShadowsImportedType_StaticCallEmitsAndRuns() {
        let source = `package P
import System
import System.IO

class Entry {
    var Path string = ""

    func Build(suffix string) string {
        return Path.Combine(this.Path, suffix)
    }
}

var e = Entry() { Path = "root" }
Console.WriteLine(e.Build("leaf.txt"))`
        let output = CompileAndRun(source)
        let expected = Path.Combine("root", "leaf.txt") + Environment.NewLine
        Assert.Equal(expected, output)
    }

    @Fact
    func QualifiedNamespacePath_StaticCallEmitsAndRuns() {
        let source = `package P
import System

Console.WriteLine(System.IO.Path.Combine("a", "b"))`
        let output = CompileAndRun(source)
        let expected = Path.Combine("a", "b") + Environment.NewLine
        Assert.Equal(expected, output)
    }

    @Fact
    func ColorColor_InstanceMemberAccess_FallsBackToField() {
        // Field type is `string` and `Path.Length` is an instance member of the
        // string value, not a static of System.IO.Path. The fall-back must keep
        // the instance interpretation, returning the length of the field value
        // ("/tmp" → 4) at runtime.
        let source = `package P
import System
import System.IO

class Probe {
    var Path string = ""

    func Len() int32 {
        return Path.Length
    }
}

var p = Probe() { Path = "/tmp" }
Console.WriteLine(p.Len())`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue687_").FullName
            try {
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
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
