// <copyright file="Issue1069NestedTypesEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import Xunit.Sdk

/// Issue #1069: nested `struct`, `data struct`, and `enum`
/// declarations inside a class must emit as real CLR nested types, be
/// constructible and usable from the enclosing type's members and from outside
/// by qualified name, pass ilverify, and execute with the expected runtime
/// values. Nested `class` already worked and is covered for regression.
open class Issue1069NestedTypesEmitTests {
    @Fact
    func NestedDataStruct_ConstructedAndUsed_Runs() {
        let output = CompileAndRun(`package P

import System

open class Outer {
    func Make() uint32 {
        let e = Entry(7u)
        return e.X
    }

    data struct Entry(X uint32) { }
}

let o = Outer()
Console.WriteLine(int32(o.Make()))`)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnum_AccessedAndUsed_Runs() {
        let output = CompileAndRun(`package P

import System

open class Outer {
    func Make() Color {
        return Color.Green
    }

    enum Color { Red, Green }
}

let o = Outer()
Console.WriteLine(int32(o.Make()))`)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func NestedPlainStruct_MembersAccessed_Runs() {
        let output = CompileAndRun(`package P

import System

open class Outer {
    func Make() int32 {
        let e = Entry{X: 9}
        return e.X
    }

    struct Entry { var X int32 }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    @Fact
    func NestedClass_ConstructedFromEnclosingMethod_Runs_Regression() {
        let output = CompileAndRun(`package P

import System

open class Outer {
    func Make() int32 {
        let i = Inner() { X = 5 }
        return i.X
    }

    class Inner { prop X int32 { get; init; } }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func NestedTypes_AccessedByQualifiedNameFromOutside_Runs() {
        let output = CompileAndRun(`package P

import System

open class Outer {
    data struct Entry(X uint32) { }
    enum Color { Red, Green }
    struct Point { var X int32 }
}

let e = Outer.Entry(4u)
Console.WriteLine(int32(e.X))
let c = Outer.Color.Green
Console.WriteLine(int32(c))
let p = Outer.Point{X: 11}
Console.WriteLine(p.X)`)
        Assert.Equal("4${Environment.NewLine}1${Environment.NewLine}11${Environment.NewLine}", output)
    }

    @Fact
    func NestedDataStructAndEnum_EmitAsClrNestedTypes() {
        let assembly = CompileToLibrary(`package P

open class Outer {
    data struct Entry(X uint32) { }
    enum Color { Red, Green }
    struct Point { var X int32 }
}`)
        let outer = Enumerable.Single(assembly.GetTypes(), (t Type) -> t.Name == "Outer")
        for nestedName in[]string{"Entry", "Color", "Point"} {
            let nested Type? = outer.GetNestedType(nestedName, BindingFlags.Public | BindingFlags.NonPublic)
            Assert.NotNull(nested)
            Assert.True(nested!!.IsNested, "$nestedName should be a CLR nested type")
            Assert.Equal(outer, nested!!.DeclaringType)
        }
        let color Type? = outer.GetNestedType("Color", BindingFlags.Public | BindingFlags.NonPublic)
        Assert.True(color!!.IsEnum)
        let entry Type? = outer.GetNestedType("Entry", BindingFlags.Public | BindingFlags.NonPublic)
        Assert.True(entry!!.IsValueType)
        let point Type? = outer.GetNestedType("Point", BindingFlags.Public | BindingFlags.NonPublic)
        Assert.True(point!!.IsValueType)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1069_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
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
                Assert.True(compileExit == 0, (`compile failed (` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileToLibrary(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1069_lib_").FullName
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
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            return EmittedFixture.Load(outPath)
        }
    }
}
