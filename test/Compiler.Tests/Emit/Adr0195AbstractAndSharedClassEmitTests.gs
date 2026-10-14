// <copyright file="Adr0195AbstractAndSharedClassEmitTests.cs" company="GSharp">
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

/// ADR-0195 / issue #4674 — the CLR shape of the `abstract` and
/// `shared` class modifiers, read back from the emitted metadata, plus an
/// ILVerify + run of the program. The migrated GSharp.Core API depends on
/// these flags being exactly what the C# compiler emits for an abstract class
/// and for a static class.
open class Adr0195AbstractAndSharedClassEmitTests {
    @Fact
    func AbstractClass_IsAbstractNotSealed_WithFamilyConstructor() {
        let dll = CompileToDll(Source, out var tempDir)
        try {
            for name in[]string{"Walker", "Both", "Shape"} {
                let attributes = GetTypeAttributes(dll, name)
                Assert.Equal(TypeAttributes.Abstract, attributes & TypeAttributes.Abstract)
                Assert.Equal(default(TypeAttributes), attributes & TypeAttributes.Sealed)
                Assert.Equal(
                    MethodAttributes.Family,
                    GetMethodAttributes(dll, name, ".ctor") & MethodAttributes.MemberAccessMask
                )
            }
            // The implicit constructor that chains to a base initializer is family too (a
            // primary constructor stays public).
            Assert.Equal(
                MethodAttributes.Family,
                GetMethodAttributes(dll, "Forwarding", ".ctor") & MethodAttributes.MemberAccessMask
            )
            // A declared primary constructor, even an empty one, keeps its public constructor:
            // the family constructor is for an implicit one only.
            for name in[]string{"EmptyPrimary", "ForwardingPrimary"} {
                Assert.Equal(
                    MethodAttributes.Public,
                    GetMethodAttributes(dll, name, ".ctor") & MethodAttributes.MemberAccessMask
                )
            }
            // A concrete subclass is neither.
            let counting = GetTypeAttributes(dll, "Counting")
            Assert.Equal(default(TypeAttributes), counting & TypeAttributes.Abstract)
            Assert.Equal(default(TypeAttributes), counting & TypeAttributes.Sealed)
            for name in[]string{"Inferred", "InferredForwarding"} {
                let attributes = GetTypeAttributes(dll, name)
                Assert.Equal(TypeAttributes.Abstract, attributes & TypeAttributes.Abstract)
                Assert.Equal(default(TypeAttributes), attributes & TypeAttributes.Sealed)
                Assert.Equal(
                    MethodAttributes.Public,
                    GetMethodAttributes(dll, name, ".ctor") & MethodAttributes.MemberAccessMask
                )
            }
        } finally {
            Directory.Delete(tempDir!!, recursive: true)
        }
    }

    @Fact
    func SharedClass_IsAbstractAndSealed_WithNoReachableConstructor() {
        let dll = CompileToDll(Source, out var tempDir)
        try {
            let attributes = GetTypeAttributes(dll, "Helpers")
            Assert.Equal(
                TypeAttributes.Abstract | TypeAttributes.Sealed,
                attributes & (TypeAttributes.Abstract | TypeAttributes.Sealed)
            )
            Assert.Equal(
                MethodAttributes.Private,
                GetMethodAttributes(dll, "Helpers", ".ctor") & MethodAttributes.MemberAccessMask
            )
            Assert.Equal(
                MethodAttributes.Public | MethodAttributes.Static,
                GetMethodAttributes(dll, "Helpers", "Triple") & (
                    MethodAttributes.MemberAccessMask | MethodAttributes.Static
                )
            )
        } finally {
            Directory.Delete(tempDir!!, recursive: true)
        }
    }

    @Fact
    func AbstractAndSharedClasses_VerifyAndRun() {
        let dll = CompileToDll(Source, out var tempDir)
        try {
            IlVerifier.Verify(dll)
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
            using let proc = Process.Start(psi) ?? throw InvalidOperationException("dotnet exec did not start")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            proc.WaitForExit()
            Assert.True(proc.ExitCode == 0, "exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
            Assert.Equal(`3
15
8
6
1
`, stdout.ReplaceLineEndings("\n"))
        } finally {
            Directory.Delete(tempDir!!, recursive: true)
        }
    }

    @Fact
    func CompileToDll_FailurePropagatesAndDeletesItsWorkspace() {
        var tempDir string? = nil
        try {
            let error = Assert.ThrowsAny[XunitException](
                func () object? {
                    return CompileToDll("func Main() { Missing() }", out tempDir)
                }
            )
            Assert.Contains("compile failed", error.Message)
            Assert.Contains("Missing", error.Message)
            Assert.NotNull(tempDir)
            Assert.False(Directory.Exists(tempDir), "failed compilation left its workspace: " + tempDir)
        } finally {
            if tempDir != nil && Directory.Exists(tempDir) {
                Directory.Delete(tempDir, recursive: true)
            }
        }
    }

    shared {
        private const Source string = `package Maui.Adr0195.Tests

import System

abstract class Walker {
    var visited int32
    func Visit() int32 {
        visited = visited + 1
        return visited
    }
}

open class Counting : Walker {
    func Twice() int32 {
        return Visit() + Visit()
    }
}

open abstract class Both {
}

open class Seed(N int32) {
}

open class Inferred {
    open func Visit() int32;
}

open class InferredChild : Inferred {
    override func Visit() int32 { return 1 }
}

open class InferredForwarding(N int32) : Seed(N) {
    open func Visit() int32;
}

open class InferredForwardingChild() : InferredForwarding(1) {
    override func Visit() int32 { return N }
}

abstract class Forwarding : Seed(1) {
}

open class Leaf : Forwarding {
}

abstract class EmptyPrimary() {
}

abstract class ForwardingPrimary() : Seed(2) {
}

abstract data class Shape(Sides int32) {
}

data class Square(Side int32) : Shape(4) {
}

shared class Helpers {
    const Factor int32 = 3
    var calls int32
    func Triple(x int32) int32 {
        calls = calls + 1
        return x * Factor
    }
}

func Main() {
    let c = Counting{}
    Console.WriteLine(c.Twice())
    Console.WriteLine(Helpers.Triple(5))
    Console.WriteLine(Helpers.Triple(2) + Helpers.calls)
    Console.WriteLine(Square(2).Sides + Square(2).Side)
    if InferredChild().Visit() != 1 || InferredForwardingChild().Visit() != 1 {
        throw Exception("inferred constructor control failed")
    }
    Console.WriteLine(Leaf().N)
}`

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

        private func CompileToDll(source string, out tempDir string?) string {
            tempDir = Directory.CreateTempSubdirectory("gs_adr0195_emit_").FullName
            var succeeded = false
            try {
                let srcPath = Path.Combine(tempDir!!, "test.gs")
                let outPath = Path.Combine(tempDir!!, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                succeeded = true
                return outPath
            } finally {
                if !succeeded {
                    Directory.Delete(tempDir!!, recursive: true)
                }
            }
        }
    }
}
