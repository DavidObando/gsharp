// <copyright file="Issue1462ListEnumeratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1462 — a <c>for x in someList</c> over a concrete <c>List[T]</c> whose
/// element <c>T</c> is a <em>same-compilation</em> user type (interface, class,
/// or <c>data struct</c>) lowered through the symbolic open-generic enumerator
/// path (issue #774): the enumerator local is typed as the interface
/// <c>IEnumerator[T]</c>, and the <c>GetEnumerator()</c> MemberRef is meant to be
/// re-parented at the substituted <c>IEnumerable[T]</c> interface TypeSpec.
/// <para>
/// The re-parenting decision relied on a CLR <see cref="Type"/> reference-equality
/// comparison (<c>iface.GetGenericTypeDefinition() == targetOpenInterface</c>).
/// When the referenced framework is loaded through a
/// <see cref="System.Reflection.MetadataLoadContext"/> (the real
/// <c>/reference:</c>-driven compile, as opposed to the compiler's own runtime),
/// the receiver's <c>List&lt;&gt;</c> open definition and the lowerer's
/// <c>typeof(IEnumerable&lt;object&gt;)</c> live in different load contexts and are
/// never reference-equal, so the redirect silently fell through and emitted
/// <c>List&lt;T&gt;</c>'s struct-returning <c>GetEnumerator</c> typed as the
/// interface enumerator — unverifiable IL
/// (<c>StackUnexpected: found 'List`1+Enumerator&lt;T&gt;' expected ref
/// 'IEnumerator`1&lt;T&gt;'</c>). The fix compares those definitions by metadata
/// identity (<see cref="Type.FullName"/>).
/// </para>
/// <para>
/// IMPORTANT — this defect is whole-assembly / reference-context dependent. It
/// only manifests when the BCL is supplied via explicit <c>/reference:</c> paths
/// (forcing the <c>MetadataLoadContext</c>), <em>not</em> when gsc resolves
/// against its own running runtime. Therefore this test mirrors the corpus
/// harness by passing the shared-framework assemblies as <c>/reference:</c>
/// entries (the only deviation from the otherwise-verbatim
/// <c>Issue1441StringFromCharArrayEmitTests.CompileAndRun</c> helper). Without
/// those references the program verifies clean on <c>main</c>; with them it
/// reproduces the issue and is fixed by this change. Corpus-level ilverify of
/// the full <c>Oahu.Decrypt</c> assembly remains the primary regression gate.
/// </para>
/// </summary>
public class Issue1462ListEnumeratorEmitTests
{
    [Fact]
    public void NonGenericEnumeratorCurrent_IsConvertedToTheInferredElementType()
    {
        var source = """
            package Issue2752
            import System
            import System.Text.RegularExpressions

            var count = 0
            for match in Regex.Matches("<input><span><input>", "<input>") {
                if match.Success {
                    count = count + 1
                }
            }

            Console.WriteLine(count)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void EndToEnd_ForeachOverListOfSameCompilationTypes_VerifiesAndRuns()
    {
        // Exercises every body shape the corpus hit: a sync foreach over a
        // List of an interface element, a sync foreach over a List of a struct
        // element, an async-state-machine foreach, and an iterator (yield)
        // foreach — all over concrete `List[T]` members whose `T` is a
        // same-compilation user type.
        var source = """
            package Issue1462EmitProbe
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
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0,24,24,1,2\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1462_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // Deviation from the verbatim Issue1441 helper: pass the
            // shared-framework assemblies as explicit `/reference:` entries so
            // gsc loads the BCL through a MetadataLoadContext (as the corpus
            // harness does). This is what surfaces the issue #1462 defect; a
            // `/targetframework`-only compile resolves against the compiler's
            // own runtime and verifies clean even on `main`.
            var frameworkReferences = FrameworkReferencePaths();

            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            args.AddRange(frameworkReferences.Select(r => "/reference:" + r));
            args.Add(srcPath);

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IReadOnlyList<string> FrameworkReferencePaths()
    {
        var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();
    }
}
