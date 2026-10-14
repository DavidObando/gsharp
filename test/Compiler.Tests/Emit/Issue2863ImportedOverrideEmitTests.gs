// <copyright file="Issue2863ImportedOverrideEmitTests.cs" company="GSharp">
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

/// Issue #2863 — `ClrTypeUtilities.SafeIsOverride` probed
/// `MethodInfo.GetBaseDefinition()`, which `MetadataLoadContext` does
/// not implement: it throws `NotSupportedException` for EVERY method, and
/// `IsMetadataLoadFailure` classifies that as a load failure, so the
/// conservative "not an override" default was returned for every imported
/// member.
///
/// `PropertySymbol.IsAbstract` is
/// `IsVirtual && !IsOverride && !IsAutoProperty && …`
/// and imported properties never carry body syntax, so an imported property
/// that OVERRIDES a base declaration looked abstract. That made
/// `StructSymbol.IsAbstract` mark the whole imported type abstract, and
/// every cross-assembly use site reported
/// `GS0386: Cannot create an instance of the abstract type`.
///
/// The override bit is now read straight out of metadata: a method that
/// introduces a new virtual slot is emitted `virtual newslot`, one that
/// overrides an inherited slot is not.
open class Issue2863ImportedOverrideEmitTests {
    @Fact
    func ImportedDataClassOverridingAbstractShapedBaseProperty_Runs() {
        // The exact Oahu shape: `public abstract record` translates to an
        // `open data class` with a no-body `open prop`, and the concrete
        // derived record overrides it.
        const library = `package i2863lib

open data class Base {
    open prop Kind string {
        get;
    }
}

open data class Derived(Value int32) : Base {
    open override prop Kind string -> "derived"
}`
        const source = `package i2863a
import i2863lib

func Main() {
    let d = Derived(7)
    System.Console.WriteLine(d.Kind + ":" + d.Value.ToString())
}`
        Assert.Equal("derived:7${Environment.NewLine}", CompileAndRun(source, library, "i2863lib"))
    }

    @Fact
    func ImportedDataClassWithSeveralOverriddenProperties_Runs() {
        // Only the semantic-aggregate path (records / data classes) feeds
        // SafeIsOverride, so every load-bearing fact here uses a data class.
        const library = `package i2863lib2

open data class Shape {
    open prop Name string {
        get;
    }

    open prop Sides int32 {
        get;
    }
}

open data class Square : Shape {
    open override prop Name string -> "square"

    open override prop Sides int32 -> 4
}`
        const source = `package i2863b
import i2863lib2

func Main() {
    let s = Square()
    System.Console.WriteLine(s.Name + ":" + s.Sides.ToString())
}`
        Assert.Equal("square:4${Environment.NewLine}", CompileAndRun(source, library, "i2863lib2"))
    }

    @Fact
    func ImportedDataClassDerivedAssignedToBaseTypedLocal_DispatchesVirtually() {
        // The overriding property must still be virtual, so a base-typed
        // reference dispatches to the derived implementation.
        const library = `package i2863lib3

open data class Shape {
    open prop Name string {
        get;
    }
}

open data class Square : Shape {
    open override prop Name string -> "square"
}

open data class Circle : Shape {
    open override prop Name string -> "circle"
}`
        const source = `package i2863c
import i2863lib3

func Main() {
    let a Shape = Square()
    let b Shape = Circle()
    System.Console.WriteLine(a.Name + "," + b.Name)
}`
        Assert.Equal("square,circle${Environment.NewLine}", CompileAndRun(source, library, "i2863lib3"))
    }

    @Fact
    func ImportedDataClassTwoLevelOverrideChain_UsesMostDerivedImplementation() {
        // A middle type that both overrides and is overridden exercises the
        // `virtual, no newslot` classification on BOTH ends of the chain.
        const library = `package i2863lib4

open data class Level0 {
    open prop Tag string {
        get;
    }
}

open data class Level1 : Level0 {
    open override prop Tag string -> "one"
}

open data class Level2 : Level1 {
    open override prop Tag string -> "two"
}`
        const source = `package i2863d
import i2863lib4

func Main() {
    let a Level0 = Level1()
    let b Level0 = Level2()
    System.Console.WriteLine(a.Tag + "," + b.Tag)
}`
        Assert.Equal("one,two${Environment.NewLine}", CompileAndRun(source, library, "i2863lib4"))
    }

    @Fact
    func ImportedAbstractShapedDataClassBase_IsStillNotConstructible() {
        // Non-vacuity guard in the other direction: reading the override bit
        // from metadata must NOT make genuinely abstract imported types look
        // concrete.
        const library = `package i2863lib5

open data class Shape {
    open prop Name string {
        get;
    }
}

open data class Square : Shape {
    open override prop Name string -> "square"
}`
        const source = `package i2863e
import i2863lib5

func Main() {
    let s = Shape()
    System.Console.WriteLine(s.Name)
}`
        let diagnostics = CompileExpectingFailure(source, library, "i2863lib5")
        Assert.Contains("GS0386", diagnostics)
    }

    @Fact
    func ImportedNonVirtualProperty_IsUnaffected() {
        // Control: an ordinary sealed-shaped imported property is neither
        // virtual nor an override, and keeps working.
        const library = `package i2863lib6

class Holder(Value int32) {
    prop Doubled int32 -> Value * 2
}`
        const source = `package i2863f
import i2863lib6

func Main() {
    let h = Holder(21)
    System.Console.WriteLine(h.Doubled.ToString())
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source, library, "i2863lib6"))
    }

    shared {
        private func CompileAndRun(source string, library string? = nil, libraryAssemblyName string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2863_exe_").FullName
            try {
                let dllPath = BuildExecutable(tempDir, source, library, libraryAssemblyName, out var libDll)
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

        private func CompileExpectingFailure(source string, library string, libraryAssemblyName string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2863_err_").FullName
            try {
                let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                let libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                File.WriteAllText(libSrc, library)
                Compile([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                let srcPath = Path.Combine(tempDir, "test.gs")
                File.WriteAllText(srcPath, source)
                return CompileCapturingOutput(
                    []string{
                        "/out:" + Path.Combine(tempDir, "test.dll"),
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/r:" + libDll,
                        srcPath
                    }
                )
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
            out libDll string?
        ) string {
            libDll = nil
            if library != nil {
                // ilverify resolves `-r` references by FILE NAME, so the library
                // must be written out under its assembly identity.
                let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                File.WriteAllText(libSrc, library)
                Compile([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                IlVerifier.Verify(libDll!!)
            }
            let srcPath = Path.Combine(tempDir, "test.gs")
            let dllPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
            if libDll != nil {
                args.Add("/r:" + libDll)
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
