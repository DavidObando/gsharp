// <copyright file="Issue2010ExplicitInterfaceImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2010 (follow-up to #1911 / PR #1994): a C# explicit interface
/// implementation (`string IFoo.Bar() { ... }`) has no G# spelling
/// (ADR-0091 rejected an `IFoo.M(this)` surface syntax; ADR-0149 later
/// introduced the dedicated `func (IFoo) M(...)` qualifier clause this
/// test now exercises). The #1911 fix collapsed two same-name/same-signature
/// explicit implementations of DIFFERENT interfaces onto a single surviving
/// method body (dropping the other, reported via an `Unsupported`
/// diagnostic).
///
/// This fix instead lets each explicit implementation keep its own distinct
/// body as a separate G# method declared with the
/// `func (InterfaceType) Member(...)` qualifier clause (ADR-0149). The
/// binder links each such method to the specific interface member it
/// implements ((cref:GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol.ExplicitInterfaceMember))
/// and the emitter binds an explicit CLR `MethodImpl` row (mirroring the
/// ADR-0089 static-virtual / issue #985 bridge machinery) so each interface's
/// dispatch slot routes to its own method body — full fidelity, zero drops.
/// The declared member name stays the plain `Bar` for both — only the
/// synthesized CLR metadata name (`IFoo.Bar` / `IBaz.Bar`) differs,
/// keeping the two MethodDef rows collision-free.
open class Issue2010ExplicitInterfaceImplEmitTests {
    @Fact
    func CollidingExplicitImpls_Compile_EmitDistinctMethodsAndMethodImplRows_IlVerifies() {
        let dllPath = CompileLibrary(ReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var both = default(TypeDefinition)
            var foundBoth = false
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(td.Name) == "Both" {
                    both = td
                    foundBoth = true
                    break
                }
            }
            Assert.True(foundBoth, "expected to find the Both type")
            // (1) Two distinct MethodDef rows survive — no drop. ADR-0149:
            // the CLR metadata name is synthesized as
            // "<Package>.<Interface>.<Member>" ("GapCheck.IFoo.Bar" /
            // "GapCheck.IBaz.Bar") for uniqueness, even though the declared
            // source name ("Bar") is identical for both.
            var fooBody = 0
            var bazBody = 0
            for mh in both.GetMethods() {
                let md = reader.GetMethodDefinition(mh)
                let name = reader.GetString(md.Name)
                if name == "GapCheck.IFoo.Bar" {
                    fooBody++
                } else if name == "GapCheck.IBaz.Bar" {
                    bazBody++
                }
            }
            Assert.Equal(1, fooBody)
            Assert.Equal(1, bazBody)
            // (2) Two MethodImpl rows binding each method to its own
            // interface's Bar() slot.
            var methodImplRows = 0
            for miHandle in both.GetMethodImplementations() {
                reader.GetMethodImplementation(miHandle)
                methodImplRows++
            }
            Assert.Equal(2, methodImplRows)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func CollidingExplicitImpls_DispatchToDistinctBodiesThroughEachInterface() {
        // End-to-end: each interface-typed reference reaches its OWN body,
        // proving no collapse/drop of either explicit implementation.
        let source = ReproSource + `

var obj = Both{}
var asFoo IFoo = obj
var asBaz IBaz = obj
Console.WriteLine(asFoo.Bar())
Console.WriteLine(asBaz.Bar())`
        Assert.Equal("foo${Environment.NewLine}baz${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private const ReproSource string = `package GapCheck

interface IFoo {
    func Bar() string;
}

interface IBaz {
    func Bar() string;
}

class Both : IFoo, IBaz {
    func (IFoo) Bar() string {
        return "foo"
    }

    func (IBaz) Bar() string {
        return "baz"
    }
}`

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2010_lib_").FullName
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

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2010_exe_").FullName
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
                IlVerifier.Verify(dllPath)
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
