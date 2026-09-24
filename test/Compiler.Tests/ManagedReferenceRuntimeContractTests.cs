// <copyright file="ManagedReferenceRuntimeContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceRuntimeContractTests
{
    public static IEnumerable<object[]> IncompatibleContracts()
    {
        foreach (var mutation in new[]
        {
            "borrow", "readonly-permission", "writable-permission", "location",
            "factory", "view", "key-type", "key-object", "key-field",
            "key-field-signature", "factory-overload", "equality", "constraint", "constructor",
            "same-location", "slice-capture", "native-factory",
        })
        {
            yield return new object[] { mutation, false };
            yield return new object[] { mutation, true };
        }
    }

    [Theory]
    [MemberData(nameof(IncompatibleContracts))]
    public void IncompatibleRuntimeReportsGs0604BeforeEmission(string mutation, bool runtimeReflection)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var runtime = CompileRuntime(fixture.Directory, mutation);
        using var references = Resolve(runtime, runtimeReflection);
        const string source = """
            package BadManagedRuntime
            func Capture(values []int32) managed[int32] { return managed(values[0]) }
            """;
        var compilation = new GSharpCompilation(references, GSharpSyntaxTree.Parse(source)) { IsLibrary = true };
        using var output = new MemoryStream();
        var result = compilation.Emit(output);
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0604");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void QualifiedHandleCannotBypassIncompatibleRuntimeValidation(bool runtimeReflection)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var runtime = CompileRuntime(fixture.Directory, "borrow");
        using var references = Resolve(runtime, runtimeReflection);
        const string source = """
            package QualifiedBadManagedRuntime
            func Read(p Gsharp.Values.ManagedRef[int32]) int32 { return *p }
            func Write(p Gsharp.Values.ManagedRef[int32]) { *p = 1 }
            func Add(p Gsharp.Values.ManagedRef[int32]) { *p += 1 }
            func Same(p Gsharp.Values.ManagedRef[int32], q Gsharp.Values.ManagedRef[int32]) bool { return p == q }
            """;
        var compilation = new GSharpCompilation(references, GSharpSyntaxTree.Parse(source)) { IsLibrary = true };
        using var output = new MemoryStream();
        var result = compilation.Emit(output);
        Assert.False(result.Success);
        Assert.True(result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0604") >= 4);
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CompleteRuntimeWorksInBothReflectionContexts(bool runtimeReflection)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var runtime = CompileRuntime(fixture.Directory, string.Empty);
        using var references = Resolve(runtime, runtimeReflection);
        Assert.True(ManagedReferenceTypes.TryResolveDefinition(references, false, out var writable));
        Assert.True(ManagedReferenceTypes.TryResolveDefinition(references, true, out var readOnly));
        Assert.NotNull(writable);
        Assert.NotNull(readOnly);
        Assert.True(ManagedReferenceTypes.TryResolveDefinition(references, false, out var again));
        Assert.Same(writable, again);
        const string source = """
            package CompleteManagedRuntime
            func Capture(values []int32) managed[int32] { return managed(values[0]) }
            func View(p managed[int32]) readonly managed[int32] { return p.AsReadOnly() }
            """;
        var compilation = new GSharpCompilation(references, GSharpSyntaxTree.Parse(source)) { IsLibrary = true };
        using var output = new MemoryStream();
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static ReferenceResolver Resolve(string runtime, bool runtimeReflection)
    {
        var references = runtimeReflection ? ReferenceResolver.WithRuntimeReferences(new[] { runtime })
            : ReferenceResolver.WithReferences(ReferencePaths().Append(runtime));
        Assert.True(references.TryResolveType("Gsharp.Values.ManagedRef`1", out var type));
        Assert.True(ReferenceResolver.TryGetAssemblyPath(type.Assembly, out var path));
        Assert.Equal(runtime, path);
        return references;
    }

    private static IEnumerable<string> ReferencePaths()
        => ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Where(path => Path.GetFileNameWithoutExtension(path) != "Gsharp.Runtime.Values");

    private static readonly string[] RuntimeSourceFiles =
        { "ManagedLocationKey.cs", "ManagedLocation.cs", "ManagedRef.cs", "ReadOnlyManagedRef.cs", "Slice.cs", "ReadOnlySlice.cs" };

    [Fact]
    public void RuntimeSourceSnapshots_MatchTheLiveRuntimeSources()
    {
        // Issue #4350: the mutation fixtures below read the runtime's C# source.
        // Gsharp.Runtime.Values now self-migrates to G#, so the migrated
        // repository has no C# runtime sources; the tests fall back to these
        // verbatim snapshots. Whenever the live C# sources exist, the snapshots
        // must match them exactly so the fixtures never drift.
        var liveRoot = LiveRuntimeSourceRoot();
        foreach (var file in RuntimeSourceFiles)
        {
            var snapshot = File.ReadAllText(Path.Combine(SnapshotRuntimeSourceRoot(), file + ".txt"));
            var live = Path.Combine(liveRoot, file);
            if (File.Exists(live))
            {
                Assert.Equal(File.ReadAllText(live), snapshot);
            }
            else
            {
                Assert.Contains("namespace Gsharp.Values;", snapshot, StringComparison.Ordinal);
            }
        }
    }

    // Review finding (#4350): resolve both roots from the repository root
    // rather than a fixed number of `..` hops from the test output directory.
    private static string LiveRuntimeSourceRoot()
        => Path.Combine(IlVerifier.FindRepoRoot(), "src", "Sdk", "Gsharp.Runtime.Values");

    private static string SnapshotRuntimeSourceRoot()
        => Path.Combine(IlVerifier.FindRepoRoot(), "test", "Compiler.Tests", "TestData", "RuntimeValuesSource");

    private static string ReadRuntimeSource(string file)
    {
        var live = Path.Combine(LiveRuntimeSourceRoot(), file);
        return File.Exists(live)
            ? File.ReadAllText(live)
            : File.ReadAllText(Path.Combine(SnapshotRuntimeSourceRoot(), file + ".txt"));
    }

    private static string CompileRuntime(string directory, string mutation)
    {
        var version = typeof(Gsharp.Values.ManagedRef<>).Assembly.GetName().Version;
        var sources = new List<SyntaxTree>
        {
            CSharpSyntaxTree.ParseText($"global using System;\nglobal using System.Collections.Generic;\n[assembly: System.Reflection.AssemblyVersion(\"{version}\")]"),
        };
        foreach (var file in RuntimeSourceFiles)
        {
            var text = ReadRuntimeSource(file);
            text = mutation switch
            {
                "borrow" => text.Replace("Borrow", "MissingBorrow", StringComparison.Ordinal),
                "readonly-permission" => text.Replace("ref readonly T Borrow()", "ref T Borrow()", StringComparison.Ordinal),
                "writable-permission" => text.Replace("ref T Borrow()", "ref readonly T Borrow()", StringComparison.Ordinal),
                "location" => text.Replace("GetLocation", "MissingLocation", StringComparison.Ordinal),
                "same-location" => text.Replace("SameLocation", "MissingSameLocation", StringComparison.Ordinal),
                "slice-capture" => text.Replace("GetManagedReference", "MissingManagedReference", StringComparison.Ordinal),
                "factory" => text.Replace("FromArray", "MissingFactory", StringComparison.Ordinal),
                "native-factory" => text.Replace("FromArrayNative", "MissingNativeFactory", StringComparison.Ordinal),
                "view" => text.Replace("AsReadOnly", "MissingView", StringComparison.Ordinal),
                "key-type" => text.Replace("ManagedLocationKey", "MissingLocationKey", StringComparison.Ordinal),
                "key-object" => text.Replace("ManagedLocationKey Object(", "ManagedLocationKey MissingObject(", StringComparison.Ordinal),
                "key-field" => text.Replace("ManagedLocationKey Field(", "ManagedLocationKey MissingField(", StringComparison.Ordinal),
                "key-field-signature" => text.Replace("RuntimeTypeHandle declaringType", "Type declaringType", StringComparison.Ordinal)
                    .Replace("(field, declaringType)", "(field, declaringType.TypeHandle)", StringComparison.Ordinal),
                "factory-overload" when file == "ManagedRef.cs" => text.Replace(
                    "public abstract ref T Borrow();",
                    "public abstract ref T Borrow();\npublic static ManagedRef<T> FromArray(T[] owner) => FromArray(owner, 0);",
                    StringComparison.Ordinal),
                "equality" => text.Replace("operator ==", "MissingEquality", StringComparison.Ordinal)
                    .Replace("operator !=", "MissingInequality", StringComparison.Ordinal),
                "constraint" => text.Replace("ManagedLocation<T>\n{", "ManagedLocation<T> where T : class\n{", StringComparison.Ordinal)
                    .Replace(": ManagedLocation<T>\n{", ": ManagedLocation<T> where T : class\n{", StringComparison.Ordinal)
                    .Replace("IEnumerable<T>\n{", "IEnumerable<T> where T : class\n{", StringComparison.Ordinal),
                "constructor" when file == "ManagedRef.cs" => text.Replace(
                    "public abstract ref T Borrow();", "private ManagedRef() { }\npublic abstract ref T Borrow();", StringComparison.Ordinal),
                _ => text,
            };
            if (mutation == "equality")
            {
                text = text.Replace("!(left == right)", "!MissingEquality(left, right)", StringComparison.Ordinal);
            }

            sources.Add(CSharpSyntaxTree.ParseText(text));
        }

        var compilation = CSharpCompilation.Create(
            "Gsharp.Runtime.Values", sources, ReferencePaths().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        var path = Path.Combine(directory, "Gsharp.Runtime.Values.dll");
        var emitted = compilation.Emit(path);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        return path;
    }
}
