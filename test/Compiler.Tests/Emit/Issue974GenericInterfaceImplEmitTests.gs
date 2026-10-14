// <copyright file="Issue974GenericInterfaceImplEmitTests.cs" company="GSharp">
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
import Xunit.Sdk

/// Issue #974: a class implementing a generic interface whose method returns
/// (or takes) a <em>constructed generic</em> built from the interface's type
/// parameter — e.g. `func Iter() IEnumerator[T]` satisfying
/// `ISeq[T].Iter() IEnumerator[T]` — was rejected with `GS0187`
/// ("does not implement interface method"). A method returning the plain type
/// parameter `T` matched, so the defect was specific to constructed
/// generic return / parameter types.
///
/// Root cause: interface-satisfaction signature matching
/// (`DeclarationBinder.SignaturesMatch`) compared the interface method's
/// return / parameter types to the class method's by reference identity. The
/// interface method carries the interface's type-parameter symbol
/// (`IEnumerator[T_iface]`) while the class method carries the class's
/// (`IEnumerator[T_class]`); these are distinct `TypeSymbol`
/// instances so the comparison never matched. Two fixes combine: (1)
/// `InterfaceSymbol` member substitution now recurses into constructed
/// generic (`ImportedTypeSymbol` / nested `InterfaceSymbol`) type
/// arguments so the constructed interface exposes `IEnumerator[T_class]`;
/// (2) signature matching now compares types structurally (definition +
/// ordered type arguments) instead of by reference, because constructed
/// generics are not interned.
open class Issue974GenericInterfaceImplEmitTests {
    @Fact
    func GenericInterface_MethodReturningConstructedGenericOverT_Compiles_And_Runs() {
        // The exact repro from issue #974: ISeq[T].Iter() IEnumerator[T].
        let source = `package GapCheck
import System
import System.Collections.Generic

interface ISeq[T] {
    func Iter() IEnumerator[T];
}

class Seq[T] : ISeq[T] {
    var items List[T] = List[T]()
    func Push(value T) {
        items.Add(value)
    }
    func Iter() IEnumerator[T] { return items.GetEnumerator() }
}

var s = Seq[int32]()
s.Push(10)
s.Push(20)
s.Push(30)
var e IEnumerator[int32] = s.Iter()
while e.MoveNext() {
    Console.WriteLine(e.Current)
}`
        Assert.Equal("10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterface_MethodReturningPlainT_Control_Compiles_And_Runs() {
        // Control that always compiled: the plain type-parameter return path.
        let source = `package GapCheck
import System

interface IBox[T] { func Get() T; }

class Box[T] : IBox[T] {
    var item T
    func Set(value T) { item = value }
    func Get() T { return item }
}

var b = Box[int32]()
b.Set(42)
Console.WriteLine(b.Get())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterface_ImplementedWithConcreteTypeArgument_Compiles_And_Runs() {
        // The class supplies a concrete type argument: ISeq[int32] satisfied
        // by func Iter() IEnumerator[int32].
        let source = `package GapCheck
import System
import System.Collections.Generic

interface ISeq[T] {
    func Iter() IEnumerator[T];
}

class IntSeq : ISeq[int32] {
    var items List[int32] = List[int32]()
    func Push(value int32) {
        items.Add(value)
    }
    func Iter() IEnumerator[int32] { return items.GetEnumerator() }
}

var s = IntSeq()
s.Push(7)
s.Push(8)
var e IEnumerator[int32] = s.Iter()
while e.MoveNext() {
    Console.WriteLine(e.Current)
}`
        Assert.Equal("7${Environment.NewLine}8${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterface_MethodTakingConstructedGenericParameter_Compiles_And_Runs() {
        // The constructed generic appears in a parameter position
        // (List[T]) as well as in the body, across multiple type
        // parameters and multiple interfaces on one class.
        let source = `package GapCheck
import System
import System.Collections.Generic

interface ISink[T] {
    func AddAll(values List[T]) int32;
}

interface IPair[K, V] {
    func Make() Dictionary[K, V];
}

class Bag[K, V] : ISink[V], IPair[K, V] {
    var items List[V] = List[V]()
    func AddAll(values List[V]) int32 {
        for v in values {
            items.Add(v)
        }
        return items.Count
    }
    func Make() Dictionary[K, V] { return Dictionary[K, V]() }
}

var bag = Bag[string, int32]()
var xs = List[int32]()
xs.Add(1)
xs.Add(2)
xs.Add(3)
Console.WriteLine(bag.AddAll(xs))`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericInterface_MismatchedConstructedGenericSignature_StillRejectedGS0187() {
        // Negative guard: the matching must stay strict. A class declared
        // Seq[T] : ISeq[T] whose Iter() returns IEnumerator[int32] (not
        // IEnumerator[T]) does NOT satisfy the interface and must still be
        // rejected with GS0187.
        let source = `package GapCheck
import System.Collections.Generic

interface ISeq[T] {
    func Iter() IEnumerator[T];
}

class BadSeq[T] : ISeq[T] {
    var items List[int32] = List[int32]()
    func Iter() IEnumerator[int32] { return items.GetEnumerator() }
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0187"))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue974_emit_").FullName
            try {
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
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
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

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue974_neg_").FullName
            try {
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
                Assert.True(compileExit != 0, (`expected gsc to report errors but it succeeded
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
