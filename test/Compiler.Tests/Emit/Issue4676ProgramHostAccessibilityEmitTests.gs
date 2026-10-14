// <copyright file="Issue4676ProgramHostAccessibilityEmitTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit
import Xunit.Sdk

/// Issue #4676: every package of a G# assembly gets a synthesized
/// `<Program>` host type, and it was always `public`. For a
/// library package that hosts nothing another assembly can reach, that exported
/// one empty public type per namespace (22 in the migrated GSharp.Core, none in
/// the C# build), which then leaks into reflection-based API enumeration. The
/// host is now emitted NotPublic unless it carries a public function or global
/// (it is how a package exposes those) or the compilation has an entry point.
open class Issue4676ProgramHostAccessibilityEmitTests {
    @Fact
    func LibraryPackageOfOnlyTypes_HasNoPublicProgramHost() {
        let dll = CompileLibrary(`package Lib.Types

class Foo {
}

enum Color { Red, Green }`)
        try {
            Assert.Equal(TypeAttributes.NotPublic, GetProgramHostVisibility(dll))
            Assert.Empty(GetPublicSynthesizedTypeNames(dll))
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    @Fact
    func LibraryPackageWithOnlyInternalAndPrivateFunctions_HasNoPublicProgramHost() {
        let dll = CompileLibrary(`package Lib.Internal

internal func Hidden() int32 {
    return 41
}

private func AlsoHidden() int32 {
    return 1
}

class Foo {
}`)
        try {
            Assert.Equal(TypeAttributes.NotPublic, GetProgramHostVisibility(dll))
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    @Fact
    func LibraryPackageWithOnlyInternalFunctionsAndFunctionLiterals_HasNoPublicProgramHost() {
        // A zero-capture function literal is hosted on `<Program>` as a static method whose
        // symbol is public by default; it is not something another assembly can name, so
        // it must not keep the host public.
        let dll = CompileLibrary(`package Lib.Literals

internal func Hidden() int32 {
    let double = (x int32) -> x * 2
    let next = (y int32) -> y + 1
    return double(next(20))
}`)
        try {
            Assert.Equal(TypeAttributes.NotPublic, GetProgramHostVisibility(dll))
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    @Fact
    func LibraryPackageWithAPublicFunction_KeepsAPublicProgramHost_AndAConsumerCallsIt() {
        let lib = CompileLibrary(`package Lib.Api

func Add(a int32, b int32) int32 {
    return a + b
}`)
        try {
            Assert.Equal(TypeAttributes.Public, GetProgramHostVisibility(lib))
            // The host is how another assembly reaches the function, so the
            // consumer must still bind and run through it.
            let consumerSource = `package Consumer

import Lib.Api
import System

func Main() {
    Console.WriteLine(Add(40, 2))
}`
            // The assembly is named after its package, so a reference to it
            // has to be found by that file name (ILVerify and the runtime).
            let libByName = Path.Combine(Path.GetDirectoryName(lib)!!, "Lib.Api.dll")
            File.Copy(lib, libByName)
            let exe = Compile(consumerSource, "exe", libByName)
            File.Copy(libByName, Path.Combine(Path.GetDirectoryName(exe)!!, "Lib.Api.dll"))
            try {
                Assert.Equal("42\n", Run(exe))
            } finally {
                TryDeleteDir(Path.GetDirectoryName(exe))
            }
        } finally {
            TryDeleteDir(Path.GetDirectoryName(lib))
        }
    }

    @Fact
    func Executable_KeepsItsEntryPointProgramHostPublic() {
        let exe = Compile(`package App

import System

class Foo {
}

func Main() {
    Console.WriteLine("hi")
}`, "exe")
        try {
            Assert.Equal(TypeAttributes.Public, GetProgramHostVisibility(exe))
            Assert.Equal("hi\n", Run(exe))
        } finally {
            TryDeleteDir(Path.GetDirectoryName(exe))
        }
    }

    shared {
        private func GetProgramHostVisibility(dllPath string) TypeAttributes {
            using let fs = File.OpenRead(dllPath)
            using let pe = PEReader(fs)
            let mr = pe.GetMetadataReader()
            for typeHandle in mr.TypeDefinitions {
                let type = mr.GetTypeDefinition(typeHandle)
                if mr.GetString(type.Name) == "<Program>" {
                    return type.Attributes & TypeAttributes.VisibilityMask
                }
            }
            throw XunitException("no <Program> host in $dllPath")
        }

        private func GetPublicSynthesizedTypeNames(dllPath string)[]string {
            using let fs = File.OpenRead(dllPath)
            using let pe = PEReader(fs)
            let mr = pe.GetMetadataReader()
            return mr
                .TypeDefinitions
                .Select((handle TypeDefinitionHandle) -> mr.GetTypeDefinition(handle))
                .Where(
                (type TypeDefinition) -> mr.GetString(type.Name).StartsWith('<') && mr.GetString(
                    type.Name
                ) != "<Module>"
            )
                .Where(
                (type TypeDefinition) -> (
                    (type.Attributes & TypeAttributes.VisibilityMask) is TypeAttributes.Public or
                        TypeAttributes.NestedPublic
                )
            )
                .Select((type TypeDefinition) -> mr.GetString(type.Name))
                .ToArray()
        }

        private func CompileLibrary(source string) string -> Compile(source, "library")

        private func Compile(source string, target string, reference string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4676_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            if reference != nil {
                args.Add("/r:" + reference)
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
            try {
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(
                    outPath,
                    if reference == nil {
                        Array.Empty[string]()
                    } else {
                        []string{reference}
                    }
                )
            } catch {
                // The caller owns the directory only once this returns; a failure here would
                // otherwise leak it.
                TryDeleteDir(tempDir)
                rethrow
            }
            return outPath
        }

        private func Run(dll string) string {
            File.WriteAllText(Path.ChangeExtension(dll, "runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let psi = ProcessStartInfo("dotnet", "exec \"" + dll + "\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            proc!!.WaitForExit()
            Assert.True(proc!!.ExitCode == 0, "exited " + proc!!.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
            return stdout.ReplaceLineEndings("\n")
        }

        private func TryDeleteDir(dir string?) {
            try {
                if dir != nil {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
