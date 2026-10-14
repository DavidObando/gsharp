// <copyright file="Issue988TypeParameterConstructionEmitTests.cs" company="GSharp">
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
import Xunit.Sdk

/// End-to-end emit tests for issue #988 — constructing a type parameter under a
/// `init()` default-constructor constraint (`T()` where `[T init()]`).
///
/// G# now accepts a `init()` constraint on a generic type or function
/// parameter and lets the body construct that parameter with the call-like
/// spelling `T()`. The construction lowers to a reified
/// `System.Activator.CreateInstance<T>()` (ADR-0087), which works for
/// both reference types with a public parameterless constructor and value types.
/// These tests lock the feature in at the emit layer: parse + bind + emit +
/// ilverify + execute, plus the two negative diagnostics (GS0152 for a type
/// argument that cannot satisfy `init()`, GS0389 for constructing a type
/// parameter that lacks the constraint), and a metadata assertion that the
/// emitted GenericParam row carries `DefaultConstructorConstraint`.
open class Issue988TypeParameterConstructionEmitTests {
    @Fact
    func GenericClass_ConstructsValueTypeParameter_PrintsDefault() {
        // The canonical issue #988 sample: a generic factory whose Make()
        // constructs its `[T init()]` parameter. Closed over int32, the default
        // instance is 0.
        let source = `package T
import System
class Factory[T init()] {
    func Make() T { return T() }
}
let f = Factory[int32]()
Console.WriteLine(f.Make().ToString())`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericClass_ConstructsReferenceTypeParameter_IsNonNull() {
        // A user reference type with the implicit public parameterless ctor is
        // constructed through the factory and its field observed — proving the
        // instance is real (non-null), not `default(T)` (which would be null).
        let source = `package T
import System
class Node {
    var Value int32 = 42
}
class Factory[T init()] {
    func Make() T { return T() }
}
let f = Factory[Node]()
let n = f.Make()
Console.WriteLine(n.Value.ToString())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericFunction_ConstructsTypeParameter_PrintsField() {
        // The `init()` constraint and `T()` construction also work on a generic
        // FUNCTION (not just a generic type).
        let source = `package T
import System
class Node {
    var Value int32 = 7
}
func make[U init()]() U { return U() }
let m = make[Node]()
Console.WriteLine(m.Value.ToString())`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func TypeArgumentWithoutParameterlessCtor_ReportsGs0152() {
        // A type argument that lacks an accessible parameterless constructor
        // cannot satisfy the `init()` constraint at the instantiation site.
        let source = `package T
class NoCtor(Value int32) { }
class Factory[T init()] {
    func Make() T { return T() }
}
let f = Factory[NoCtor]()`
        let diagnostics = CompileAndExpectFailure(source)
        Assert.Contains("GS0152", diagnostics)
    }

    @Fact
    func ConstructingTypeParameterWithoutNewConstraint_ReportsGs0389() {
        // Constructing a type parameter that carries no `init()` constraint is a
        // clean compile error pointing at the missing constraint.
        let source = `package T
class Factory[T class] {
    func Make() T { return T() }
}`
        let diagnostics = CompileAndExpectFailure(source)
        Assert.Contains("GS0389", diagnostics)
    }

    @Fact
    func EmittedGenericParam_CarriesDefaultConstructorConstraintFlag() {
        // ADR-0087: the emitted GenericParam row must faithfully carry the
        // DefaultConstructorConstraint flag so the metadata round-trips.
        let source = `package T
class Factory[T init()] {
    func Make() T { return T() }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue988_meta_").FullName
        try {
            let outPath = CompileLibrary(source, tempDir)
            let asm = EmittedFixture.Load(outPath)
            let factory = asm.GetTypes().First((t Type) -> t.Name.StartsWith("Factory", StringComparison.Ordinal))
            let tp = factory.GetGenericArguments().Single()
            Assert.True(
                tp.GenericParameterAttributes.HasFlag(GenericParameterAttributes.DefaultConstructorConstraint),
                "Expected DefaultConstructorConstraint on '${tp.Name}', got ${tp.GenericParameterAttributes}."
            )
        } finally {
            TryDeleteDirectory(tempDir)
        }
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue988_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let (compileExit, compileText) = RunCompiler(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileText")
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
                TryDeleteDirectory(tempDir)
            }
        }

        private func CompileLibrary(source string, tempDir string) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let (compileExit, compileText) = RunCompiler(
                []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            )
            Assert.True(compileExit == 0, "compile failed ($compileExit): $compileText")
            return outPath
        }

        private func CompileAndExpectFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue988_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let (compileExit, compileText) = RunCompiler(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
                Assert.True(compileExit != 0, "expected compile failure but it succeeded: $compileText")
                return compileText
            } finally {
                TryDeleteDirectory(tempDir)
            }
        }

        private func RunCompiler(args[]string)(Exit int32, Output string) {
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
            return (compileExit, compileOut.ToString() + compileErr.ToString())
        }

        private func TryDeleteDirectory(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch { }
        }
    }
}
