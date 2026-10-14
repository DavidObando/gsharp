// <copyright file="Issue2342PackageScopedFunctionAndAliasEmitTests.cs" company="GSharp">
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

/// Issue #2342 follow-up: two deferred package-isolation gaps beyond the
/// original struct/enum/interface/delegate/alias-to-real-type declaration fix.
/// 1. Top-level FREE FUNCTIONS shared one flat, package-blind overload-set table, so two unrelated
/// packages with a same-simple-name, same-signature free function collided as a spurious duplicate
/// overload (`GS0264`) — or, if only the declaration check were fixed, a call site inside one package's
/// OWN method body could still silently resolve to the OTHER package's same-name function.
/// 2. A plain `type Name = Target` alias's package identity was inferred (best-effort) from its
/// TARGET's package — `null` for a primitive — so two unrelated packages aliasing a primitive under the
/// same simple name collided as a spurious `GS0102`.
/// These tests compile real multi-file, multi-package sources through the
/// full `gsc` pipeline (parse → bind → lower → emit), ilverify the
/// result, then load and EXECUTE the emitted methods / inspect the emitted
/// field types via reflection to prove runtime correctness, not just
/// successful compilation.
open class Issue2342PackageScopedFunctionAndAliasEmitTests {
    @Fact
    func UnrelatedPackages_SameSimpleName_SameSignature_FreeFunction_EachPackageResolvesItsOwn() {
        // Package "Foo" and package "Baz" each declare their OWN free
        // function `Describe()` with the SAME signature, and their OWN
        // `Worker` class whose method body calls `Describe()` by
        // unqualified simple name. Before this fix: GS0264 duplicate-overload
        // at compile time (or, if only declaration were fixed, `Baz`'s
        // `Worker.Build()` could resolve to `Foo`'s `Describe` and return the
        // wrong string).
        const fooSource = `package Foo

func Describe() string {
    return "Foo"
}

class Worker {
    func Build() string {
        return Describe()
    }
}`
        const bazSource = `package Baz

func Describe() string {
    return "Baz"
}

class Worker {
    func Build() string {
        return Describe()
    }
}`
        let asm = CompileToLibrary(fooSource, bazSource)
        let workers = asm.GetTypes().Where((t Type) -> t.Name == "Worker").ToList()
        Assert.Equal(2, workers.Count)
        let fooWorker = workers.Single((t Type) -> t.Namespace == "Foo")
        let bazWorker = workers.Single((t Type) -> t.Namespace == "Baz")
        let fooInstance object? = Activator.CreateInstance(fooWorker)
        let fooResult string? = cast[string](fooWorker.GetMethod("Build")!!.Invoke(fooInstance, nil)!!)
        Assert.Equal("Foo", fooResult)
        let bazInstance object? = Activator.CreateInstance(bazWorker)
        let bazResult string? = cast[string](bazWorker.GetMethod("Build")!!.Invoke(bazInstance, nil)!!)
        Assert.Equal("Baz", bazResult)
    }

    @Fact
    func SamePackage_DuplicateSignature_FreeFunction_AcrossFiles_StillFailsToCompile() {
        // Negative control: the SAME package's genuine duplicate-signature
        // free function, split across two files, must still be rejected.
        const fileA = `package Foo

func Describe() string {
    return "A"
}`
        const fileB = `package Foo

func Describe() string {
    return "B"
}`
        let errors = CompileExpectingErrors(fileA, fileB)
        Assert.Contains(errors, (l string) -> l.Contains("GS0264"))
    }

    @Fact
    func UnrelatedPackages_SameSimpleName_PrimitiveAliasedAlias_EachPackageResolvesItsOwn() {
        // The exact alias defect: both packages alias a target with NO
        // package identity of its own (a primitive), under the same simple
        // name `Coord`, to a DIFFERENT primitive each. Each package's own
        // struct field typed through its own `Coord` must emit with ITS OWN
        // aliased primitive type, not collide with — or silently borrow —
        // the other package's alias.
        const fooSource = `package Foo

type Coord = int32

class Widget {
    var X Coord
}`
        const bazSource = `package Baz

type Coord = int64

class Widget {
    var Y Coord
}`
        let asm = CompileToLibrary(fooSource, bazSource)
        let widgets = asm.GetTypes().Where((t Type) -> t.Name == "Widget").ToList()
        Assert.Equal(2, widgets.Count)
        let fooWidget = widgets.Single((t Type) -> t.Namespace == "Foo")
        let bazWidget = widgets.Single((t Type) -> t.Namespace == "Baz")
        let xField FieldInfo? = fooWidget.GetField("X", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(xField)
        Assert.Equal(typeof(int32), xField!!.FieldType)
        let yField FieldInfo? = bazWidget.GetField("Y", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(yField)
        Assert.Equal(typeof(int64), yField!!.FieldType)
    }

    @Fact
    func SamePackage_DuplicateAlias_AcrossFiles_StillFailsToCompile() {
        // Negative control: the SAME package's genuine duplicate alias, split
        // across two files, must still be rejected.
        const fileA = `package Foo

type Coord = int32`
        const fileB = `package Foo

type Coord = int64`
        let errors = CompileExpectingErrors(fileA, fileB)
        Assert.Contains(errors, (l string) -> l.Contains("GS0102"))
    }

    shared {
        private func CompileToLibrary(sources ...string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2342_fn_alias_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2342_fn_alias_err_").FullName
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
