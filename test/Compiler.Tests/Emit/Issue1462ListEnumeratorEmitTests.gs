// <copyright file="Issue1462ListEnumeratorEmitTests.cs" company="GSharp">
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
import System.Runtime.InteropServices
import Xunit

/// Issue #1462 — a `for x in someList` over a concrete `List[T]` whose
/// element `T` is a <em>same-compilation</em> user type (interface, class,
/// or `data struct`) lowered through the symbolic open-generic enumerator
/// path (issue #774): the enumerator local is typed as the interface
/// `IEnumerator[T]`, and the `GetEnumerator()` MemberRef is meant to be
/// re-parented at the substituted `IEnumerable[T]` interface TypeSpec.
///
/// The re-parenting decision relied on a CLR (cref:Type) reference-equality
/// comparison (`iface.GetGenericTypeDefinition() == targetOpenInterface`).
/// When the referenced framework is loaded through a
/// (cref:System.Reflection.MetadataLoadContext) (the real
/// `/reference:`-driven compile, as opposed to the compiler's own runtime),
/// the receiver's `List<>` open definition and the lowerer's
/// `typeof(IEnumerable<object>)` live in different load contexts and are
/// never reference-equal, so the redirect silently fell through and emitted
/// `List<T>`'s struct-returning `GetEnumerator` typed as the
/// interface enumerator — unverifiable IL
/// (`StackUnexpected: found 'List`1+Enumerator<T>' expected ref
/// 'IEnumerator`1<T>'`). The fix compares those definitions by metadata
/// identity ((cref:Type.FullName)).
///
/// IMPORTANT — this defect is whole-assembly / reference-context dependent. It
/// only manifests when the BCL is supplied via explicit `/reference:` paths
/// (forcing the `MetadataLoadContext`), <em>not</em> when gsc resolves
/// against its own running runtime. Therefore this test mirrors the corpus
/// harness by passing the shared-framework assemblies as `/reference:`
/// entries (the only deviation from the otherwise-verbatim
/// `Issue1441StringFromCharArrayEmitTests.CompileAndRun` helper). Without
/// those references the program verifies clean on `main`; with them it
/// reproduces the issue and is fixed by this change. Corpus-level ilverify of
/// the full `Oahu.Decrypt` assembly remains the primary regression gate.
open class Issue1462ListEnumeratorEmitTests {
    @Fact
    func NonGenericEnumeratorCurrent_IsConvertedToTheInferredElementType() {
        let source = `package Issue2752
import System
import System.Text.RegularExpressions

var count = 0
for match in Regex.Matches("<input><span><input>", "<input>") {
    if match.Success {
        count = count + 1
    }
}

Console.WriteLine(count)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ForeachOverListOfSameCompilationTypes_VerifiesAndRuns() {
        // Exercises every body shape the corpus hit: a sync foreach over a
        // List of an interface element, a sync foreach over a List of a struct
        // element, an async-state-machine foreach, and an iterator (yield)
        // foreach — all over concrete `List[T]` members whose `T` is a
        // same-compilation user type.
        let source = `package Issue1462EmitProbe
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks

interface INode : IDisposable {
    prop Children List[INode] {
        get;
    }

    prop Weight int32 {
        get;
    }
}

data struct Sample(Value uint32)

open class Node : INode {
    init() {
        Children = List[INode]()
        Samples = List[Sample]()
    }

    prop Children List[INode] {
        get;
        init;
    }

    prop Samples List[Sample] {
        get;
        init;
    }

    open prop Weight int32 -> int32(1) + Children.Sum((c INode) -> c.Weight)

    func CountHeavyChildren() int32 {
        var n = 0
        for child in Children {
            if child.Weight > 1 {
                n = n + 1
            }
        }
        return n
    }

    func SumSamples() uint32 {
        var total uint32 = 0
        for s in Samples {
            total = total + s.Value
        }
        return total
    }

    async func SumWeightsAsync() int32 {
        var total = 0
        for child in Children {
            total = total + child.Weight
        }
        await Task.Yield()
        return total
    }

    func EnumerateValues() sequence[uint32] {
        for s in Samples {
            yield s.Value
        }
    }

    open func Dispose() {
        for child in Children {
            child.Dispose()
        }
    }
}

func Main() {
    let root = Node()
    let leaf = Node()
    leaf.Samples.Add(Sample(7))
    root.Children.Add(leaf)
    root.Samples.Add(Sample(11))
    root.Samples.Add(Sample(13))
    var acc uint32 = 0
    for v in root.EnumerateValues() {
        acc = acc + v
    }
    let asyncTotal = root.SumWeightsAsync().Result
    Console.WriteLine("${root.CountHeavyChildren()},${root.SumSamples()},${acc},${asyncTotal},${root.Weight}")
}`
        let output = CompileAndRun(source)
        Assert.Equal("0,24,24,1,2${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1462_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // Deviation from the verbatim Issue1441 helper: pass the
                // shared-framework assemblies as explicit `/reference:` entries so
                // gsc loads the BCL through a MetadataLoadContext (as the corpus
                // harness does). This is what surfaces the issue #1462 defect; a
                // `/targetframework`-only compile resolves against the compiler's
                // own runtime and verifies clean even on `main`.
                let frameworkReferences = FrameworkReferencePaths()
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                args.AddRange(frameworkReferences.Select((r string) -> ("/reference:" + r)))
                args.Add(srcPath)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
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

        private func FrameworkReferencePaths() IReadOnlyList[string] {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                return Array.Empty[string]()
            }
            return Directory
                .EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
                .OrderBy((p string) -> p, StringComparer.Ordinal)
                .ToList()
        }
    }
}
