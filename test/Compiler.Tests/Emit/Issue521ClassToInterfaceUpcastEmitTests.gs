// <copyright file="Issue521ClassToInterfaceUpcastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #521: end-to-end emit + execute coverage for the general CLR
/// reference upcast — a concrete class is implicitly assignable to any
/// interface it implements (or any of its base classes). The binder fix
/// lives in `Conversion.Classify`; the emit side widens via a no-op
/// reference upcast (no `castclass`) since the runtime object already
/// satisfies the wider static type.
///
/// Each test compiles via `gsc`, ilverifies the produced PE, then
/// runs the assembly under `dotnet exec` and asserts on the captured
/// stdout. ilverify catches any spurious `castclass` / stack-type
/// mismatch we might have introduced.
open class Issue521ClassToInterfaceUpcastEmitTests {
    @Fact
    func GSharpClass_To_GSharpInterface_DispatchesImpl() {
        // User-defined class assigned to user-defined interface, then
        // method dispatched through the interface receiver — the runtime
        // type is HelloGreeter so the implementation runs.
        let source = `package P
import System

interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Hello, " + name }
}

var g IGreeter = HelloGreeter{}
Console.WriteLine(g.Greet("world"))`
        let output = CompileAndRun(source)
        Assert.Equal("Hello, world${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_To_GSharpInterface_AsArgument_DispatchesImpl() {
        // Passing a concrete class where an interface parameter is
        // expected exercises the conversion at the call site rather than
        // at an assignment.
        let source = `package P
import System

interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Hi, " + name }
}

func Run(g IGreeter, name string) {
    Console.WriteLine(g.Greet(name))
}

Run(HelloGreeter{}, "ada")`
        let output = CompileAndRun(source)
        Assert.Equal("Hi, ada${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_To_GSharpInterface_AsReturnType_DispatchesImpl() {
        // Returning a concrete class where the function declares an
        // interface return type — the return-value upcast lowers to the
        // same no-op widening as the assignment / argument shapes.
        let source = `package P
import System

interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Hey, " + name }
}

func Make() IGreeter {
    return HelloGreeter{}
}

Console.WriteLine(Make().Greet("bob"))`
        let output = CompileAndRun(source)
        Assert.Equal("Hey, bob${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_To_GSharpInterface_ExplicitCast_DispatchesImpl() {
        // Explicit-cast form `IGreeter(HelloGreeter{})` reaches
        // `BindConversion` with `allowExplicit: true` but the underlying
        // classification is the same implicit upcast — verify the cast
        // form emits the same widening.
        let source = `package P
import System

interface IGreeter {
    func Greet(name string) string;
}

class HelloGreeter : IGreeter {
    func Greet(name string) string { return "Yo, " + name }
}

var g = IGreeter(HelloGreeter{})
Console.WriteLine(g.Greet("sam"))`
        let output = CompileAndRun(source)
        Assert.Equal("Yo, sam${Environment.NewLine}", output)
    }

    @Fact
    func ClrList_To_IReadOnlyList_Indexer_ReturnsExpectedElement() {
        // The repro from the issue body: `List<string>` to
        // `IReadOnlyList<string>` was rejected with GS0155. With the fix
        // the assignment binds, the upcast emits as a no-op, and the
        // indexer call dispatches through the interface to the same
        // backing List.
        let source = `package P
import System
import System.Collections.Generic

var mut = List[string]()
mut.Add("first")
mut.Add("second")
var r IReadOnlyList[string] = mut
Console.WriteLine(r[1])`
        let output = CompileAndRun(source)
        Assert.Equal("second${Environment.NewLine}", output)
    }

    @Fact
    func ClrList_To_IEnumerable_IterationViaForRange_VisitsEveryElement() {
        // Generic variance is *not* required here — `List<int32>` simply
        // implements `IEnumerable<int32>`. Asserting that `for x := range
        // iface` walks the upcast value end-to-end pins the no-op widening
        // through the iterator lowering path too.
        let source = `package P
import System
import System.Collections.Generic

var mut = List[int32]()
mut.Add(10)
mut.Add(20)
mut.Add(30)
var e IEnumerable[int32] = mut
for x in e {
    Console.WriteLine(x)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", output)
    }

    @Fact
    func ClrString_To_IComparable_Assignment_Roundtrips() {
        // BCL identity / reference-upcast for a plain string -> IComparable.
        // The CLR holds the same reference on the stack; the interface
        // method (CompareTo) dispatches to System.String's implementation.
        let source = `package P
import System

var s = "abc"
var c IComparable = s
Console.WriteLine(c.CompareTo("abc"))`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue521_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                args.Add(srcPath)
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
                } catch { }
            }
        }
    }
}
