// <copyright file="Issue3708ForInEnumeratorDisposalEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3708: <c>Lowerer.TryBuildEnumeratorDisposeCall</c> decided whether a
/// <c>for … in</c> loop needed a <c>try</c>/<c>finally</c> using a live
/// <c>typeof(IDisposable).IsAssignableFrom(clrType)</c>. That predicate is
/// unconditionally <see langword="false"/> for types loaded through a
/// <see cref="System.Reflection.MetadataLoadContext"/> — i.e. every imported
/// type in a <c>/reference:</c>-based compile, which is every real SDK build —
/// so no disposal was emitted and the enumerator leaked its resource
/// (<c>File.ReadLines</c>, <c>Directory.EnumerateFiles</c>, <c>xs.Where(…)</c>).
/// C# guarantees the <c>finally</c> (ECMA-334 §13.9.5).
/// <para>
/// These tests pin the emitted IL rather than mere compilation success: a
/// "does it compile?" assertion passes on the bug.
/// </para>
/// </summary>
public class Issue3708ForInEnumeratorDisposalEmitTests
{
    [Fact]
    public void ImportedDisposableEnumerator_AgainstRefPack_EmitsTryFinallyWithDisposeCall()
    {
        // File.ReadLines returns an imported IEnumerable[string] whose
        // enumerator is a reference type implementing IDisposable, resolved
        // entirely out of the MetadataLoadContext.
        const string source = """
            package Probe
            import System
            import System.IO

            class P {
                func Run(path string) {
                    for line in File.ReadLines(path) {
                        Console.WriteLine(line)
                        break
                    }
                }
            }
            """;

        var assemblyPath = CompileLibraryAgainstRefPack(source);
        try
        {
            var body = ReadMethodBody(assemblyPath, "P", "Run");
            Assert.Contains(body.Regions, region => region.Kind == ExceptionRegionKind.Finally);
            Assert.Contains(
                body.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally),
                region => CalledMethodNames(body, region.HandlerOffset, region.HandlerLength)
                    .Contains("Dispose"));
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    [Fact]
    public void ImportedDisposableEnumerator_LinqWhere_EmitsTryFinallyWithDisposeCall()
    {
        // The LINQ iterator returned by Where is an imported class whose
        // Dispose is what stops the underlying enumeration — same MLC path.
        const string source = """
            package Probe
            import System
            import System.Collections.Generic
            import System.Linq

            class P {
                func Run(xs IEnumerable[int32]) int32 {
                    for x in xs.Where((v int32) -> v > 1) {
                        return x
                    }
                    return 0
                }
            }
            """;

        var assemblyPath = CompileLibraryAgainstRefPack(source);
        try
        {
            var body = ReadMethodBody(assemblyPath, "P", "Run");
            Assert.Contains(
                body.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally),
                region => CalledMethodNames(body, region.HandlerOffset, region.HandlerLength)
                    .Contains("Dispose"));
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    [Fact]
    public void ByRefLikeEnumerator_Span_EmitsNoDisposal()
    {
        // Negative pin for the sibling guard the fix must not weaken: ref
        // structs implement interfaces since .NET 9, so Span[T].Enumerator
        // now answers "yes" to IDisposable, but interface dispatch on a
        // byref-like receiver boxes and is invalid IL. Roslyn likewise emits
        // no disposal for the span pattern enumerator.
        const string source = """
            package Probe
            import System

            class P {
                func Run(values []int32) int32 {
                    var span Span[int32] = values
                    for v in span {
                        return v
                    }
                    return 0
                }
            }
            """;

        var assemblyPath = CompileLibraryAgainstRefPack(source);
        try
        {
            var body = ReadMethodBody(assemblyPath, "P", "Run");
            Assert.DoesNotContain(body.Regions, region => region.Kind == ExceptionRegionKind.Finally);
            Assert.DoesNotContain("Dispose", CalledMethodNames(body, 0, body.Il.Length));
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    [Fact]
    public void UserIteratorEnumerator_StillEmitsTryFinallyWithDisposeCall()
    {
        // The symbolic/same-compilation branch (a synthesized iterator state
        // machine) answered correctly before the fix because its enumerator
        // type is a live runtime type. Pin that it keeps working.
        const string source = """
            package Probe
            import System
            import System.Collections.Generic

            class P {
                func Numbers() IEnumerable[int32] {
                    yield 1
                    yield 2
                }

                func Run() int32 {
                    for n in Numbers() {
                        return n
                    }
                    return 0
                }
            }
            """;

        var assemblyPath = CompileLibraryAgainstRefPack(source);
        try
        {
            var body = ReadMethodBody(assemblyPath, "P", "Run");
            Assert.Contains(
                body.Regions.Where(region => region.Kind == ExceptionRegionKind.Finally),
                region => CalledMethodNames(body, region.HandlerOffset, region.HandlerLength)
                    .Contains("Dispose"));
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    [Fact]
    public void ImportedDisposableEnumerator_EarlyBreak_ReleasesTheFileHandle()
    {
        // Executing proof: after the loop breaks, the file must be openable
        // with FileShare.None. While the enumerator's handle leaks (pre-fix,
        // held until GC) that open throws IOException.
        const string source = """
            package Probe
            import System
            import System.IO

            let path = Environment.GetCommandLineArgs()[1]
            for line in File.ReadLines(path) {
                Console.WriteLine(line)
                break
            }

            let exclusive = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)
            exclusive.Dispose()
            Console.WriteLine("released")
            """;

        var assemblyPath = CompileExecutableAgainstRefPack(source);
        var directory = Path.GetDirectoryName(assemblyPath)!;
        try
        {
            var dataPath = Path.Combine(directory, "lines.txt");
            File.WriteAllText(dataPath, "alpha" + Environment.NewLine + "beta" + Environment.NewLine);

            var result = Run(assemblyPath, dataPath);
            Assert.True(
                result.ExitCode == 0,
                $"the enumerator's file handle was still held after `break` (exit {result.ExitCode}):\n"
                + $"stdout:\n{result.StandardOutput}\nstderr:\n{result.StandardError}");
            Assert.Contains("released", result.StandardOutput);
        }
        finally
        {
            TryDeleteDirectory(directory);
        }
    }

    private sealed record MethodBody(
        byte[] Il,
        ImmutableArray<ExceptionRegion> Regions,
        IReadOnlyDictionary<int, string> MethodNamesByToken);

    private static MethodBody ReadMethodBody(string assemblyPath, string typeName, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var method = metadata.TypeDefinitions
            .Select(handle => metadata.GetTypeDefinition(handle))
            .Where(type => metadata.GetString(type.Name) == typeName)
            .SelectMany(type => type.GetMethods())
            .Select(handle => metadata.GetMethodDefinition(handle))
            .Single(candidate => metadata.GetString(candidate.Name) == methodName);
        var body = pe.GetMethodBody(method.RelativeVirtualAddress);

        // Resolve the whole call-target name table eagerly: the metadata heaps
        // are backed by this PEReader's memory block and must not be touched
        // once it is disposed.
        var namesByToken = new Dictionary<int, string>();
        foreach (var handle in metadata.MemberReferences)
        {
            namesByToken[MetadataTokens.GetToken(handle)] =
                metadata.GetString(metadata.GetMemberReference(handle).Name);
        }

        foreach (var handle in metadata.MethodDefinitions)
        {
            namesByToken[MetadataTokens.GetToken(handle)] =
                metadata.GetString(metadata.GetMethodDefinition(handle).Name);
        }

        var methodSpecCount = metadata.GetTableRowCount(TableIndex.MethodSpec);
        for (var row = 1; row <= methodSpecCount; row++)
        {
            var handle = MetadataTokens.MethodSpecificationHandle(row);
            var parent = metadata.GetMethodSpecification(handle).Method;
            if (namesByToken.TryGetValue(MetadataTokens.GetToken(parent), out var parentName))
            {
                namesByToken[MetadataTokens.GetToken(handle)] = parentName;
            }
        }

        return new MethodBody(body.GetILBytes()!, body.ExceptionRegions, namesByToken);
    }

    /// <summary>
    /// Returns the names of every method targeted by a <c>call</c> /
    /// <c>callvirt</c> / <c>constrained.</c>-prefixed call inside the given IL
    /// window. Scanning for the two call opcodes plus a 4-byte token is
    /// sufficient here because the windows inspected are the tiny bodies the
    /// lowerer synthesizes, matching the byte-scanning idiom used by the other
    /// emit tests in this folder.
    /// </summary>
    /// <param name="body">The decoded method body.</param>
    /// <param name="offset">Start of the IL window.</param>
    /// <param name="length">Length of the IL window.</param>
    /// <returns>The set of called method names.</returns>
    private static HashSet<string> CalledMethodNames(MethodBody body, int offset, int length)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        var end = Math.Min(body.Il.Length, offset + length);
        for (var i = offset; i + 5 <= end; i++)
        {
            if (body.Il[i] != 0x28 && body.Il[i] != 0x6F)
            {
                continue;
            }

            var token = BinaryPrimitives.ReadInt32LittleEndian(body.Il.AsSpan(i + 1, 4));
            if (body.MethodNamesByToken.TryGetValue(token, out var name))
            {
                names.Add(name);
            }
        }

        return names;
    }

    private static string CompileLibraryAgainstRefPack(string source) => Compile(source, "library");

    private static string CompileExecutableAgainstRefPack(string source) => Compile(source, "exe");

    private static string Compile(string source, string target)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3708_").FullName;
        var sourcePath = Path.Combine(directory, "probe.gs");
        var outputPath = Path.Combine(directory, "probe.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in RefPackReferences())
        {
            args.Add("/reference:" + reference);
        }

        args.Add(sourcePath);

        using var standardOutput = new StringWriter();
        using var standardError = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(standardOutput);
        Console.SetError(standardError);
        try
        {
            var exitCode = Program.Main(args.ToArray());
            Assert.True(exitCode == 0, $"compile failed ({exitCode}):\n{standardOutput}\n{standardError}");
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        IlVerifier.Verify(outputPath);
        return outputPath;
    }

    private static (int ExitCode, string StandardOutput, string StandardError) Run(string assemblyPath, string argument)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
                argument,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        })!;
        var standardOutput = process.StandardOutput.ReadToEnd().ReplaceLineEndings(Environment.NewLine);
        var standardError = process.StandardError.ReadToEnd().ReplaceLineEndings(Environment.NewLine);
        Assert.True(process.WaitForExit(60_000), "dotnet exec timed out");
        return (process.ExitCode, standardOutput, standardError);
    }

    /// <summary>
    /// Assembles the reference closure the .NET SDK would hand gsc — the
    /// <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades. Loading through
    /// these (rather than the test host's TPA) is what puts every imported type
    /// in a MetadataLoadContext with an assembly identity distinct from the
    /// host's <c>System.Private.CoreLib</c>, which is the exact configuration
    /// issue #3708 mis-answered. Mirrors
    /// <c>XunitAssertOverloadResolutionTests.RefPackReferences</c>.
    /// </summary>
    /// <returns>The reference assembly paths.</returns>
    private static IEnumerable<string> RefPackReferences()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        Assert.False(string.IsNullOrEmpty(runtimeDir), "host runtime directory not resolvable");
        var dotnetRoot = Directory.GetParent(runtimeDir!)?.Parent?.Parent?.FullName;
        Assert.False(string.IsNullOrEmpty(dotnetRoot), "dotnet root not resolvable");
        var packsRoot = Path.Combine(dotnetRoot!, "packs", "Microsoft.NETCore.App.Ref");
        Assert.True(Directory.Exists(packsRoot), $"ref pack root '{packsRoot}' missing");

        var major = Environment.Version.Major.ToString();
        var refDir = Path.Combine(packsRoot, Environment.Version.ToString(3), "ref", $"net{major}.0");
        if (!Directory.Exists(refDir))
        {
            var candidate = Directory.EnumerateDirectories(packsRoot, major + ".*")
                .OrderByDescending(d => d, StringComparer.Ordinal)
                .Select(d => Path.Combine(d, "ref", $"net{major}.0"))
                .FirstOrDefault(Directory.Exists);
            Assert.False(string.IsNullOrEmpty(candidate), $"no ref pack for net{major}.0 under '{packsRoot}'");
            refDir = candidate!;
        }

        return Directory.EnumerateFiles(refDir, "*.dll");
    }

    private static void DeleteDirectory(string assemblyPath)
        => TryDeleteDirectory(Path.GetDirectoryName(assemblyPath)!);

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
