// <copyright file="Issue524DefaultCtorEmitTests.cs" company="GSharp">
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
import System.Reflection.Emit
import Xunit

/// Issue #524: a class declared without an explicit `init(...)`
/// constructor must still be constructible via `T()` (matching the CLR /
/// C# behaviour of synthesising a parameterless default constructor that
/// zero-initialises every field). The same applies to imported CLR value
/// types: every `struct` implicitly has a zero-initialising default
/// constructor that maps to `initobj` in IL even though
/// (cref:Type.GetConstructors(BindingFlags)) does not surface it.
///
/// Each test compiles via `gsc`, ilverifies the produced PE, then
/// executes the assembly under `dotnet exec` and asserts on the
/// captured stdout.
open class Issue524DefaultCtorEmitTests {
    @Fact
    func GSharpClass_FieldsOnly_NoInit_DefaultConstructedAndFieldsRead() {
        // Repro 1 from the issue body, condensed to a runnable program: a
        // class with only fields and no explicit `init(...)` must be
        // constructible via `Holder()`, and the fields must be zero-init.
        let source = `package P
import System

class Holder {
    var Value int32
    var Name  string
    var Flag  bool
}

var h = Holder()
Console.WriteLine(h.Value)
Console.WriteLine(h.Name)
Console.WriteLine(h.Flag)`
        let output = CompileAndRun(source)
        // String fields default to CLR `null`, which Console.WriteLine
        // prints as an empty line.
        Assert.Equal("0${Environment.NewLine}${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_FieldsAndMethods_NoInit_DefaultConstructed() {
        // A class declaring both fields and methods (but still no `init`)
        // must round-trip: default-construct, mutate a field from outside,
        // observe via a method that closes over `this`.
        let source = `package P
import System

class Counter {
    var Count int32

    func Get() int32 {
        return this.Count
    }
}

var c = Counter()
c.Count = c.Count + 1
c.Count = c.Count + 1
c.Count = c.Count + 1
Console.WriteLine(c.Get())`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_NoMembersAtAll_DefaultConstructed() {
        // Degenerate case: a class with an empty body must still be
        // constructible. Mirrors C#'s `class Empty {}` semantics. Reaching
        // the println past the construction site proves the synthesised
        // ctor was both emitted and callable.
        let source = `package P
import System

class Empty { }

var e = Empty()
Console.WriteLine("ok")`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_ExplicitInit_StillWorks_RegressionGuard() {
        // Regression guard: classes that DO declare an explicit `init(...)`
        // must continue to be bound against that constructor's parameter
        // list. The fix for #524 must not short-circuit user-declared
        // constructors.
        let source = `package P
import System

class Point {
    var X int32
    var Y int32

    init(x int32, y int32) {
        X = x
        Y = y
    }
}

var p = Point(3, 4)
Console.WriteLine(p.X)
Console.WriteLine(p.Y)`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}4${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_PrimaryConstructor_StillWorks_RegressionGuard() {
        // Regression guard: primary-ctor classes must keep working after
        // the binder's `IsClass`-and-no-ctor relaxation.
        let source = `package P
import System

class Box(value int32) { }

var b = Box(42)
Console.WriteLine(b.value)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GSharpClass_NoInit_WrongArgCount_ReportsDiagnostic() {
        // The synthesised default ctor takes zero arguments. Calling the
        // class with a positional argument must report a wrong-argument-
        // count diagnostic against the class — not a misleading conversion
        // error or "function doesn't exist".
        let source = `package P
import System

class Holder { var Value int32 }

var h = Holder(1)
Console.WriteLine(h.Value)`
        let (exit, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exit)
        // gsc emits diagnostics through Console.Out, which our test
        // harness captures into `stdout`.
        Assert.Contains("Holder", stdout + stderr)
    }

    @Fact
    func ImportedClrStruct_NoExplicitCtors_DefaultConstructed_HashCode() {
        // System.HashCode is a public BCL struct with no explicit
        // constructors. `HashCode()` must zero-initialise it (the CLR
        // default) and the resulting instance must be usable.
        let source = `package P
import System

var h = HashCode()
h.Add("alpha")
h.Add("beta")
var code int32 = h.ToHashCode()
Console.WriteLine(code != 0)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func ImportedClrStruct_NoExplicitCtors_FromProbeAssembly() {
        // The exact shape from Repro 2 in the issue body: a user-authored
        // C# struct with no explicit constructors, imported into G# and
        // default-constructed via `CallbackBag()`. The probe assembly is
        // produced by Reflection.Emit (mirroring the issue #519 pattern).
        let source = `package P
import System
import Probe.CSharp

var bag = CallbackBag()
Console.WriteLine(bag.Counter)
Console.WriteLine(bag.Label)`
        let output = CompileAndRunWithProbe(source)
        // Label is a reference-type field on a freshly zero-initialised
        // value type, so it reads back as CLR `null` and prints empty.
        Assert.Equal("0${Environment.NewLine}${Environment.NewLine}", output)
    }

    @Fact
    func ImportedClrStruct_WithExplicitCtor_DefaultConstructorStillWorks() {
        // Regression guard for #524: a CLR struct that DOES declare an
        // explicit constructor must still also be constructible via the
        // implicit zero-init default constructor (this matches C# where
        // `new TimeSpan()` and `new TimeSpan(1, 0, 0)` both compile).
        let source = `package P
import System

var zero = TimeSpan()
Console.WriteLine(zero.Ticks)
var oneHour = TimeSpan(1, 0, 0)
Console.WriteLine(oneHour.TotalMinutes)`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}60${Environment.NewLine}", output)
    }

    @Fact
    func ImportedClrClass_WithDefaultCtor_RegressionGuard() {
        // Regression guard: a CLR class with a public parameterless
        // constructor must continue to be callable as `T()` — the issue
        // #524 fallback only triggers for value types, so reference-type
        // resolution must be unchanged.
        let source = `package P
import System
import System.Text

var sb = StringBuilder()
sb.Append("ok")
Console.WriteLine(sb.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func GSharpGenericClass_NoInit_DefaultConstructed_ReferenceTypeArg() {
        // The fix also applies to generic class definitions: `Box[string]()`
        // must work when `Box[T]` declares neither a primary ctor nor an
        // explicit `init(...)`. (Note: G# uses type-erased generics, so a
        // value-type type argument would leave the erased `object` field
        // null — same pre-existing limitation as `Box[int32]{}` literals.
        // We test only the reference-T case here, which round-trips
        // cleanly through the erased representation.)
        let source = `package P
import System

class Box[T] {
    var Value T
}

var bs = Box[string]()
Console.WriteLine(bs.Value)`
        let output = CompileAndRun(source)
        // Default-string is CLR null, which Console.WriteLine prints as
        // an empty line.
        Assert.Equal(Environment.NewLine, output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exit, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true)
            Assert.True(exit == 0, (`exited ` + "$exit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunWithProbe(source string) string {
            let (exit, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true, withProbe: true)
            Assert.True(exit == 0, (`exited ` + "$exit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, expectSuccess bool, withProbe bool = false)(
            ExitCode int32,
            Stdout string,
            Stderr string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue524_").FullName
            try {
                var probeDllPath string? = nil
                if withProbe {
                    probeDllPath = Path.Combine(tempDir, "ProbeCSharp.dll")
                    BuildProbeLibrary(probeDllPath)
                }
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if probeDllPath != nil {
                    args.Add("/r:" + probeDllPath)
                }
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
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
                if !expectSuccess {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                let verifyRefs[]?string = if probeDllPath != nil {
                    []string{probeDllPath}
                } else {
                    default([]?string)
                }
                IlVerifier.Verify(outPath, additionalReferences: verifyRefs)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(runtimeConfigPath)
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        /// Builds a small probe assembly containing a public struct
        /// `Probe.CSharp.CallbackBag` with two instance fields and no
        /// explicit constructors. Mirrors Repro 2 from issue #524 — and the
        /// exact shape that fails on `main` prior to the fix.
        private func BuildProbeLibrary(dllPath string?) {
            let coreAssembly = typeof(object).Assembly
            let asmName = AssemblyName("ProbeCSharp"){Version = Version(1, 0, 0, 0)}
            let asmBuilder = PersistedAssemblyBuilder(asmName, coreAssembly)
            let moduleBuilder = asmBuilder.DefineDynamicModule("ProbeCSharp")
            let typeBuilder = moduleBuilder.DefineType(
                "Probe.CSharp.CallbackBag",
                TypeAttributes.Public | TypeAttributes.SequentialLayout | TypeAttributes.Sealed | TypeAttributes.BeforeFieldInit | TypeAttributes.AnsiClass,
                parent: typeof(ValueType)
            )
            typeBuilder.DefineField("Counter", typeof(int32), FieldAttributes.Public)
            typeBuilder.DefineField("Label", typeof(string), FieldAttributes.Public)
            // Intentionally do NOT define any constructors — the whole point of
            // the probe is to exercise the implicit value-type default
            // constructor that Type.GetConstructors does not surface.
            typeBuilder.CreateType()
            asmBuilder.Save(dllPath!!)
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
