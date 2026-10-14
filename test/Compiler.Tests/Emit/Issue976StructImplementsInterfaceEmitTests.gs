// <copyright file="Issue976StructImplementsInterfaceEmitTests.cs" company="GSharp">
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
import System.Reflection
import Xunit

/// Issue #976: a G# `struct` (CLR value type) may declare an
/// implemented-interface clause (`struct Money : IEquatable[Money] { … }`),
/// mirroring a `class`. The struct's clause may list interfaces only — a
/// base class or base struct is rejected with GS0382. Each happy-path test
/// compiles via `gsc`, runs `ilverify` on the produced assembly, then
/// either reflects the emitted metadata or runs the assembly under
/// `dotnet exec` to assert end-to-end behavior (including boxing through
/// the interface receiver).
open class Issue976StructImplementsInterfaceEmitTests {
    @Fact
    func Struct_ImplementsIEquatable_DirectAndThroughInterface_RunsAndIlVerifies() {
        // Canonical issue repro: a value-type struct implements
        // IEquatable[Money], calling Equals directly AND through the
        // IEquatable[Money] interface (which boxes the struct).
        let source = `package Probe
import System

struct Money : IEquatable[Money] {
    var Cents int32
    func Equals(other Money) bool { return Cents == other.Cents }
}

var a = Money{ Cents: 100 }
var b = Money{ Cents: 100 }
var c = Money{ Cents: 200 }
Console.WriteLine(a.Equals(b))
Console.WriteLine(a.Equals(c))
var ie IEquatable[Money] = a
Console.WriteLine(ie.Equals(b))
Console.WriteLine(ie.Equals(c))`
        let output = CompileAndRun(source)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Struct_MetadataDeclaresInterfaceImpl_AndEqualsIsVirtual() {
        // Reflect over the emitted assembly with a MetadataLoadContext to
        // confirm the struct TypeDef carries an InterfaceImpl row for
        // System.IEquatable<Money> and the satisfying method is virtual so the
        // value type correctly fills the interface slot.
        let source = `package Probe
import System

struct Money : IEquatable[Money] {
    var Cents int32
    func Equals(other Money) bool { return Cents == other.Cents }
}`
        let dllPath = CompileLibrary(source)
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let type = asm.GetType("Probe.Money") ?? throw InvalidOperationException("type not found")
            Assert.True(type.IsValueType, "Money must be a value type (struct)")
            let interfaces = type.GetInterfaces().Select((i Type) -> i.Name).ToArray()
            Assert.Contains(interfaces, (i string) -> i.StartsWith("IEquatable", StringComparison.Ordinal))
            let method = type.GetMethod("Equals", []Type{type}) ??
                throw InvalidOperationException("Equals(Money) not found")
            Assert.True(method.IsVirtual, "Equals(Money) must be virtual to implement the interface")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func Struct_ImplementsIComparable_DispatchesThroughInterface() {
        let source = `package Probe
import System

struct Money : IComparable[Money] {
    var Cents int32
    func CompareTo(other Money) int32 { return Cents - other.Cents }
}

var a = Money{ Cents: 100 }
var b = Money{ Cents: 200 }
var ic IComparable[Money] = a
Console.WriteLine(ic.CompareTo(b))`
        let output = CompileAndRun(source)
        Assert.Equal("-100${Environment.NewLine}", output)
    }

    @Fact
    func DataStruct_ImplementsCustomInterface_DispatchesThroughInterface() {
        // A `data struct` (value type with a primary constructor) implements a
        // user-declared G# interface and is consumed through the interface
        // receiver (which boxes).
        let source = `package Probe
import System

interface IShape {
    func Area() float64;
}

data struct Rect(Width float64, Height float64) : IShape {
    func Area() float64 { return Width * Height }
}

var r = Rect{ Width: 3.0, Height: 4.0 }
var s IShape = r
Console.WriteLine(s.Area())`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}", output)
    }

    @Fact
    func GenericStruct_ImplementsGenericInterface_DispatchesThroughInterface() {
        // Ties into #974: a generic struct implements a generic interface whose
        // member returns the constructed generic type argument. Dispatch
        // through the constructed interface must reach the struct's body.
        let source = `package Probe
import System

interface IBox[T] {
    func Get() T;
}

struct Box[T] : IBox[T] {
    var Value T
    func Get() T { return Value }
}

var b = Box[int32]{ Value: 42 }
var ib IBox[int32] = b
Console.WriteLine(ib.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Struct_NamingClassAsBase_IsRejected() {
        // A struct (value type) cannot declare a user class as a base type.
        let source = `package Probe

class Base { var X int32 }

struct S : Base { var Y int32 }`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0382"))
    }

    @Fact
    func Struct_FailingToImplementInterfaceMember_IsRejected() {
        // A struct that declares an interface but does not provide the
        // required member is rejected with the GS0187 channel.
        let source = `package Probe
import System

struct Money : IComparable[Money] {
    var Cents int32
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0187"))
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue976_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue976_").FullName
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
                } catch { }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue976_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
