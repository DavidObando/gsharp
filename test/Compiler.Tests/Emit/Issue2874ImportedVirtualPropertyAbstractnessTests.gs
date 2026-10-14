// <copyright file="Issue2874ImportedVirtualPropertyAbstractnessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2874 — an imported `data class` carrying a property that is
/// virtual but NOT an override was classified as abstract, so any
/// cross-assembly construction reported
/// `GS0386: Cannot create an instance of the abstract type`.
///
/// `PropertySymbol.IsAbstract` inferred abstractness from declaration
/// shape (`IsVirtual && !IsOverride && !IsAutoProperty`
/// and no accessor body syntax). An imported property never carries body
/// syntax and is built with `isAutoProperty: false`, so every
/// `virtual newslot` imported property — which is what an `open prop`
/// with a body and what an interface implementation both emit — satisfied the
/// whole conjunction.
///
/// Issue #2870 had already fixed the `open override prop` half of this by
/// keeping overrides out of a new slot; this covers the remaining
/// non-override half. Abstractness for an imported property is now read
/// straight out of metadata instead of being inferred.
open class Issue2874ImportedVirtualPropertyAbstractnessTests {
    @Fact
    func ImportedDataClassWithOpenComputedProperty_IsConstructible() {
        const library = `package i2874lib1

open data class KEx(Id int32, Name string) {
    open prop Other string {
        get -> "x"
    }
}`
        const source = `package i2874a
import i2874lib1

func Main() {
    let k = KEx(1, "n")
    System.Console.WriteLine(k.Name + "," + k.Other)
}`
        Assert.Equal("n,x${Environment.NewLine}", CompileAndRun(source, library, "i2874lib1"))
    }

    @Fact
    func ImportedDataClassImplementingAnInterfaceProperty_IsConstructible() {
        // The actual Oahu shape: `ProfileKeyEx` implements `IProfileKeyEx`, so
        // its accessors are emitted `virtual newslot` even though nothing in
        // the source says `open`.
        const library = `package i2874lib2

interface IKey {
    prop AccountName string {
        get;
    }
}

data class ProfileKeyEx(AccountName string) : IKey`
        const source = `package i2874b
import i2874lib2

func Main() {
    let k = ProfileKeyEx("acct")
    System.Console.WriteLine(k.AccountName)
}`
        Assert.Equal("acct${Environment.NewLine}", CompileAndRun(source, library, "i2874lib2"))
    }

    @Fact
    func ImportedDataClassWithSettableAndVirtualProperty_IsConstructible() {
        // Mixes a settable auto-property (which is emitted with an explicit
        // MethodImpl, not a new virtual slot) with an `open` computed property
        // (which IS `virtual newslot`), so both accessor shapes coexist on one
        // imported type.
        //
        // A settable interface property must be declared explicitly rather
        // than positionally; a positional member emits no setter at all
        // (issue #2875), which is a separate defect.
        const library = `package i2874lib3

interface IBox {
    prop Value int32 {
        get;
        set;
    }
}

open data class Box : IBox {
    prop Value int32 {
        get;
        set;
    }

    open prop Doubled int32 -> Value * 2
}`
        const source = `package i2874c
import i2874lib3

func Main() {
    let b = Box()
    b.Value = 7
    System.Console.WriteLine(b.Value.ToString() + "," + b.Doubled.ToString())
}`
        Assert.Equal("7,14${Environment.NewLine}", CompileAndRun(source, library, "i2874lib3"))
    }

    @Fact
    func ImportedDataClassBuiltFromAReferenceAssembly_IsConstructible() {
        // MSBuild hands downstream compilations the `/refout` reference
        // assembly, not the implementation, so the import path must agree on
        // both. This is the shape that actually broke the Oahu build.
        const library = `package i2874lib4

open data class Challenge(Id int32) {
    open prop Kind string {
        get -> "captcha"
    }
}`
        const source = `package i2874d
import i2874lib4

func Main() {
    let c = Challenge(3)
    System.Console.WriteLine(c.Kind)
}`
        Assert.Equal(
            "captcha${Environment.NewLine}",
            CompileAndRunAgainstReferenceAssembly(source, library, "i2874lib4")
        )
    }

    @Fact
    func ImportedGenuinelyAbstractDataClass_IsStillNotConstructible() {
        // Control: reading abstractness from metadata must not make a truly
        // abstract imported type look concrete. A no-body `open prop` on an
        // `open data class` emits an abstract accessor.
        const library = `package i2874lib5

open data class Shape {
    open prop Name string {
        get;
    }
}

data class Square : Shape {
    override prop Name string -> "square"
}`
        const source = `package i2874e
import i2874lib5

func Main() {
    let s = Shape()
    System.Console.WriteLine(s.Name)
}`
        let diagnostics = CompileExpectingFailure(source, library, "i2874lib5")
        Assert.Contains("GS0386", diagnostics)
    }

    @Fact
    func LocallyDeclaredAbstractShapedDataClass_IsStillNotConstructible() {
        // Control: the source-shape inference is still the authority for a
        // property declared in the current compilation.
        const source = `package i2874f

open data class Local {
    open prop Tag string {
        get;
    }
}

func Main() {
    let l = Local()
    System.Console.WriteLine(l.Tag)
}`
        let diagnostics = CompileExpectingFailure(source, library: nil, libraryAssemblyName: nil)
        Assert.Contains("GS0386", diagnostics)
    }

    shared {
        private func CompileAndRun(source string, library string? = nil, libraryAssemblyName string? = nil) string {
            return RunBuilt(source, library, libraryAssemblyName, useReferenceAssembly: false)
        }

        private func CompileAndRunAgainstReferenceAssembly(
            source string,
            library string,
            libraryAssemblyName string
        ) string {
            return RunBuilt(source, library, libraryAssemblyName, useReferenceAssembly: true)
        }

        private func RunBuilt(
            source string,
            library string?,
            libraryAssemblyName string?,
            useReferenceAssembly bool
        ) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2874_").FullName
            try {
                let dllPath = BuildExecutable(
                    tempDir,
                    source,
                    library,
                    libraryAssemblyName,
                    useReferenceAssembly,
                    out var libDll
                )
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
                } catch (IOException) { }
            }
        }

        private func CompileExpectingFailure(source string, library string?, libraryAssemblyName string?) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2874_err_").FullName
            try {
                let args = List[string]{
                    "/out:" + Path.Combine(tempDir, "test.dll"),
                    "/target:exe",
                    "/targetframework:net10.0"
                }
                if library != nil {
                    let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                    let libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                    File.WriteAllText(libSrc, library)
                    Compile([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                    args.Add("/r:" + libDll)
                }
                let srcPath = Path.Combine(tempDir, "test.gs")
                File.WriteAllText(srcPath, source)
                args.Add(srcPath)
                return CompileCapturingOutput(args.ToArray())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }

        private func BuildExecutable(
            tempDir string,
            source string,
            library string?,
            libraryAssemblyName string?,
            useReferenceAssembly bool,
            out libDll string?
        ) string {
            libDll = nil
            var referencePath string? = nil
            if library != nil {
                // ilverify resolves `-r` references by FILE NAME, so the library
                // must be written out under its assembly identity.
                let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                File.WriteAllText(libSrc, library)
                let libArgs = List[string]{"/out:" + libDll, "/target:library", "/targetframework:net10.0"}
                if useReferenceAssembly {
                    // The reference assembly must live in its own directory: it
                    // shares the library's assembly identity, and the runtime must
                    // still load the IMPLEMENTATION next to the executable.
                    let refDir = Path.Combine(tempDir, "ref")
                    Directory.CreateDirectory(refDir)
                    referencePath = Path.Combine(refDir, libraryAssemblyName + ".dll")
                    libArgs.Add("/refout:" + referencePath)
                }
                libArgs.Add(libSrc)
                Compile(libArgs.ToArray())
                IlVerifier.Verify(libDll!!)
            }
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
            if libDll != nil {
                args.Add("/r:" + (referencePath ?? libDll))
            }
            args.Add(srcPath)
            Compile(args.ToArray())
            return dllPath
        }

        private func Compile(args[]string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
        }

        private func CompileCapturingOutput(args[]string) string {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit != 0, "expected gsc to fail but it succeeded")
            return stdoutWriter.ToString() + stderrWriter.ToString()
        }
    }
}
