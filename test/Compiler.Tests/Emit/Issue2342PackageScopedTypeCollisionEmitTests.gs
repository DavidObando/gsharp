// <copyright file="Issue2342PackageScopedTypeCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

/// Issue #2342: two top-level types (or a whole "shape" of colliding symbol
/// kinds) that share a simple name across DIFFERENT packages must not collide
/// with `GS0102`, must both emit as distinct CLR types (namespace-qualified
/// by their own `PackageName`), and — critically — each package's OWN
/// method bodies must keep resolving their OWN same-simple-name type by
/// unqualified reference rather than the first-declared package's homonym
/// (the cascading `GS0158` symptom described in the issue). These tests
/// compile real multi-file, multi-package sources through the full `gsc`
/// pipeline (parse → bind → lower → emit), ilverify the result, then load and
/// EXECUTE the emitted methods via reflection to prove runtime correctness,
/// not just successful compilation.
open class Issue2342PackageScopedTypeCollisionEmitTests {
    @Fact
    func UnrelatedPackages_SameSimpleNames_EmitDistinctTypes_AndEachPackageResolvesItsOwn() {
        // Package "Foo" and package "Baz" each declare their OWN `Shape0` data
        // shape and their OWN `Worker` class whose method body constructs an
        // object literal of ITS OWN package's `Shape0` by unqualified simple
        // name. Before the #2342 fix this failed to compile at all (GS0102 on
        // the second `Shape0`/`Worker`); after fixing only the declaration
        // check (without the ambient-package lookup fix), the second
        // package's method body would resolve `Shape0` to the FIRST package's
        // (wrong-shape) type and cascade GS0158. This test proves both the
        // declaration collision AND the lookup ambiguity are fixed together.
        const fooSource = `package Foo

class Shape0 {
    var Name string
}

class Worker {
    func Build() string {
        let s = Shape0{Name: "foo-shape"}
        return s.Name
    }
}`
        const bazSource = `package Baz

class Shape0 {
    var Width int32
}

class Worker {
    func Build() int32 {
        let s = Shape0{Width: 42}
        return s.Width
    }
}`
        let asm = CompileToLibrary(fooSource, bazSource)
        let shapes = asm.GetTypes().Where((t Type) -> t.Name == "Shape0").ToList()
        Assert.Equal(2, shapes.Count)
        Assert.Contains(shapes, (t Type) -> t.Namespace == "Foo")
        Assert.Contains(shapes, (t Type) -> t.Namespace == "Baz")
        let workers = asm.GetTypes().Where((t Type) -> t.Name == "Worker").ToList()
        Assert.Equal(2, workers.Count)
        let fooWorker = workers.Single((t Type) -> t.Namespace == "Foo")
        let bazWorker = workers.Single((t Type) -> t.Namespace == "Baz")
        let fooInstance object? = Activator.CreateInstance(fooWorker)
        let fooResult string? = cast[string](fooWorker.GetMethod("Build")!!.Invoke(fooInstance, nil)!!)
        Assert.Equal("foo-shape", fooResult)
        let bazInstance object? = Activator.CreateInstance(bazWorker)
        let bazResult = int32(bazWorker.GetMethod("Build")!!.Invoke(bazInstance, nil)!!)
        Assert.Equal(42, bazResult)
    }

    @Fact
    func PrefixPackages_FooAndFooBar_SameSimpleName_EmitDistinctTypes_AndEachPackageResolvesItsOwn() {
        // Companion to the unrelated-packages test above, but with packages
        // that share a dotted prefix ("Foo" vs. "Foo.Bar") — the exact shape
        // that must NOT be conflated with nested-type or same-package
        // semantics.
        const fooSource = `package Foo

class Widget {
    var A int32
}

class Describer {
    func Describe() int32 {
        let w = Widget{A: 1}
        return w.A
    }
}`
        const fooBarSource = `package Foo.Bar

class Widget {
    var B int32
}

class Describer {
    func Describe() int32 {
        let w = Widget{B: 2}
        return w.B
    }
}`
        let asm = CompileToLibrary(fooSource, fooBarSource)
        let widgets = asm.GetTypes().Where((t Type) -> t.Name == "Widget").ToList()
        Assert.Equal(2, widgets.Count)
        Assert.Contains(widgets, (t Type) -> t.Namespace == "Foo")
        Assert.Contains(widgets, (t Type) -> t.Namespace == "Foo.Bar")
        let describers = asm.GetTypes().Where((t Type) -> t.Name == "Describer").ToList()
        Assert.Equal(2, describers.Count)
        let fooDescriber = describers.Single((t Type) -> t.Namespace == "Foo")
        let fooBarDescriber = describers.Single((t Type) -> t.Namespace == "Foo.Bar")
        let fooInstance object? = Activator.CreateInstance(fooDescriber)
        let fooResult = int32(fooDescriber.GetMethod("Describe")!!.Invoke(fooInstance, nil)!!)
        Assert.Equal(1, fooResult)
        let fooBarInstance object? = Activator.CreateInstance(fooBarDescriber)
        let fooBarResult = int32(fooBarDescriber.GetMethod("Describe")!!.Invoke(fooBarInstance, nil)!!)
        Assert.Equal(2, fooBarResult)
    }

    @Fact
    func SamePackage_DuplicateSimpleName_AcrossFiles_StillFailsToCompile() {
        // Negative control: splitting the SAME package's genuine duplicate
        // across two files must still be rejected with GS0102 — the fix must
        // not accidentally widen same-package duplicate detection.
        const fileA = `package Foo

class Shape0 {
    var Name string
}`
        const fileB = `package Foo

class Shape0 {
    var Width int32
}`
        let errors = CompileExpectingErrors(fileA, fileB)
        Assert.Contains(errors, (l string) -> l.Contains("GS0102"))
    }

    shared {
        private func CompileToLibrary(sources ...string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2342_lib_").FullName
            let srcPaths = [sources.Length]string
            for var i = 0; i < sources.Length; i++ {
                srcPaths[i] = Path.Combine(tempDir, "test$i.gs")
                File.WriteAllText(srcPaths[i], sources[i])
            }
            let outPath = Path.Combine(tempDir, "test.dll")
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}.Concat(srcPaths)
                .ToArray()
            let compileExit = RunCompiler(args, out var compileOut, out var compileErr)
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileExpectingErrors(sources ...string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2342_err_").FullName
            try {
                let srcPaths = [sources.Length]string
                for var i = 0; i < sources.Length; i++ {
                    srcPaths[i] = Path.Combine(tempDir, "test$i.gs")
                    File.WriteAllText(srcPaths[i], sources[i])
                }
                let outPath = Path.Combine(tempDir, "test.dll")
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}.Concat(srcPaths)
                    .ToArray()
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
    }
}
