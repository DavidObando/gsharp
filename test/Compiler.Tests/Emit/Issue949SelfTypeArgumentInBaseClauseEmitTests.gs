// <copyright file="Issue949SelfTypeArgumentInBaseClauseEmitTests.cs" company="GSharp">
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

/// Issue #949: a G# class must be allowed to name itself as a generic type
/// ARGUMENT in its own base/implements clause — the common C# pattern
/// `class Shape : IEquatable<Shape>`. Previously this was rejected
/// with `GS0113` ("Type 'Shape' doesn't exist") because the enclosing
/// type was not yet in scope when its base clause was bound.
///
/// The fix registers the in-progress type before its base clause is bound, so
/// the self type argument resolves; binds and emits the constructed CLR
/// generic interface (`IEquatable<Shape>`) against the real
/// (non-erased) type argument; and adds a narrow self-inheritance guard
/// (`GS0378`) so genuine `class A : A` stays rejected.
///
/// Each happy-path test compiles via `gsc`, runs `ilverify` on the
/// produced assembly, then runs or reflects it to assert end-to-end behavior.
open class Issue949SelfTypeArgumentInBaseClauseEmitTests {
    @Fact
    func Class_NamesItselfAsTypeArgument_InClrInterface_RunsAndIlVerifies() {
        // Canonical issue: `class Shape : IEquatable[Shape]` implementing
        // `Equals(Shape) bool`. The method must be callable directly AND via
        // an `IEquatable[Shape]`-typed interface receiver.
        // A primary constructor is used so the field is assigned inside the
        // synthesized .ctor (a struct/class literal `Shape{X: 5}` would write
        // the readonly `let` field outside any .ctor, which ilverify rejects
        // with InitOnly — an unrelated, pre-existing emit limitation).
        let source = `package Probe
import System

open class Shape(X int32) : IEquatable[Shape] {
    func Equals(other Shape) bool {
        return X == other.X
    }
}

var a = Shape(5)
var b = Shape(5)
var c = Shape(7)
Console.WriteLine(a.Equals(b))
Console.WriteLine(a.Equals(c))
var e IEquatable[Shape] = a
Console.WriteLine(e.Equals(b))`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func Class_NamesItselfAsTypeArgument_MetadataDeclaresConstructedInterfaceImpl() {
        // Reflect over the emitted assembly: the TypeDef must carry an
        // InterfaceImpl for the CONSTRUCTED `IEquatable<Shape>` (not the
        // type-erased `IEquatable<object>`), and `Equals` must be virtual so
        // the CLR vtable wires it to the interface slot.
        let source = `package Probe
import System

open class Shape : IEquatable[Shape] {
    let X int32
    func Equals(other Shape) bool {
        return X == other.X
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let shape = asm.GetType("Probe.Shape") ?? throw InvalidOperationException("Probe.Shape not found")
            let implemented = shape.GetInterfaces()
            let equatable Type? = implemented.SingleOrDefault(
                (i Type) -> i.IsGenericType && i.GetGenericTypeDefinition().FullName == "System.IEquatable`1"
            )
            Assert.NotNull(equatable)
            // The single type argument must be Probe.Shape itself — proving the
            // self type argument survived erasure into the metadata.
            let arg = equatable!!.GetGenericArguments().Single()
            Assert.Equal("Probe.Shape", arg.FullName)
            let equals = shape.GetMethod("Equals", []Type{shape}) ??
                throw InvalidOperationException("Equals(Shape) not found")
            Assert.True(equals.IsVirtual, "Equals(Shape) must be virtual to implement IEquatable<Shape>")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func GenericClass_NamesItselfAsTypeArgument_BindsEmitsAndIlVerifies() {
        // `class Node[T] : IEquatable[Node[T]]` — the enclosing GENERIC type
        // (closed over its own type parameter) appears as the interface's type
        // argument. This must bind, emit IL-verifiable metadata, and the
        // InterfaceImpl must reference the constructed `IEquatable<Node<T>>`.
        let source = `package Probe
import System

class Node[T] : IEquatable[Node[T]] {
    let Value T
    func Equals(other Node[T]) bool {
        return true
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{dllPath}))
            using let mlc = MetadataLoadContext(resolver, "System.Private.CoreLib")
            let asm = mlc.LoadFromAssemblyPath(dllPath)
            let node = asm.GetType("Probe.Node`1") ?? throw InvalidOperationException("Probe.Node`1 not found")
            let equatable Type? = node.GetInterfaces().SingleOrDefault(
                (i Type) -> i.IsGenericType && i.GetGenericTypeDefinition().FullName == "System.IEquatable`1"
            )
            Assert.NotNull(equatable)
            // The interface argument must be the constructed Node<T>, i.e. its
            // generic definition is Probe.Node`1.
            let arg = equatable!!.GetGenericArguments().Single()
            Assert.True(arg.IsGenericType, "interface argument should be the constructed Node<T>")
            Assert.Equal("Probe.Node`1", arg.GetGenericTypeDefinition().FullName)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func Class_NamesItselfInBaseClass_TypeArgument_RunsAndIlVerifies() {
        // A BASE CLASS that references Self as a type argument:
        // `class C : Base[C]`. The base class is the constructed `Base<C>`,
        // not C itself, so this is legal (distinct from self-inheritance).
        let source = `package Probe
import System

open class Base[T] {
    let Tag int32
}

open class C(V int32) : Base[C] {
    func Describe() string {
        return "c"
    }
}

var c = C(1)
Console.WriteLine(c.Describe())`
        let output = CompileAndRun(source)
        Assert.Equal("c${Environment.NewLine}", output)
    }

    @Fact
    func Class_WithMultipleInterfaces_OneReferencingSelf_RunsAndIlVerifies() {
        // The base-type clause lists several interfaces where one references
        // Self (`IEquatable[Money]`). All must be wired and dispatchable.
        let source = `package Probe
import System

open class Money(Amount int32) : IDisposable, IEquatable[Money] {
    func Dispose() {
        Console.WriteLine("disposed")
    }
    func Equals(other Money) bool {
        return Amount == other.Amount
    }
}

var m1 = Money(3)
var m2 = Money(3)
Console.WriteLine(m1.Equals(m2))
var e IEquatable[Money] = m1
Console.WriteLine(e.Equals(m2))
m1.Dispose()`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}disposed${Environment.NewLine}", output)
    }

    @Fact
    func GenuineSelfInheritance_IsStillRejected() {
        // The narrowed guard must still reject a class naming itself as its
        // own BASE CLASS (not merely a type argument).
        let diagnostics = CompileExpectingErrors(`package Probe

open class A : A {
    let V int32
}`)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0378"))
    }

    @Fact
    func GenuineGenericSelfInheritance_IsStillRejected() {
        // `class A[T] : A[T]` is genuine self-inheritance (the base class is
        // the constructed self) and must remain rejected.
        let diagnostics = CompileExpectingErrors(`package Probe

open class A[T] : A[T] {
    let V T
}`)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0378"))
    }

    @Fact
    func TwoTypeInheritanceCycle_IsStillRejected() {
        // A two-type base-class cycle (B : C, C : B) must remain rejected so
        // the inheritance cycle detection is not weakened by the fix.
        let diagnostics = CompileExpectingErrors(`package Probe

open class B : C {
    let V int32
}

open class C : B {
    let W int32
}`)
        Assert.True(diagnostics.Count > 0, "expected an inheritance-cycle diagnostic")
    }

    @Fact
    func ThreeTypeInheritanceCycle_IsRejected() {
        // A transitive base-class cycle spanning three types (A : B, B : C,
        // C : A) must be rejected. This guards the multi-hop chain walk in the
        // post-bind cycle detector (#973), not just the two-type case.
        let diagnostics = CompileExpectingErrors(`package Probe

open class A : B {
    let U int32
}

open class B : C {
    let V int32
}

open class C : A {
    let W int32
}`)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0381"))
    }

    @Fact
    func TwoTypeInheritanceCycle_ReportsGS0381() {
        // The two-type cycle must surface the dedicated inheritance-cycle
        // diagnostic (GS0381), distinct from direct self-inheritance (GS0378).
        let diagnostics = CompileExpectingErrors(`package Probe

open class B : C {
    let V int32
}

open class C : B {
    let W int32
}`)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0381"))
    }

    @Fact
    func ForwardBaseClassReference_IsAccepted() {
        // A class deriving from a base declared later in source is a legitimate
        // forward reference (enabled by the #973 two-phase split) and must NOT
        // be misreported as an inheritance cycle.
        let path = CompileLibrary(`package Probe

class Derived : Base {
    let V int32
}

open class Base {
    let W int32
}`)
        Assert.True(File.Exists(path))
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue949_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            let compileExit = RunCompiler(args, out var compileOut, out var compileErr)
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue949_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                let compileExit = RunCompiler(args, out var compileOut, out var compileErr)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue949_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                let compileExit = RunCompiler(args, out var compileOut, out var compileErr)
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut + compileErr
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(args[]string, out stdout string, out stderr string) int32 {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                let exit = Program.Main(args)
                stdout = compileOut.ToString()
                stderr = compileErr.ToString()
                return exit
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil {
                    Directory.Delete(dir, recursive: true)
                }
            } catch {
                // best effort

            }
        }
    }
}
