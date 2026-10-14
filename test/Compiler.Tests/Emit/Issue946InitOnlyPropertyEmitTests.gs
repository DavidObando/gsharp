// <copyright file="Issue946InitOnlyPropertyEmitTests.cs" company="GSharp">
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
import System.Runtime.CompilerServices
import System.Runtime.Loader
import Xunit

/// Issue #946 regression tests for the first-class `init` property
/// accessor. The G# property forms `{ get; init; }` (auto) and
/// `init { ... }` (computed) are exercised end-to-end:
/// - an init-only property set through a C#-style object initializer at the creation site is read back
/// at runtime;
/// - an init-only property set inside the declaring type's constructor is read back at runtime;
/// - assigning an init-only property <em>after</em> construction is a compile error (`GS0372`);
/// - the emitted `set_Prop` setter carries the `System.Runtime.CompilerServices.IsExternalInit` modreq
/// on its void return — the standard CLR encoding for init-only setters.
/// The run tests compile a hermetic program with `gsc` in-process, IL
/// verify the produced assembly, and execute it with `dotnet exec`.
open class Issue946InitOnlyPropertyEmitTests {
    @Fact
    func AutoInitProperty_SetViaObjectInitializer_RoundTrips() {
        let source = `package P
import System

class Config {
    prop Host string { get; init; }
    prop Port int32 { get; init; }
}

let c = Config() { Host = "localhost", Port = 8080 }
Console.WriteLine(c.Host)
Console.WriteLine(c.Port)`
        Assert.Equal("localhost${Environment.NewLine}8080${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AutoInitProperty_SetViaConstructor_RoundTrips() {
        let source = `package P
import System

class Person {
    prop Name string { get; init; }
    prop Age int32 { get; init; }

    init(name string) {
        this.Name = name
        this.Age = 30
    }
}

let a = Person("ctor")
Console.WriteLine(a.Name)
Console.WriteLine(a.Age)`
        Assert.Equal("ctor${Environment.NewLine}30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ComputedInitAccessor_WithBody_RunsAtInitialization() {
        let source = `package P
import System

class Box {
    var raw int32
    prop Value int32 {
        get { return raw }
        init { raw = value * 2 }
    }
}

let x = Box() { Value = 21 }
Console.WriteLine(x.Value)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EmittedInitSetter_CarriesIsExternalInitModReq() {
        let source = `package P
import System

class Config {
    prop Host string { get; init; }
    prop Port int32 { get; set; }
}

let c = Config() { Host = "h", Port = 1 }
Console.WriteLine(c.Host)`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue946_modreq_").FullName
        try {
            let outPath = Path.Combine(tempDir, "test.dll")
            let (exit, output) = Compile(source, outPath, tempDir)
            Assert.True(exit == 0, "gsc failed: $output")
            let alc = AssemblyLoadContext("issue946-modreq", isCollectible: true)
            try {
                let asm = alc.LoadFromAssemblyPath(outPath)
                let configType = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "Config") ??
                    throw InvalidOperationException("Config type not found")
                // The init-only property's setter return must carry the
                // IsExternalInit modreq; the plain `set;` property must not.
                let initSetter = configType.GetProperty("Host")!!.SetMethod!!
                let initMods = initSetter.ReturnParameter.GetRequiredCustomModifiers()
                Assert.Contains(initMods, (t Type) -> t == typeof(IsExternalInit))
                let plainSetter = configType.GetProperty("Port")!!.SetMethod!!
                let plainMods = plainSetter.ReturnParameter.GetRequiredCustomModifiers()
                Assert.DoesNotContain(plainMods, (t Type) -> t == typeof(IsExternalInit))
            } finally {
                alc.Unload()
            }
        } finally {
            TryDeleteDirectory(tempDir)
        }
    }

    @Fact
    func AssigningInitOnlyProperty_AfterConstruction_IsCompileError() {
        // Negative test: a plain assignment to an init-only G# property outside
        // any object-initialization context must report GS0372.
        let source = `package P

class Person {
    prop Name string { get; init; }
}

let a = Person()
a.Name = "after"`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue946_negative.gs"))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, refStream: nil)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0372")
    }

    @Fact
    func DeclaringBothSetAndInit_IsCompileError() {
        let source = `package P

class C {
    prop X int32 { get; set; init; }
}`
        let tree = SyntaxTree.Parse(SourceText.From(source, "issue946_both.gs"))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream, refStream: nil)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0373")
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue946_").FullName
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
