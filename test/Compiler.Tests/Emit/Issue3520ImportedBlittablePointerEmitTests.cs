// <copyright file="Issue3520ImportedBlittablePointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3520ImportedBlittablePointerEmitTests
{
    private static readonly string[] UnsafeIlVerifyIgnored =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
        "StackUnexpectedArrayType",
    };

    private const string FixtureSource = """
        using System.Runtime.InteropServices;

        namespace Issue3520.Library;

        [StructLayout(LayoutKind.Sequential)]
        public struct BlittablePair
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct NestedBlittablePair
        {
            public BlittablePair Pair;
            public long Z;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct ExplicitBlittablePair
        {
            [FieldOffset(0)]
            public int X;

            [FieldOffset(4)]
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ManagedPair
        {
            public string Text;
            public int Value;
        }

        [StructLayout(LayoutKind.Auto)]
        public struct AutoLayoutPair
        {
            public int Value;
        }

        public ref struct RefPair
        {
            public int Value;
        }

        public struct NullablePair
        {
            public int? Value;
        }

        public struct BoolPair
        {
            public bool Value;
        }

        public struct GenericPair<T>
        {
            public T Value;
        }

        public unsafe struct PointerNode
        {
            public int Value;
            public PointerNode* Next;
        }
        """;

    [Fact]
    public void ImportedSequentialNestedAndExplicitStructPointers_RunAndVerify()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3520.Consumer
            import System
            import Issue3520.Library

            unsafe func ReadPair(value *BlittablePair) int32 {
                return value->X + value->Y
            }

            unsafe func ReadNested(value *NestedBlittablePair) int64 {
                return int64(value->Pair.X + value->Pair.Y) + value->Z
            }

            unsafe func ReadExplicit(value *ExplicitBlittablePair) int32 {
                return value->X + value->Y
            }

            unsafe func Main() {
                var pair = BlittablePair()
                pair.X = 20
                pair.Y = 22
                var pairs = []BlittablePair{pair}
                Console.WriteLine(ReadPair(&pairs[0]))

                var nested = NestedBlittablePair()
                nested.Pair = pair
                nested.Z = 8L
                var nestedValues = []NestedBlittablePair{nested}
                Console.WriteLine(ReadNested(&nestedValues[0]))

                var explicitPair = ExplicitBlittablePair()
                explicitPair.X = 7
                explicitPair.Y = 9
                var explicitValues = []ExplicitBlittablePair{explicitPair}
                Console.WriteLine(ReadExplicit(&explicitValues[0]))
            }
            """;

        var compilation = Compile(artifacts, source, target: "exe");

        Assert.True(compilation.ExitCode == 0, $"gsc failed:\n{compilation.Diagnostics}");
        IlVerifier.Verify(
            compilation.OutputPath,
            additionalReferences: new[] { artifacts.FixturePath },
            ignoredErrorCodes: UnsafeIlVerifyIgnored);
        Assert.Equal(
            $"42{Environment.NewLine}50{Environment.NewLine}16{Environment.NewLine}",
            Run(compilation.OutputPath));
    }

    [Fact]
    public void ImportedNonBlittableStructPointers_ReportGS0398()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3520.Consumer
            import Issue3520.Library

            unsafe func ReadManaged(value *ManagedPair) int32 -> 0
            unsafe func ReadAuto(value *AutoLayoutPair) int32 -> 0
            unsafe func ReadRef(value *RefPair) int32 -> 0
            unsafe func ReadNullable(value *NullablePair) int32 -> 0
            unsafe func ReadBool(value *BoolPair) int32 -> 0
            unsafe func ReadGeneric(value *GenericPair[string]) int32 -> 0
            """;

        var compilation = Compile(artifacts, source, target: "library");

        Assert.NotEqual(0, compilation.ExitCode);
        Assert.Equal(6, Regex.Matches(compilation.Diagnostics, @"\berror GS0398:").Count);
        Assert.DoesNotContain("GS9998", compilation.Diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedMetadataClassifier_HandlesLayoutFieldsAndGenerics()
    {
        using var artifacts = new TestArtifacts();
        using var resolver = ReferenceResolver.WithReferences(new[] { artifacts.FixturePath });
        var detector = new BlittableDetector();
        var nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32);

        Assert.False(detector.IsBlittable(nullableInt));
        Assert.False(detector.IsUnmanaged(nullableInt));
        Assert.False(BlittableDetector.IsBlittableValueStructPointee(nullableInt));

        AssertClassification("BlittablePair", expected: true);
        AssertClassification("NestedBlittablePair", expected: true);
        AssertClassification("ExplicitBlittablePair", expected: true);
        AssertClassification("PointerNode", expected: true);
        AssertClassification("ManagedPair", expected: false);
        AssertClassification("AutoLayoutPair", expected: false);
        AssertClassification("RefPair", expected: false);
        AssertClassification("NullablePair", expected: false);
        AssertClassification("BoolPair", expected: false);

        Assert.True(resolver.TryResolveType("Issue3520.Library.GenericPair`1", out var openGeneric));
        Assert.False(BlittableDetector.IsBlittableValueStructPointee(TypeSymbol.FromClrType(openGeneric)));

        var intType = resolver.MapClrTypeToReferences(typeof(int));
        var stringType = resolver.MapClrTypeToReferences(typeof(string));
        Assert.True(BlittableDetector.IsBlittableValueStructPointee(
            TypeSymbol.FromClrType(openGeneric.MakeGenericType(intType))));
        Assert.False(BlittableDetector.IsBlittableValueStructPointee(
            TypeSymbol.FromClrType(openGeneric.MakeGenericType(stringType))));

        void AssertClassification(string name, bool expected)
        {
            Assert.True(resolver.TryResolveType("Issue3520.Library." + name, out var type));
            if (expected)
            {
                var nullableType = NullableTypeSymbol.Get(TypeSymbol.FromClrType(type));
                Assert.False(detector.IsBlittable(nullableType));
                Assert.False(detector.IsUnmanaged(nullableType));
                Assert.False(BlittableDetector.IsBlittableValueStructPointee(nullableType));
            }

            Assert.Equal(
                expected,
                BlittableDetector.IsBlittableValueStructPointee(TypeSymbol.FromClrType(type)));
        }
    }

    private static (int ExitCode, string Diagnostics, string OutputPath) Compile(
        TestArtifacts artifacts,
        string source,
        string target)
    {
        var sourcePath = Path.Combine(artifacts.Directory, "Consumer.gs");
        var outputPath = Path.Combine(artifacts.Directory, "Issue3520.Consumer.dll");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(
                new[]
                {
                    "/out:" + outputPath,
                    "/target:" + target,
                    "/targetframework:net10.0",
                    "/reference:" + artifacts.FixturePath,
                    sourcePath,
                });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (exitCode, stdout.ToString() + stderr.ToString(), outputPath);
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private sealed class TestArtifacts : IDisposable
    {
        public TestArtifacts()
        {
            Directory = Path.Combine(
                AppContext.BaseDirectory,
                nameof(Issue3520ImportedBlittablePointerEmitTests),
                Guid.NewGuid().ToString("N"));
            System.IO.Directory.CreateDirectory(Directory);
            FixturePath = Path.Combine(Directory, "Issue3520.Library.dll");

            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
                .Split(Path.PathSeparator)
                .Select(path => MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create(
                "Issue3520.Library",
                new[] { CSharpSyntaxTree.ParseText(FixtureSource, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));
            var result = compilation.Emit(FixturePath);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        public string Directory { get; }

        public string FixturePath { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
