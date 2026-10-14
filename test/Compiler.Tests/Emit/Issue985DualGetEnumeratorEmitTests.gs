// <copyright file="Issue985DualGetEnumeratorEmitTests.cs" company="GSharp">
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

/// Issue #985: a generic G# collection that implements `IEnumerable[T]`
/// must be able to declare BOTH the generic `func GetEnumerator()
/// IEnumerator[T]` and the non-generic bridge `func GetEnumerator()
/// IEnumerator` (which satisfies the inherited
/// `System.Collections.IEnumerable.GetEnumerator` slot). G# has no
/// explicit-interface-implementation syntax, so the two methods collide on a
/// name + parameter list that differs only by return type. The binder used to
/// reject this with `GS0264` ("overloads must differ by parameter types"),
/// and with only the generic method present the inherited non-generic slot
/// stayed unimplemented (`GS0187`).
///
/// The covariant-return interface bridge fix (Approach A) relaxes
/// `GS0264` only when the two same-name/same-parameter methods satisfy two
/// DISTINCT interface slots, requires the inherited base-interface slot to be
/// implemented (so a missing bridge still errors `GS0187`), and emits an
/// explicit `MethodImpl` row plus an `InterfaceImpl` row for the
/// inherited `System.Collections.IEnumerable` so the produced metadata
/// matches the C# shape and ilverifies clean.
open class Issue985DualGetEnumeratorEmitTests {
    @Fact
    func DualGetEnumerator_Compiles_EmitsBothInterfaceImplsAndMethodImpl_IlVerifies() {
        let dllPath = CompileLibrary(ReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var repo = default(TypeDefinition)
            var foundRepo = false
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(td.Name).StartsWith("Repo", StringComparison.Ordinal) {
                    repo = td
                    foundRepo = true
                    break
                }
            }
            Assert.True(foundRepo, "expected to find the Repo`1 type")
            // (1) BOTH interface-impl rows must be present: the generic
            // IEnumerable<T> (a TypeSpec) and the inherited non-generic
            // System.Collections.IEnumerable.
            var sawGenericEnumerable = false
            var sawNonGenericEnumerable = false
            for iiHandle in repo.GetInterfaceImplementations() {
                let ii = reader.GetInterfaceImplementation(iiHandle)
                switch ii.Interface.Kind {
                    case HandleKind.TypeSpecification {
                        sawGenericEnumerable = true
                    }
                    case HandleKind.TypeReference {
                        let tr = reader.GetTypeReference(TypeReferenceHandle(ii.Interface))
                        if reader.GetString(tr.Name) == "IEnumerable" && reader.GetString(
                            tr.Namespace
                        ) == "System.Collections" {
                            sawNonGenericEnumerable = true
                        }
                    }
                    default {
                        let _ = 0
                    }
                }
            }
            Assert.True(sawGenericEnumerable, "expected an InterfaceImpl row for the generic IEnumerable<T> (TypeSpec)")
            Assert.True(
                sawNonGenericEnumerable,
                "expected an InterfaceImpl row for the inherited System.Collections.IEnumerable"
            )
            // (2) Two GetEnumerator methods: a public generic one and a
            // private non-generic bridge.
            var publicGetEnumerator = 0
            var privateGetEnumerator = 0
            for mh in repo.GetMethods() {
                let md = reader.GetMethodDefinition(mh)
                if reader.GetString(md.Name) != "GetEnumerator" {
                    continue
                }
                if (md.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public {
                    publicGetEnumerator++
                } else if (md.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Private {
                    privateGetEnumerator++
                }
            }
            Assert.Equal(1, publicGetEnumerator)
            Assert.Equal(1, privateGetEnumerator)
            // (3) A MethodImpl row whose declaration is
            // System.Collections.IEnumerable.GetEnumerator.
            var sawBridgeMethodImpl = false
            for miHandle in repo.GetMethodImplementations() {
                let mi = reader.GetMethodImplementation(miHandle)
                if mi.MethodDeclaration.Kind != HandleKind.MemberReference {
                    continue
                }
                let mref = reader.GetMemberReference(MemberReferenceHandle(mi.MethodDeclaration))
                if reader.GetString(mref.Name) != "GetEnumerator" {
                    continue
                }
                if mref.Parent.Kind == HandleKind.TypeReference {
                    let declTr = reader.GetTypeReference(TypeReferenceHandle(mref.Parent))
                    if reader.GetString(declTr.Name) == "IEnumerable" && reader.GetString(
                        declTr.Namespace
                    ) == "System.Collections" {
                        sawBridgeMethodImpl = true
                    }
                }
            }
            Assert.True(
                sawBridgeMethodImpl,
                "expected a MethodImpl row binding the non-generic bridge to System.Collections.IEnumerable.GetEnumerator"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func DualGetEnumerator_RunsThroughBothGenericAndNonGenericEnumerator() {
        // End-to-end: enumerate the same collection through the generic
        // GetEnumerator() AND through the non-generic IEnumerable bridge,
        // proving the emitted MethodImpl dispatches to the user method.
        let source = `package GapCheck
import System
import System.Collections
import System.Collections.Generic

class Repo[T] : IEnumerable[T] {
    private let _items List[T] = List[T]()
    func Add(value T) { _items.Add(value) }
    func GetEnumerator() IEnumerator[T] { return _items.GetEnumerator() }
    private func GetEnumerator() IEnumerator { return GetEnumerator() }
}

var r = Repo[int32]()
r.Add(1)
r.Add(2)
r.Add(3)
var e IEnumerator[int32] = r.GetEnumerator()
while e.MoveNext() {
    Console.WriteLine(e.Current)
}
var seq IEnumerable = r
var e2 IEnumerator = seq.GetEnumerator()
while e2.MoveNext() {
    Console.WriteLine(e2.Current)
}`
        Assert.Equal(
            "1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func GenericGetEnumeratorOnly_MissingNonGenericBridge_StillRejectedGS0187() {
        // Negative guard: when only the generic GetEnumerator is supplied, the
        // inherited non-generic System.Collections.IEnumerable.GetEnumerator
        // slot is unimplemented and must still error GS0187.
        let source = `package GapCheck
import System.Collections
import System.Collections.Generic

class Repo[T] : IEnumerable[T] {
    private let _items List[T] = List[T]()
    func GetEnumerator() IEnumerator[T] { return _items.GetEnumerator() }
}`
        let diagnostics = CompileExpectingErrors(source)
        Assert.Contains(diagnostics, (d string) -> d.Contains("GS0187"))
    }

    @Fact
    func Control_CanonicalSequenceEnumeration_StillCompiles() {
        // Control: the canonical G# enumeration form (a `sequence[int32]`
        // iterator) must keep compiling unaffected by the bridge fix.
        let source = `package GapCheck
func numbers() sequence[int32] {
    yield 1
    yield 2
}`
        let dllPath = CompileLibrary(source)
        TryCleanup(dllPath)
    }

    shared {
        private const ReproSource string = `package GapCheck
import System
import System.Collections
import System.Collections.Generic

class Repo[T] : IEnumerable[T] {
    private let _items List[T] = List[T]()
    func Add(value T) { _items.Add(value) }
    func GetEnumerator() IEnumerator[T] { return _items.GetEnumerator() }
    private func GetEnumerator() IEnumerator { return GetEnumerator() }
}`

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue985_lib_").FullName
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue985_exe_").FullName
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

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue985_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, (`expected gsc to report errors but it succeeded
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                let combined = stdoutWriter.ToString() + stderrWriter.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
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
