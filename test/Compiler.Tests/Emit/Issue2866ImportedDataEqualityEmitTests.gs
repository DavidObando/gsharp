// <copyright file="Issue2866ImportedDataEqualityEmitTests.cs" company="GSharp">
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

/// Issue #2866 — structural `==` / `!=` over a data class or data
/// struct that lives in a REFERENCED assembly crashed the emitter with
/// `GS9998: KeyNotFoundException`.
///
/// The structural-equality arm of `MethodBodyEmitter.EmitBinaryExpression`
/// eagerly read `cache.StructTypeDefs[ds]`. That dictionary only holds
/// TypeDef rows for types declared in the CURRENT compilation; an imported data
/// type is a semantic aggregate projected off an `ImportedTypeSymbol` and
/// has no row there, so the indexer threw. The token is now resolved through
/// `GetElementTypeToken` (TypeDef for local, TypeRef/TypeSpec for
/// imported) and is only computed when a `box` is actually emitted, which
/// is never the case for a data CLASS.
open class Issue2866ImportedDataEqualityEmitTests {
    @Fact
    func EqualityOnImportedDataClass_CompilesAndComparesStructurally() {
        const library = `package i2866lib1

data class Point(X int32, Y int32)`
        const source = `package i2866a
import i2866lib1

func Main() {
    let a = Point(1, 2)
    let b = Point(1, 2)
    let c = Point(3, 4)
    System.Console.WriteLine((a == b).ToString() + "," + (a == c).ToString())
}`
        Assert.Equal("True,False${Environment.NewLine}", CompileAndRun(source, library, "i2866lib1"))
    }

    @Fact
    func InequalityOnImportedDataClass_CompilesAndComparesStructurally() {
        const library = `package i2866lib2

data class Pair(Left string, Right string)`
        const source = `package i2866b
import i2866lib2

func Main() {
    let a = Pair("l", "r")
    let b = Pair("l", "r")
    let c = Pair("l", "x")
    System.Console.WriteLine((a != b).ToString() + "," + (a != c).ToString())
}`
        Assert.Equal("False,True${Environment.NewLine}", CompileAndRun(source, library, "i2866lib2"))
    }

    @Fact
    func EqualityOnImportedDataStruct_BoxesThroughAnImportedTypeToken() {
        // A data STRUCT is the branch that actually needs the element token:
        // both operands are boxed before the static Object.Equals call, and
        // for an imported type that token must be a TypeRef, not a TypeDef.
        const library = `package i2866lib3

data struct Vec(X int32, Y int32)`
        const source = `package i2866c
import i2866lib3

func Main() {
    let a = Vec(1, 2)
    let b = Vec(1, 2)
    let c = Vec(9, 9)
    System.Console.WriteLine((a == b).ToString() + "," + (a == c).ToString())
}`
        Assert.Equal("True,False${Environment.NewLine}", CompileAndRun(source, library, "i2866lib3"))
    }

    @Fact
    func EqualityOnImportedOpenDataClassHierarchy_UsesRuntimeType() {
        // Structural equality routes through Object.Equals, so a derived data
        // class must not compare equal to its base even with equal fields.
        const library = `package i2866lib4

open data class Node(Id int32)

data class Leaf(Id int32) : Node(Id)`
        const source = `package i2866d
import i2866lib4

func Main() {
    let a Node = Node(1)
    let b Node = Leaf(1)
    System.Console.WriteLine((a == b).ToString())
}`
        Assert.Equal("False${Environment.NewLine}", CompileAndRun(source, library, "i2866lib4"))
    }

    @Fact
    func EqualityOnLocallyDeclaredDataClass_StillWorks() {
        // Control: the same-compilation path must keep resolving to the local
        // TypeDef row and behave exactly as before.
        const source = `package i2866e

data class Local(A int32)

data struct LocalVal(A int32)

func Main() {
    let x = Local(5)
    let y = Local(5)
    let p = LocalVal(7)
    let q = LocalVal(8)
    System.Console.WriteLine((x == y).ToString() + "," + (p == q).ToString())
}`
        Assert.Equal("True,False${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        internal func CompileAndRun(source string, library string? = nil, libraryAssemblyName string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2866_").FullName
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
    }
}
