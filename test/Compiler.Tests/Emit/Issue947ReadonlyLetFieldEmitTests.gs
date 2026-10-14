// <copyright file="Issue947ReadonlyLetFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #947 regression tests for read-only (`let`) fields gaining C#
/// `readonly`-field semantics: a `let` field is assignable exactly
/// during construction — by its declaration initializer and/or inside the
/// declaring type's constructor (`init(...)`) — and immutable everywhere
/// else. The cases exercised end-to-end are:
/// - a `let` field with no initializer assigned inside the constructor and read back at runtime (bare
/// `x = v` form);
/// - the same through the qualified `this.x = v` form;
/// - a `let` field with an initializer that is overwritten in the constructor (multiple ctor writes are
/// allowed, like C#);
/// - assigning a `let` field from a non-constructor method is a compile error (`GS0127`);
/// - assigning a `let` field on a different instance is a compile error (`GS0127`);
/// - the emitted field carries the CLR `initonly` flag — the metadata encoding of a C# `readonly`
/// field.
/// The run tests compile a hermetic program with `gsc` in-process, IL
/// verify the produced assembly, and execute it with `dotnet exec`.
open class Issue947ReadonlyLetFieldEmitTests {
    @Fact
    func LetField_AssignedInConstructor_NoInitializer_RoundTrips() {
        let source = `package P
import System

class Point {
    let x int32
    let y int32
    init(a int32, b int32) {
        x = a
        y = b
    }
    func Sum() int32 {
        return x + y
    }
}

let p = Point(3, 4)
Console.WriteLine(p.Sum())`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LetField_AssignedViaThisInConstructor_RoundTrips() {
        let source = `package P
import System

class Person {
    let name string
    let age int32
    init(n string) {
        this.name = n
        this.age = 30
    }
}

let a = Person("ctor")
Console.WriteLine(a.name)
Console.WriteLine(a.age)`
        Assert.Equal("ctor${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LetField_WithInitializer_OverwrittenInConstructor_RoundTrips() {
        // C# permits any number of writes to a readonly field within the
        // constructor; the declaration initializer plus a ctor overwrite is
        // allowed and the last write wins.
        let source = `package P
import System

class Config {
    let value int32 = 10
    init(v int32) {
        value = v
    }
    func Get() int32 {
        return value
    }
}

let c = Config(42)
Console.WriteLine(c.Get())`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AssigningLetField_FromNormalMethod_IsCompileError() {
        // Negative test: writing a `let` field outside the constructor remains
        // a GS0127 ("read-only") error.
        let source = `package P

class C {
    let x int32
    init() {
        x = 1
    }
    func Bad() {
        x = 2
    }
}`
        let diagnostics = Emit(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func AssigningLetField_OnAnotherInstance_IsCompileError() {
        // Negative test: writing a `let` field on a *different* instance (not
        // `this`) is rejected even though the assignment textually appears in a
        // method of the declaring type.
        let source = `package P

class C {
    let x int32
    init(v int32) {
        x = v
    }
    func Copy(other C) {
        other.x = 99
    }
}`
        let diagnostics = Emit(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func EmittedLetField_IsInitOnly() {
        let source = `package P
import System

class Point {
    let x int32
    var y int32
    init(a int32, b int32) {
        x = a
        y = b
    }
}

let p = Point(1, 2)
Console.WriteLine(p.x)`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue947_initonly_").FullName
        try {
            let outPath = Path.Combine(tempDir, "test.dll")
            let (exit, output) = Compile(source, outPath, tempDir)
            Assert.True(exit == 0, "gsc failed: $output")
            let alc = AssemblyLoadContext("issue947-initonly", isCollectible: true)
            try {
                let asm = alc.LoadFromAssemblyPath(outPath)
                let pointType = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "Point") ??
                    throw InvalidOperationException("Point type not found")
                let letField = pointType.GetField(
                    "x",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                ) ??
                    throw InvalidOperationException("field 'x' not found")
                Assert.True(letField.IsInitOnly, "the `let` field must be emitted as initonly")
                let varField = pointType.GetField(
                    "y",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                ) ??
                    throw InvalidOperationException("field 'y' not found")
                Assert.False(varField.IsInitOnly, "the `var` field must not be initonly")
            } finally {
                alc.Unload()
            }
        } finally {
            TryDeleteDirectory(tempDir)
        }
    }

    shared {
        private func Emit(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source, "issue947.gs"))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream, refStream: nil)
            return result.Diagnostics
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue947_").FullName
            try {
                let outPath = Path.Combine(tempDir, "test.dll")
                let (exit, output) = Compile(source, outPath, tempDir)
                Assert.True(exit == 0, "gsc failed: $output")
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
                TryDeleteDirectory(tempDir)
            }
        }

        private func Compile(source string, outPath string, tempDir string)(Exit int32, Output string) {
            let srcPath = Path.Combine(tempDir, "test.gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
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
            return (compileExit, (`stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }

        private func TryDeleteDirectory(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch {
                // Best-effort cleanup; the OS reclaims scratch directories later.

            }
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
