// <copyright file="ForRangeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Phase 4 emit-parity tests for `for k, v := range coll` across the three
/// iteration shapes the binder produces: Indexed (arrays), Dictionary
/// (Dictionary[K,V]), and Enumerable (List[T] and other IEnumerable[T]).
/// All three are lowered by <c>Lowerer.LowerCollectionRange</c> /
/// <c>LowerIndexedRange</c> and rely on the CLR-interop emit paths added in
/// commit A plus value-type-receiver handling for struct enumerators.
/// </summary>
public class ForRangeEmitTests
{
    [Fact]
    public void IndexedRange_OverFixedArray()
    {
        var source = """
            package P
            import System

            var arr = [3]int32{100, 200, 300}
            for i, v := range arr {
              Console.WriteLine(i)
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n100\n1\n200\n2\n300\n", output);
    }

    [Fact]
    public void EnumerableRange_OverList_ValueOnly()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var xs = List[int32]()
            xs.Add(10)
            xs.Add(20)
            xs.Add(30)
            for v := range xs {
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n20\n30\n", output);
    }

    [Fact]
    public void EnumerableRange_OverList_WithIndex()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var xs = List[int32]()
            xs.Add(10)
            xs.Add(20)
            for i, v := range xs {
              Console.WriteLine(i)
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("0\n10\n1\n20\n", output);
    }

    [Fact]
    public void DictionaryRange_KeysAndValues()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var d = Dictionary[string, int32]()
            d["a"] = 1
            d["b"] = 2
            for k, v := range d {
              Console.WriteLine(k)
              Console.WriteLine(v)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\n1\nb\n2\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_for_range_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
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
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi);
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

    // ---- P2-1 regression tests: for-range over an IEnumerable must wrap the
    // enumerator loop in try/finally Dispose, matching Roslyn's `foreach`
    // lowering. Resource-owning enumerators (StreamReader-backed
    // File.ReadLines, custom IEnumerator<T>s, Dictionary<K,V>.Enumerator)
    // would otherwise leak handles on every iteration.

    /// <summary>
    /// A for-range over <c>List[int32]</c> (a value-type enumerator that
    /// implements <see cref="IDisposable"/>) must produce exactly one
    /// exception region in the entry-point method body — the try/finally
    /// that disposes the enumerator after the loop.
    /// </summary>
    [Fact]
    public void EnumerableRange_OverList_EmitsTryFinallyDispose()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var xs = List[int32]()
            xs.Add(1)
            for v := range xs {
              Console.WriteLine(v)
            }
            """;

        var regions = GetEntryPointExceptionRegions(source);
        Assert.True(
            regions.Any(r => r.Kind == ExceptionRegionKind.Finally),
            "Expected at least one finally region in the entry-point body to dispose the enumerator.");
    }

    /// <summary>
    /// A for-range over <see cref="System.Collections.Generic.IEnumerable{T}"/>
    /// — i.e. a reference enumerator with non-no-op Dispose — must also wrap
    /// in try/finally. Uses <c>Enumerable.Range</c> (reference enumerator).
    /// </summary>
    [Fact]
    public void EnumerableRange_OverIEnumerable_EmitsTryFinallyDispose()
    {
        var source = """
            package P
            import System
            import System.Linq

            for v := range Enumerable.Range(0, 3) {
              Console.WriteLine(v)
            }
            """;

        var regions = GetEntryPointExceptionRegions(source);
        Assert.True(
            regions.Any(r => r.Kind == ExceptionRegionKind.Finally),
            "Expected a finally region wrapping the enumerator loop for IEnumerable<int>.");
    }

    /// <summary>
    /// The Dispose call inside the finally region must actually run end-to-end
    /// — verified here by iterating a temp file via <c>File.ReadLines</c> and
    /// observing that the underlying <c>StreamReader</c> released the file
    /// handle (so we can delete the file immediately after the loop on
    /// platforms where open files are locked).
    /// </summary>
    [Fact]
    public void EnumerableRange_OverFileReadLines_ReleasesFileHandle()
    {
        var dataDir = Directory.CreateTempSubdirectory("gs_for_range_dispose_data_").FullName;
        var dataPath = Path.Combine(dataDir, "data.txt");
        File.WriteAllText(dataPath, "alpha\nbeta\ngamma\n");

        var source = $$"""
            package P
            import System
            import System.IO

            for line := range File.ReadLines("{{dataPath.Replace("\\", "\\\\")}}") {
              Console.WriteLine(line)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("alpha\nbeta\ngamma\n", output);

        // If the for-range didn't dispose the StreamReader, the file handle
        // would still be held by the (now-orphaned) reader, and on Windows
        // this delete would throw IOException. On POSIX deletion succeeds
        // regardless, but failing to call Dispose would still be observable
        // via accumulated handle leaks at scale.
        File.Delete(dataPath);
        Directory.Delete(dataDir);
    }

    private static ImmutableExceptionRegionList GetEntryPointExceptionRegions(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_for_range_dispose_il_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
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
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

            using var fs = File.OpenRead(outPath);
            using var pe = new PEReader(fs);
            var md = pe.GetMetadataReader();
            var entryToken = pe.PEHeaders.CorHeader!.EntryPointTokenOrRelativeVirtualAddress;
            Assert.NotEqual(0, entryToken);
            var entryMethodHandle = MetadataTokens.MethodDefinitionHandle(entryToken);
            var entryMethod = md.GetMethodDefinition(entryMethodHandle);
            var rva = entryMethod.RelativeVirtualAddress;
            Assert.NotEqual(0, rva);
            var body = pe.GetMethodBody(rva);
            var collected = new List<ExceptionRegion>(body.ExceptionRegions.Length);
            foreach (var region in body.ExceptionRegions)
            {
                collected.Add(region);
            }

            return new ImmutableExceptionRegionList(collected);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private readonly struct ImmutableExceptionRegionList
    {
        private readonly List<ExceptionRegion> regions;

        public ImmutableExceptionRegionList(List<ExceptionRegion> regions)
        {
            this.regions = regions;
        }

        public IEnumerable<ExceptionRegion> Where(Func<ExceptionRegion, bool> p)
            => this.regions.Where(p);

        public bool Any(Func<ExceptionRegion, bool> p) => this.regions.Any(p);

        public int Count => this.regions.Count;
    }
}
