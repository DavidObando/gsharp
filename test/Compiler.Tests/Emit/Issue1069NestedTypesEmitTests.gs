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

    @Fact
    func NestedDerivedDeclaredBeforeNestedBase_OverridesRun() {
        let output = CompileAndRun(`package P

import System

class Container {
    private class Derived : Middle {
        var stored int32
        protected override func Record(value int32) {
            stored += value
        }
        protected override prop Current int32 {
            get -> stored
            set { stored = value }
        }
        protected override prop this[delta int32] int32 {
            get -> stored + delta
            set { stored = value + delta }
        }
        protected override event Changed Action[int32]
        func Fire(v int32) {
            Changed?.Invoke(v)
        }
    }

    private open class Middle : Base[int32] {
    }

    private abstract class Base[T] {
        protected open func Record(value T);
        protected open prop Current T {
            get -> default(T)
            set { }
        }
        protected open prop this[delta int32] T {
            get -> default(T)
            set { }
        }
        protected open event Changed Action[T]

        func Exercise(step T, initial T, indexed T, handler Action[T]) T {
            Changed += handler
            Current = initial
            Record(step)
            this[1] = indexed
            return this[2]
        }
    }

    func Run() string {
        let d = Derived()
        var seen = 0
        let b Base[int32] = d
        let res = b.Exercise(3, 10, 20, (x int32) -> { seen = x })
        d.Fire(res)
        return "${d.stored} $res $seen"
    }
}

Console.WriteLine(Container().Run())`)
        Assert.Equal("21 23 23${Environment.NewLine}", output)
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
