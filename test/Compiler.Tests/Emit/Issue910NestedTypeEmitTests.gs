// <copyright file="Issue910NestedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Linq
import System.Reflection
import System.Text
import Xunit.Sdk

/// Issue #910 / ADR-0110: nested type declarations (`class` / `struct`
/// / `interface` / `enum`) inside a `class` or `struct` body
/// must be emitted as real CLR nested types with nested accessibility, be
/// usable from the enclosing type's members, pass ilverify, and execute.
open class Issue910NestedTypeEmitTests {
    @Fact
    func NestedTypeReadsEnclosingPrivateSharedFieldThroughDriver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `class Enclosing {
    shared { private let Expected int32 = 1 }

    private class Nested {
        func Read() int32 -> Expected
    }
}`
        let library = fixture.Compile(source, "Exact5262", false)
        IlVerifier.Verify(library)
        let executable = fixture.Compile(
            source.Replace(
                "    private class Nested {",
                "    func Run() int32 -> Nested().Read()\n    private class Nested {"
            ) +
                "\nSystem.Console.Write(Enclosing().Run())",
            "Read5262",
            true
        )
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("1"), Encoding.UTF8.GetBytes(fixture.Run(executable)))
    }

    @Fact
    func NestedSharedFieldWritesKeepNearestLexicalOwnerAndShadowing() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let executable = fixture.Compile(`package Lexical5262
import System
class Outer {
    shared { var Value int32 = 100 }
    class Middle {
        shared { var Value int32 = 10 }
        class Leaf {
            shared {
                func Bump() int32 {
                    Value += 2
                    return Value++
                }
            }
            func Read() int32 -> Value
            func Parameter(Value int32) int32 -> Value
        }
        class Own {
            var Value int32 = 20
            func Read() int32 -> Value
        }
        func Run() {
            Console.Write(Leaf.Bump())
            Console.Write("|")
            Console.Write(Leaf().Read())
            Console.Write("|")
            Console.Write(Value)
            Console.Write("|")
            Console.Write(Leaf().Parameter(30))
            Console.Write("|")
            Console.Write(Own().Read())
        }
    }
    func Run() {
        Middle().Run()
        Console.Write("|")
        Console.Write(Value)
    }
}
Outer().Run()`, "Write5262", true)
        IlVerifier.Verify(executable)
        Assert.Equal(Encoding.UTF8.GetBytes("12|13|13|30|20|100"), Encoding.UTF8.GetBytes(fixture.Run(executable)))
    }

    @Fact
    func LexicalInstanceFieldsHideOuterSharedFieldsWithoutAnOuterReceiver() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`class Far {
    shared { let Hidden int32 = 1 }
    class Near {
        var Hidden int32 = 2
        class Child {
            func Read() int32 -> Hidden
        }
    }
    class Same {
        var Hidden int32 = 3
        shared { func Read() int32 -> Hidden }
    }
}`, "Rejected5262", false)
        Assert.NotEqual(0, code)
        Assert.Contains("Rejected5262.gs(6,34,6,40): error GS0125", output)
        Assert.Contains("Rejected5262.gs(11,39,11,45): error GS0125", output)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected5262.dll")))
    }

    @Fact
    func IssueExample_NestedClassInClass_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package Oahu.Cli.Tests

import System

class Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }

    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func NestedStructInStruct_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

struct Outer {
    struct Inner {
        var X int32
    }
}

func (o Outer) Make() int32 {
    let i = Inner{X: 41}
    return i.X + 1
}

let o = Outer{}
Console.WriteLine(o.Make())`)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func NestedStructInClass_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer {
    struct Point {
        var X int32
        var Y int32
    }

    func Sum() int32 {
        let p = Point{X: 3, Y: 4}
        return p.X + p.Y
    }
}

let o = Outer()
Console.WriteLine(o.Sum())`)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func NestedClassInStruct_ConstructedFromEnclosingMethod_Runs() {
        // Issue #910 / ADR-0110: a class nested in a struct is now emitted as a
        // real CLR nested type (the unified emission-order refactor guarantees
        // the enclosing struct TypeDef row precedes the nested class row per
        // ECMA-335 §II.22.32). Construct it from an enclosing method and run.
        let output = CompileAndRun(`package P

import System

struct Outer {
    class Inner {
        func Hello() string {
            return "from-nested-class"
        }
    }
}

func (o Outer) Make() string {
    let i = Inner()
    return i.Hello()
}

let o = Outer{}
Console.WriteLine(o.Make())`)
        Assert.Equal("from-nested-class${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnumInClass_UsedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer {
    enum Color {
        Red,
        Green,
        Blue,
    }

    func Pick() int32 {
        let c = Color.Green
        if c == Color.Green {
            return 1
        }
        return 0
    }
}

let o = Outer()
Console.WriteLine(o.Pick())`)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func NestedEnumInStruct_UsedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

struct Outer {
    enum Color {
        Red,
        Green,
        Blue,
    }
}

func (o Outer) Pick() int32 {
    let c = Color.Blue
    if c == Color.Blue {
        return 2
    }
    return 0
}

let o = Outer{}
Console.WriteLine(o.Pick())`)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func NestedInterfaceInClass_ImplementedAndCalledThrough_Runs() {
        // Issue #910 / ADR-0110: a nested interface is now emitted as a real
        // CLR nested type. A sibling nested class implements it; an enclosing
        // method upcasts to the interface and dispatches through it.
        let output = CompileAndRun(`package P

import System

class Outer {
    interface IInner {
        func Hello() string;
    }

    class Impl : IInner {
        func Hello() string {
            return "from-nested-interface"
        }
    }

    func Make() string {
        var i IInner = Impl{}
        return i.Hello()
    }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("from-nested-interface${Environment.NewLine}", output)
    }

    @Fact
    func NestedInterfaceInStruct_ImplementedAndCalledThrough_Runs() {
        // Issue #910 / ADR-0110: a nested interface inside a struct is also a
        // real CLR nested type. A sibling nested class implements it.
        let output = CompileAndRun(`package P

import System

struct Outer {
    interface IInner {
        func Hello() string;
    }

    class Impl : IInner {
        func Hello() string {
            return "iface-in-struct"
        }
    }
}

func (o Outer) Make() string {
    var i IInner = Impl{}
    return i.Hello()
}

let o = Outer{}
Console.WriteLine(o.Make())`)
        Assert.Equal("iface-in-struct${Environment.NewLine}", output)
    }

    @Fact
    func IssueExample_EmitsRealNestedClrType() {
        // ADR-0110: the supported combinations are emitted as real CLR nested
        // TypeDefs. Verify via reflection that Inner is nested inside Outer.
        let assembly = CompileToLibrary(`package Oahu.Cli.Tests

class Outer {
    class Inner {
        func Hello() string {
            return "hi"
        }
    }

    func Make() string {
        let i = Inner()
        return i.Hello()
    }
}`)
        let outer = Enumerable.Single(assembly.GetTypes(), (t Type) -> t.Name == "Outer")
        let inner Type? = outer.GetNestedType("Inner", BindingFlags.Public | BindingFlags.NonPublic)
        Assert.NotNull(inner)
        Assert.True(inner!!.IsNested)
        Assert.Equal(outer, inner!!.DeclaringType)
    }

    @Fact
    func RecursivelyNestedClass_ConstructedFromInnermostMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer {
    class Middle {
        class Inner {
            func N() int32 {
                return 7
            }
        }

        func Make() int32 {
            let i = Inner()
            return i.N()
        }
    }

    func Make() int32 {
        let m = Middle()
        return m.Make()
    }
}

let o = Outer()
Console.WriteLine(o.Make())`)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue910_emit_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue910_lib_").FullName
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
