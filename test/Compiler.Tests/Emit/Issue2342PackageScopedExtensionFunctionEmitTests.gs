// <copyright file="Issue2342PackageScopedExtensionFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

/// Issue #2342 follow-up: extension functions were left package-blind by the
/// earlier free-function/alias follow-up. Two unrelated packages that each
/// declare an extension on a SHARED receiver type (a primitive, which has no
/// package identity of its own) under the same simple name and signature
/// previously collided as a spurious `GS0264` duplicate overload, and
/// even once the declaration collision was fixed, a call site in one
/// package's own code could still resolve to the OTHER package's same-name,
/// same-signature extension instead of its own. These tests compile real
/// multi-file, multi-package sources through the full `gsc` pipeline
/// (parse → bind → lower → emit), ilverify the result, then load and EXECUTE
/// the emitted methods via reflection to prove runtime correctness, not just
/// successful compilation.
open class Issue2342PackageScopedExtensionFunctionEmitTests {
    @Fact
    func UnrelatedPackages_SameSimpleName_SameSignature_ExtensionOnSharedReceiver_EachPackageResolvesItsOwn() {
        // Package "Foo" and package "Baz" each declare their OWN extension
        // `Greet()` on the SAME shared receiver type `string`, with the SAME
        // signature, and their OWN `Worker` class whose method body calls
        // `"x".Greet()` by unqualified instance syntax. Before this fix:
        // GS0264 duplicate-overload at compile time (or, if only declaration
        // were fixed, `Baz`'s `Worker.Build()` could resolve to `Foo`'s
        // extension and return the wrong string).
        const fooSource = `package Foo

func (s string) Greet() string {
    return "Foo:" + s
}

class Worker {
    func Build() string {
        return "x".Greet()
    }
}`
        const bazSource = `package Baz

func (s string) Greet() string {
    return "Baz:" + s
}

class Worker {
    func Build() string {
        return "x".Greet()
    }
}`
        let asm = CompileToLibrary(fooSource, bazSource)
        let workers = asm.GetTypes().Where((t Type) -> t.Name == "Worker").ToList()
        Assert.Equal(2, workers.Count)
        let fooWorker = workers.Single((t Type) -> t.Namespace == "Foo")
        let bazWorker = workers.Single((t Type) -> t.Namespace == "Baz")
        let fooInstance object? = Activator.CreateInstance(fooWorker)
        let fooResult string? = cast[string](fooWorker.GetMethod("Build")!!.Invoke(fooInstance, nil)!!)
        Assert.Equal("Foo:x", fooResult)
        let bazInstance object? = Activator.CreateInstance(bazWorker)
        let bazResult string? = cast[string](bazWorker.GetMethod("Build")!!.Invoke(bazInstance, nil)!!)
        Assert.Equal("Baz:x", bazResult)
    }

    @Fact
    func OwnPackageCall_FromLambdaBody_ResolvesToOwnExtension_AtRuntime() {
        // "Calls from deferred/lambda bodies" coverage at the emit/run
        // level: package Baz's own extension call is made from inside a
        // lambda invoked by its method body, not directly in the method's
        // top-level statement list.
        const fooSource = `package Foo

func (s string) Greet() string {
    return "Foo:" + s
}`
        const bazSource = `package Baz

func (s string) Greet() string {
    return "Baz:" + s
}

class Worker {
    func Build() string {
        let f = func() string { return "x".Greet() }
        return f()
    }
}`
        let asm = CompileToLibrary(fooSource, bazSource)
        let bazWorker = asm.GetTypes().Single((t Type) -> t.Name == "Worker" && t.Namespace == "Baz")
        let bazInstance object? = Activator.CreateInstance(bazWorker)
        let bazResult string? = cast[string](bazWorker.GetMethod("Build")!!.Invoke(bazInstance, nil)!!)
        Assert.Equal("Baz:x", bazResult)
    }

    @Fact
    func SamePackage_DuplicateSignature_ExtensionOnSharedReceiver_AcrossFiles_StillFailsToCompile() {
        // Negative control: the SAME package's genuine duplicate-signature
        // extension, split across two files, must still be rejected.
        const fileA = `package Foo

func (s string) Greet() string {
    return "A:" + s
}`
        const fileB = `package Foo

func (s string) Greet() string {
    return "B:" + s
}`
        let errors = CompileExpectingErrors(fileA, fileB)
        Assert.Contains(errors, (l string) -> l.Contains("GS0264"))
    }

    @Fact
    func CrossPackage_ClrImportedExtension_And_UserExtension_CoexistAtRuntime() {
        // Cross-package imports/qualification: a CLR/BCL imported extension
        // method (`System.Linq.Enumerable.Where`) used in one package must
        // coexist peacefully — and both remain independently callable at
        // runtime — with an unrelated user-declared extension of the same
        // simple name on an unrelated receiver type in a different package.
        const fooSource = `package Foo

import System.Linq
import System.Collections.Generic

class Worker {
    func CountEvens() int32 {
        let list = List[int32]()
        list.Add(1)
        list.Add(2)
        list.Add(3)
        list.Add(4)
        let evens = list.Where(func(x int32) bool { return x % 2 == 0 })
        var count = 0
        for x in evens {
            count = count + 1
        }
        return count
    }
}`
        const bazSource = `package Baz

func (s string) Where() string {
    return "Baz:" + s
}

class Worker {
    func Build() string {
        return "x".Where()
    }
}`
        let asm = CompileToLibrary(fooSource, bazSource)
        let fooWorker = asm.GetTypes().Single((t Type) -> t.Name == "Worker" && t.Namespace == "Foo")
        let fooInstance object? = Activator.CreateInstance(fooWorker)
        let fooResult = int32(fooWorker.GetMethod("CountEvens")!!.Invoke(fooInstance, nil)!!)
        Assert.Equal(2, fooResult)
        let bazWorker = asm.GetTypes().Single((t Type) -> t.Name == "Worker" && t.Namespace == "Baz")
        let bazInstance object? = Activator.CreateInstance(bazWorker)
        let bazResult string? = cast[string](bazWorker.GetMethod("Build")!!.Invoke(bazInstance, nil)!!)
        Assert.Equal("Baz:x", bazResult)
    }

    shared {
        private func CompileToLibrary(sources ...string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2342_ext_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2342_ext_err_").FullName
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
