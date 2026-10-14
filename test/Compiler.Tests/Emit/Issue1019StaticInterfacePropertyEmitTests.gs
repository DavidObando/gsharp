// <copyright file="Issue1019StaticInterfacePropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0089 / issue #1019 — static-virtual interface *properties*. Validates
/// the CLR emit shape end-to-end: the interface TypeDef carries a
/// `get_Name` accessor with `Static | Virtual | Abstract`, plus a
/// `Property` row; the implementer's static property accessor is paired
/// to the slot via a `MethodImpl` row; and a generic consumer reads the
/// property through the constraint via `constrained. !!T call`. Runtime
/// execution and IL verification (with the known static-virtual ilverify
/// suppression) are covered.
open class Issue1019StaticInterfacePropertyEmitTests {
    @Fact
    func StaticAbstractProperty_InterfaceMetadata_GetterIsStaticVirtualAbstract() {
        let source = `package Probe
import System

sealed interface IData {
    shared {
        prop SizeInBytes int32 { get; }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var getterHandle MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "IData") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "get_SizeInBytes") {
                        getterHandle = mh
                    }
                }
                Assert.NotEmpty(td.GetProperties())
            }
            Assert.True((getterHandle != nil), "expected to find get_SizeInBytes on IData")
            let getter = reader.GetMethodDefinition(getterHandle!!)
            let attrs = getter.Attributes
            Assert.True((attrs & MethodAttributes.Static) != 0, "static-virtual property getter must be static")
            Assert.True((attrs & MethodAttributes.Virtual) != 0, "static-virtual property getter must be virtual")
            Assert.True((attrs & MethodAttributes.Abstract) != 0, "abstract slot must carry Abstract flag")
            Assert.True((attrs & MethodAttributes.SpecialName) != 0, "accessor must be SpecialName")
            Assert.Equal(0, getter.RelativeVirtualAddress)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func StaticAbstractProperty_Implementer_HasMethodImplForGetter() {
        let source = `package Probe
import System

sealed interface IData {
    shared {
        prop SizeInBytes int32 { get; }
    }
}

struct AppleData : IData {
    shared {
        prop SizeInBytes int32 { get { return 8 } }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var sawMethodImpl = false
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "AppleData") {
                    continue
                }
                for mih in td.GetMethodImplementations() {
                    let mi = reader.GetMethodImplementation(mih)
                    let DeclName = func (h EntityHandle) string {
                        if h.Kind == HandleKind.MethodDefinition {
                            return reader.GetString(reader.GetMethodDefinition(MethodDefinitionHandle(h)).Name)
                        }
                        if h.Kind == HandleKind.MemberReference {
                            return reader.GetString(reader.GetMemberReference(MemberReferenceHandle(h)).Name)
                        }
                        return string.Empty
                    }
                    if DeclName(mi.MethodDeclaration) == "get_SizeInBytes" &&
                        DeclName(mi.MethodBody) == "get_SizeInBytes" {
                        sawMethodImpl = true
                    }
                }
            }
            Assert.True(
                sawMethodImpl,
                "expected a MethodImpl pairing AppleData.get_SizeInBytes to IData.get_SizeInBytes"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func EndToEnd_GenericReadThroughConstraint_RunsAndReturnsExpected() {
        // The headline ADR-0089/#1019 path: an interface declares an abstract
        // static property; a struct implements it; a generic consumer reads
        // the property through the constraint via `constrained. !!T  call`.
        let source = `package Probe
import System

sealed interface IData {
    shared {
        prop Name string { get; }
    }
}

struct AppleData : IData {
    shared {
        prop Name string { get { return "apple" } }
    }
}

func Describe[T IData](witness T) string {
    return T.Name
}

func Main() {
    Console.WriteLine(Describe(AppleData{}))
}`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.Describe$$")
        Assert.Equal("apple${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_GetSetProperty_BothAccessorsAbstractStaticVirtual() {
        let source = `package Probe
import System

sealed interface IData {
    shared {
        prop Tag int32 { get; set }
    }
}

struct Box : IData {
    shared {
        var Stored int32
        prop Tag int32 { get { return Box.Stored } set { Box.Stored = value } }
    }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var foundGetter = false
            var foundSetter = false
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "IData") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    let name = reader.GetString(md.Name)
                    let attrs = md.Attributes
                    let isStaticVirtualAbstract = (attrs & MethodAttributes.Static) != 0 &&
                        (attrs & MethodAttributes.Virtual) != 0 &&
                        (attrs & MethodAttributes.Abstract) != 0
                    if name == "get_Tag" {
                        foundGetter = isStaticVirtualAbstract
                    }
                    if name == "set_Tag" {
                        foundSetter = isStaticVirtualAbstract
                    }
                }
            }
            Assert.True(foundGetter, "get_Tag must be Static|Virtual|Abstract")
            Assert.True(foundSetter, "set_Tag must be Static|Virtual|Abstract")
        } finally {
            TryCleanup(dllPath)
        }
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_sviprop_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string, ignoredErrorScope string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_sviprop_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                IlVerifier.Verify(
                    dllPath,
                    ignoredErrorCodes: if ignoredErrorScope == nil {
                        default([]?string)
                    } else {
                        IlVerifier.KnownIssues.StaticVirtualInterface
                    },
                    ignoredErrorScope: ignoredErrorScope
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
                } catch { }
            }
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
