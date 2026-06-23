// <copyright file="Issue985DualGetEnumeratorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #985: a generic G# collection that implements <c>IEnumerable[T]</c>
/// must be able to declare BOTH the generic <c>func GetEnumerator()
/// IEnumerator[T]</c> and the non-generic bridge <c>func GetEnumerator()
/// IEnumerator</c> (which satisfies the inherited
/// <c>System.Collections.IEnumerable.GetEnumerator</c> slot). G# has no
/// explicit-interface-implementation syntax, so the two methods collide on a
/// name + parameter list that differs only by return type. The binder used to
/// reject this with <c>GS0264</c> ("overloads must differ by parameter types"),
/// and with only the generic method present the inherited non-generic slot
/// stayed unimplemented (<c>GS0187</c>).
/// <para>
/// The covariant-return interface bridge fix (Approach A) relaxes
/// <c>GS0264</c> only when the two same-name/same-parameter methods satisfy two
/// DISTINCT interface slots, requires the inherited base-interface slot to be
/// implemented (so a missing bridge still errors <c>GS0187</c>), and emits an
/// explicit <c>MethodImpl</c> row plus an <c>InterfaceImpl</c> row for the
/// inherited <c>System.Collections.IEnumerable</c> so the produced metadata
/// matches the C# shape and ilverifies clean.
/// </para>
/// </summary>
public class Issue985DualGetEnumeratorEmitTests
{
    private const string ReproSource = """
        package GapCheck
        import System
        import System.Collections
        import System.Collections.Generic

        class Repo[T] : IEnumerable[T] {
            private let _items List[T] = List[T]()
            func Add(value T) { _items.Add(value) }
            func GetEnumerator() IEnumerator[T] { return _items.GetEnumerator() }
            private func GetEnumerator() IEnumerator { return GetEnumerator() }
        }
        """;

    [Fact]
    public void DualGetEnumerator_Compiles_EmitsBothInterfaceImplsAndMethodImpl_IlVerifies()
    {
        var dllPath = CompileLibrary(ReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition repo = default;
            bool foundRepo = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (reader.GetString(td.Name).StartsWith("Repo", StringComparison.Ordinal))
                {
                    repo = td;
                    foundRepo = true;
                    break;
                }
            }

            Assert.True(foundRepo, "expected to find the Repo`1 type");

            // (1) BOTH interface-impl rows must be present: the generic
            // IEnumerable<T> (a TypeSpec) and the inherited non-generic
            // System.Collections.IEnumerable.
            bool sawGenericEnumerable = false;
            bool sawNonGenericEnumerable = false;
            foreach (var iiHandle in repo.GetInterfaceImplementations())
            {
                var ii = reader.GetInterfaceImplementation(iiHandle);
                switch (ii.Interface.Kind)
                {
                    case HandleKind.TypeSpecification:
                        sawGenericEnumerable = true;
                        break;
                    case HandleKind.TypeReference:
                        var tr = reader.GetTypeReference((TypeReferenceHandle)ii.Interface);
                        if (reader.GetString(tr.Name) == "IEnumerable" &&
                            reader.GetString(tr.Namespace) == "System.Collections")
                        {
                            sawNonGenericEnumerable = true;
                        }

                        break;
                }
            }

            Assert.True(sawGenericEnumerable, "expected an InterfaceImpl row for the generic IEnumerable<T> (TypeSpec)");
            Assert.True(sawNonGenericEnumerable, "expected an InterfaceImpl row for the inherited System.Collections.IEnumerable");

            // (2) Two GetEnumerator methods: a public generic one and a
            // private non-generic bridge.
            int publicGetEnumerator = 0;
            int privateGetEnumerator = 0;
            foreach (var mh in repo.GetMethods())
            {
                var md = reader.GetMethodDefinition(mh);
                if (reader.GetString(md.Name) != "GetEnumerator")
                {
                    continue;
                }

                if ((md.Attributes & System.Reflection.MethodAttributes.MemberAccessMask) == System.Reflection.MethodAttributes.Public)
                {
                    publicGetEnumerator++;
                }
                else if ((md.Attributes & System.Reflection.MethodAttributes.MemberAccessMask) == System.Reflection.MethodAttributes.Private)
                {
                    privateGetEnumerator++;
                }
            }

            Assert.Equal(1, publicGetEnumerator);
            Assert.Equal(1, privateGetEnumerator);

            // (3) A MethodImpl row whose declaration is
            // System.Collections.IEnumerable.GetEnumerator.
            bool sawBridgeMethodImpl = false;
            foreach (var miHandle in repo.GetMethodImplementations())
            {
                var mi = reader.GetMethodImplementation(miHandle);
                if (mi.MethodDeclaration.Kind != HandleKind.MemberReference)
                {
                    continue;
                }

                var mref = reader.GetMemberReference((MemberReferenceHandle)mi.MethodDeclaration);
                if (reader.GetString(mref.Name) != "GetEnumerator")
                {
                    continue;
                }

                if (mref.Parent.Kind == HandleKind.TypeReference)
                {
                    var declTr = reader.GetTypeReference((TypeReferenceHandle)mref.Parent);
                    if (reader.GetString(declTr.Name) == "IEnumerable" &&
                        reader.GetString(declTr.Namespace) == "System.Collections")
                    {
                        sawBridgeMethodImpl = true;
                    }
                }
            }

            Assert.True(
                sawBridgeMethodImpl,
                "expected a MethodImpl row binding the non-generic bridge to System.Collections.IEnumerable.GetEnumerator");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void DualGetEnumerator_RunsThroughBothGenericAndNonGenericEnumerator()
    {
        // End-to-end: enumerate the same collection through the generic
        // GetEnumerator() AND through the non-generic IEnumerable bridge,
        // proving the emitted MethodImpl dispatches to the user method.
        var source = """
            package GapCheck
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
            }
            """;

        Assert.Equal("1\n2\n3\n1\n2\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericGetEnumeratorOnly_MissingNonGenericBridge_StillRejectedGS0187()
    {
        // Negative guard: when only the generic GetEnumerator is supplied, the
        // inherited non-generic System.Collections.IEnumerable.GetEnumerator
        // slot is unimplemented and must still error GS0187.
        var source = """
            package GapCheck
            import System.Collections
            import System.Collections.Generic

            class Repo[T] : IEnumerable[T] {
                private let _items List[T] = List[T]()
                func GetEnumerator() IEnumerator[T] { return _items.GetEnumerator() }
            }
            """;

        var diagnostics = CompileExpectingErrors(source);
        Assert.Contains(diagnostics, d => d.Contains("GS0187"));
    }

    [Fact]
    public void Control_CanonicalSequenceEnumeration_StillCompiles()
    {
        // Control: the canonical G# enumeration form (a `sequence[int32]`
        // iterator) must keep compiling unaffected by the bridge fix.
        var source = """
            package GapCheck
            func numbers() sequence[int32] {
                yield 1
                yield 2
            }
            """;

        var dllPath = CompileLibrary(source);
        TryCleanup(dllPath);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue985_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue985_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
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

    private static System.Collections.Generic.List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue985_neg_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit != 0,
                $"expected gsc to report errors but it succeeded\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            var combined = stdoutWriter.ToString() + stderrWriter.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
