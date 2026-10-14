// <copyright file="Issue909TopLevelPrivateAccessibilityEmitTests.cs" company="GSharp">
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

/// Issue #909 — a top-level `private func` lives on the synthetic
/// `<Program>` type. The binder permits sibling top-level types in
/// the same assembly to call it (its accessibility model treats top-level
/// `private` as assembly-visible), but emission used to map source
/// `private` to IL (cref:MethodAttributes.Private), which the CLR
/// enforces as private-to-the-declaring-type (`<Program>`). The
/// binder and the emitted IL therefore disagreed: clean compile, runtime
/// (cref:MethodAccessException).
///
/// The fix (ADR-0109, option 1) emits top-level `private` members of the
/// synthetic `<Program>` type as IL `assembly` (internal) so the
/// IL accessibility matches what the binder already permits. Both the direct
/// call `Helper()` and the method-group delegate `return Helper` must
/// execute without (cref:MethodAccessException).
///
/// This remapping is scoped to `<Program>` members ONLY — a
/// `private` method on a user-defined `class`/`struct` stays IL
/// `private`.
open class Issue909TopLevelPrivateAccessibilityEmitTests {
    @Fact
    func TopLevelPrivateFunc_DirectCallFromSiblingType_Runs() {
        CompileVerifyAndRun(`package Oahu.Cli.Tests

import System

private func Helper() string {
    return "hello"
}

class Greeter {
    func CallIt() string {
        return Helper()
    }
}

func Main() {
    let g = Greeter()
    Console.WriteLine(g.CallIt())
}`, "hello\n")
    }

    @Fact
    func TopLevelPrivateFunc_MethodGroupDelegateFromSiblingType_Runs() {
        CompileVerifyAndRun(`package Oahu.Cli.Tests

import System

private func Helper() string {
    return "hello"
}

class Greeter {
    func MakeDelegate() Func[string] {
        return Helper
    }
}

func Main() {
    let g = Greeter()
    let d = g.MakeDelegate()
    Console.WriteLine(d())
}`, "hello\n")
    }

    @Fact
    func TopLevelPrivateFunc_BothFormsTogether_Runs() {
        CompileVerifyAndRun(`package Oahu.Cli.Tests

import System

private func Helper() string {
    return "hello"
}

class Greeter {
    func CallIt() string {
        return Helper()
    }
    func MakeDelegate() Func[string] {
        return Helper
    }
}

func Main() {
    let g = Greeter()
    Console.WriteLine(g.CallIt())
    let d = g.MakeDelegate()
    Console.WriteLine(d())
}`, `hello
hello
`)
    }

    /// Guard: a top-level `private func` must be emitted IL
    /// `assembly` (internal), NOT IL `private`.
    @Fact
    func TopLevelPrivateFunc_IsEmittedAssemblyVisible() {
        let dll = CompileToDll(`package Oahu.Cli.Tests

import System

private func Helper() string {
    return "hello"
}

func Main() {
    Console.WriteLine(Helper())
}`)
        try {
            let attrs = GetMethodAttributes(dll, "<Program>", "Helper")
            Assert.Equal(MethodAttributes.Assembly, attrs & MethodAttributes.MemberAccessMask)
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    /// Guard: a `private` method on a USER class must remain IL
    /// `private` — the remapping is scoped to `<Program>` only
    /// and must NOT weaken real user-type `private`.
    @Fact
    func UserClassPrivateMethod_RemainsIlPrivate() {
        let dll = CompileToDll(`package Oahu.Cli.Tests

import System

class Greeter {
    private func Secret() string {
        return "secret"
    }
    func Reveal() string {
        return Secret()
    }
}

func Main() {
    let g = Greeter()
    Console.WriteLine(g.Reveal())
}`)
        try {
            let attrs = GetMethodAttributes(dll, "Greeter", "Secret")
            Assert.Equal(MethodAttributes.Private, attrs & MethodAttributes.MemberAccessMask)
        } finally {
            TryDeleteDir(Path.GetDirectoryName(dll))
        }
    }

    shared {
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue909_emit_").FullName
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
            Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
            return outPath
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
