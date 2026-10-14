// <copyright file="Issue950ProtectedModifierEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit
import Xunit.Sdk

/// Issue #950 — the `protected` access modifier. A `protected` member
/// of an `open class` is accessible from the declaring type and the bodies
/// of derived types, and is emitted as CIL `family` accessibility so the
/// CLR independently enforces the same rule. External access is a compile
/// error (GS0379); `protected` on a non-inheritable type is GS0380.
open class Issue950ProtectedModifierEmitTests {
    @Fact
    func DerivedClass_AccessesInheritedProtectedFieldAndMethod_Runs() {
        CompileVerifyAndRun(`package Maui.Issue950.Tests

import System

open class Base {
    protected var secret int32
    protected func Reveal() int32 {
        return secret
    }
}

class Derived : Base {
    func Show() int32 {
        secret = 7
        return secret + Reveal()
    }
}

func Main() {
    let d = Derived{}
    Console.WriteLine(d.Show())
}`, "14\n")
    }

    @Fact
    func ProtectedVirtualMethod_OverriddenInDerived_DispatchesVirtually() {
        CompileVerifyAndRun(`package Maui.Issue950.Tests

import System

open class Animal {
    protected open func Sound() string {
        return "..."
    }
    func Describe() string {
        return Sound()
    }
}

open class Dog : Animal {
    protected override func Sound() string {
        return "Woof"
    }
}

func Main() {
    let a = Animal{}
    let d = Dog{}
    Console.WriteLine(a.Describe())
    Console.WriteLine(d.Describe())
}`, `...
Woof
`)
    }

    /// Guard: a `protected` field and method of an `open class` must
    /// be emitted with CIL `family` accessibility.
    @Fact
    func ProtectedMembers_AreEmittedFamily() {
        let dll = CompileToDll(`package Maui.Issue950.Tests

import System

open class Base {
    protected var secret int32
    protected func Reveal() int32 {
        return secret
    }
}

func Main() {
    let b = Base{}
}`)
        try {
            let fieldAttrs = GetFieldAttributes(dll, "Base", "secret")
            Assert.Equal(FieldAttributes.Family, fieldAttrs & FieldAttributes.FieldAccessMask)
            let methodAttrs = GetMethodAttributes(dll, "Base", "Reveal")
            Assert.Equal(MethodAttributes.Family, methodAttrs & MethodAttributes.MemberAccessMask)
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    @Fact
    func ExternalCode_AccessesProtectedField_FailsToCompile() {
        let (exit, output) = TryCompile(`package Maui.Issue950.Tests

import System

open class Base {
    protected var secret int32
}

func Main() {
    let b = Base{}
    Console.WriteLine(b.secret)
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0379", output)
    }

    @Fact
    func ExternalCode_CallsProtectedMethod_FailsToCompile() {
        let (exit, output) = TryCompile(`package Maui.Issue950.Tests

import System

open class Base {
    protected func Reveal() int32 {
        return 1
    }
}

func Main() {
    let b = Base{}
    Console.WriteLine(b.Reveal())
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0379", output)
    }

    @Fact
    func ProtectedOnNonOpenClass_FailsToCompile() {
        let (exit, output) = TryCompile(`package Maui.Issue950.Tests

class Sealed {
    protected var secret int32
}

func Main() {
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0380", output)
    }

    /// Issue #4674: a `protected override` takes its accessibility from the
    /// base member, so it is legal on a non-`open` class. The class stays
    /// CLR-sealed (that is what a migrated C# `sealed class Lowerer :
    /// BoundTreeRewriter` needs), the override is emitted `family`, and
    /// the dispatch still reaches it.
    @Fact
    func ProtectedOverride_OnSealedClass_IsSealedFamilyAndDispatches() {
        let source = `package Maui.Issue4674.Tests

import System

open class Animal {
    protected open func Sound() string {
        return "..."
    }
    func Describe() string {
        return Sound()
    }
}

class Dog : Animal {
    protected override func Sound() string {
        return "Woof"
    }
}

func Main() {
    let a Animal = Dog{}
    Console.WriteLine(a.Describe())
}`
        CompileVerifyAndRun(source, "Woof\n")
        let dll = CompileToDll(source)
        try {
            Assert.Equal(TypeAttributes.Sealed, GetTypeAttributes(dll, "Dog") & TypeAttributes.Sealed)
            Assert.Equal(
                MethodAttributes.Family,
                GetMethodAttributes(dll, "Dog", "Sound") & MethodAttributes.MemberAccessMask
            )
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    /// Issue #4674: the exemption is for overrides only — a NEW protected member
    /// of a non-open class is still GS0380, and so is a protected override on a
    /// struct.
    @Fact
    func NewProtectedMember_OnSealedClassDerivingFromOpen_StillFailsToCompile() {
        let (exit, output) = TryCompile(`package Maui.Issue4674.Tests

open class Animal {
    protected open func Sound() string {
        return "..."
    }
}

class Dog : Animal {
    protected func Fetch() string {
        return "ball"
    }
}

func Main() {
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0380", output)
    }

    @Fact
    func ProtectedOnStruct_FailsToCompile() {
        let (exit, output) = TryCompile(`package Maui.Issue950.Tests

struct Val {
    protected var x int32
}

func Main() {
}`)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0380", output)
    }

    shared {
        private func GetTypeAttributes(dllPath string, typeName string) TypeAttributes {
            using let fs = File.OpenRead(dllPath)
            using let pe = PEReader(fs)
            let mr = pe.GetMetadataReader()
            for typeHandle in mr.TypeDefinitions {
                let type = mr.GetTypeDefinition(typeHandle)
                if mr.GetString(type.Name) == typeName {
                    return type.Attributes
                }
            }
            throw XunitException("type $typeName not found in $dllPath")
        }

        private func GetFieldAttributes(dllPath string, typeName string, fieldName string) FieldAttributes {
            using let fs = File.OpenRead(dllPath)
            using let pe = PEReader(fs)
            let mr = pe.GetMetadataReader()
            for typeHandle in mr.TypeDefinitions {
                let type = mr.GetTypeDefinition(typeHandle)
                if mr.GetString(type.Name) != typeName {
                    continue
                }
                for fieldHandle in type.GetFields() {
                    let field = mr.GetFieldDefinition(fieldHandle)
                    if mr.GetString(field.Name) == fieldName {
                        return field.Attributes
                    }
                }
            }
            throw XunitException("field $typeName.$fieldName not found in $dllPath")
        }

        private func GetMethodAttributes(dllPath string, typeName string, methodName string) MethodAttributes {
            using let fs = File.OpenRead(dllPath)
            using let pe = PEReader(fs)
            let mr = pe.GetMetadataReader()
            for typeHandle in mr.TypeDefinitions {
                let type = mr.GetTypeDefinition(typeHandle)
                if mr.GetString(type.Name) != typeName {
                    continue
                }
                for methodHandle in type.GetMethods() {
                    let method = mr.GetMethodDefinition(methodHandle)
                    if mr.GetString(method.Name) == methodName {
                        return method.Attributes
                    }
                }
            }
            throw XunitException("method $typeName.$methodName not found in $dllPath")
        }

        private func CompileVerifyAndRun(source string, expected string) {
            let dll = CompileToDll(source)
            try {
                IlVerifier.Verify(dll)
                let runtimeConfigPath = Path.ChangeExtension(dll, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
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
                Assert.Equal(expected, stdout.ReplaceLineEndings(Environment.NewLine))
            } finally {
                TryDeleteDir(Path.GetDirectoryName(dll))
            }
        }

        private func CompileToDll(source string) string {
            let (exit, output, outPath) = RunCompiler(source)
            try {
                Assert.True(exit == 0, "compile failed ($exit): $output")
            } catch {
                // The caller owns the temporary directory only once this returns.
                TryDeleteDir(Path.GetDirectoryName(outPath))
                rethrow
            }
            return outPath
        }

        private func TryCompile(source string)(Exit int32, Output string) {
            let (exit, output, outDir) = RunCompiler(source)
            TryDeleteDir(Path.GetDirectoryName(outDir))
            return (exit, output)
        }

        private func RunCompiler(source string)(Exit int32, Output string, OutPath string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue950_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100", srcPath}
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
            return (compileExit, compileOut.ToString() + compileErr.ToString(), outPath)
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
