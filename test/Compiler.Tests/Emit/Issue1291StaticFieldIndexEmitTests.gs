// <copyright file="Issue1291StaticFieldIndexEmitTests.cs" company="GSharp">
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

/// Issue #1291: element access on a qualified static (shared) array field
/// receiver — `Type.staticField[i]` — bound the indexed value to the error
/// type `?` instead of the array's element type, surfacing GS0129
/// (`+=` not defined for `int32` and `?`) or GS9998 (cannot encode
/// signature for type `?`). The defect was a missing
/// `IndexExpressionSyntax` case in the user-type static accessor binding
/// path: the trailing `[...]` folded into the right-hand side of the
/// qualifier fell through to the error-producing `default`. Unqualified
/// access (`T[i]`) and qualified instance access (`recv.T[i]`) were
/// always correct. These tests compile and run real programs end-to-end,
/// asserting the correct runtime values read through the static-field indexer.
open class Issue1291StaticFieldIndexEmitTests {
    @Fact
    func QualifiedStaticArrayField_CompoundAssignFromIndex_ReadsElement() {
        let source = `package P
import System

class C {
    shared {
        private let T []uint8 = []uint8{uint8(2), uint8(5)}
        func F() int32 {
            var c = 0
            c += int32(C.T[0])
            c += int32(C.T[1])
            return c
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func QualifiedStaticArrayField_DirectIndex_ReadsElement() {
        let source = `package P
import System

class C {
    shared {
        private let T []uint8 = []uint8{uint8(9), uint8(3)}
        func F() int32 {
            let x = int32(C.T[1])
            return x
        }
    }
}

Console.WriteLine(C.F())`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func QualifiedStaticArrayField_IndexedFromTopLevelMethod_ReadsElement() {
        let source = `package P
import System

struct S {
    prop A uint8 { get; init; }
}

class C {
    shared {
        let T []uint8 = []uint8{uint8(2), uint8(1)}
    }
}

func (s S) F() int32 {
    let x = int32(C.T[uint8(s.A)])
    return x
}

var s = S{A: uint8(1)}
Console.WriteLine(s.F())`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1291_").FullName
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
