// <copyright file="Issue2744RecordAbiEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>C# compile/runtime coverage for issue #2744.</summary>
public sealed class Issue2744RecordAbiEmitTests
{
    [Fact]
    public void DataClass_IsCSharpRecordCompatible_AndPreservesEqualityTypeBoundary()
    {
        const string gsharp = """
            package Records

            data class Config {
                prop Name string { get; init; }
            }
            data class Credentials(Username string, Password string) {
            }
            data class PatternRecord(Value int32) {
            }
            class PatternProbe {
                shared {
                    func Match(value PatternRecord) string -> switch value {
                        case { Value: 1 }: "match"
                        default: "miss"
                    }
                }
            }
            open data class Base() {
            }
            data class Left() : Base() {
            }
            data class Right() : Base() {
            }
            class Plain {
            }
            """;
        const string csharp = """
            using System;
            using System.Linq;
            using System.Reflection;
            using Records;

            public static class Probe
            {
                public static string Run()
                {
                    var original = new Config { Name = "old" };
                    var copy = original with { Name = "new" };
                    var credentials = new Credentials("user", "secret") with { Password = "changed" };
                    var leftCopy = new Left() with { };
                    var copyCtor = typeof(Config).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
                        .Single(c => c.GetParameters().Length == 1 && c.GetParameters()[0].ParameterType == typeof(Config));
                    var baseCopyCtor = typeof(Base).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
                        .Single(c => c.GetParameters().Length == 1 && c.GetParameters()[0].ParameterType == typeof(Base));
                    return $"{original.Name}|{copy.Name}|{credentials.Username}:{credentials.Password}|{PatternProbe.Match(new PatternRecord(1))}|{leftCopy.GetType().Name}|{copyCtor.IsPrivate}|{baseCopyCtor.IsFamily}|{typeof(Config).GetProperty("EqualityContract", BindingFlags.Instance | BindingFlags.NonPublic) != null}|{new Left().Equals((Base)new Right())}|{typeof(Plain).GetMethod("<Clone>$") == null}";
                }
            }
            """;

        Assert.Equal("old|new|user:changed|match|Left|True|True|True|False|True", CompileAndRun(gsharp, csharp));
    }

    [Fact]
    public void PositionalDataStruct_HasCSharpConstructorAndInitProperties()
    {
        const string gsharp = """
            package Records

            data struct Point(X int32, Y int32) {
            }
            class StructPatternProbe {
                shared {
                    func Match(point Point) string -> switch point {
                        case { X: 1, Y: 2 }: "match"
                        default: "miss"
                    }
                }
            }
            """;
        const string csharp = """
            using Records;

            public static class Probe
            {
                public static string Run()
                {
                    var point = new Point(1, 2);
                    var copy = point with { X = 3 };
                    return $"{point.X},{point.Y}|{copy.X},{copy.Y}|{StructPatternProbe.Match(point)}";
                }
            }
            """;

        Assert.Equal("1,2|3,2|match", CompileAndRun(gsharp, csharp));
    }

    private static string CompileAndRun(string gsharp, string csharp)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2744-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = Path.Combine(directory, "Records.dll");
            var consumerPath = Path.Combine(directory, "Consumer.dll");
            var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(gsharp)))
            {
                IsLibrary = true,
            };
            using (var output = File.Create(libraryPath))
            {
                var result = compilation.Emit(output, pdbStream: null, refStream: null, assemblyName: "Records");
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            }

            IlVerifier.Verify(libraryPath);

            var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                    ?.Split(Path.PathSeparator)
                    ?? Array.Empty<string>())
                .Where(File.Exists)
                .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
                .Append(MetadataReference.CreateFromFile(libraryPath));
            var consumer = CSharpCompilation.Create(
                "Consumer",
                new[] { CSharpSyntaxTree.ParseText(csharp, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using (var output = File.Create(consumerPath))
            {
                var result = consumer.Emit(output);
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            }

            var loadContext = new AssemblyLoadContext("Issue2744-" + Guid.NewGuid(), isCollectible: true);
            try
            {
                _ = loadContext.LoadFromAssemblyPath(libraryPath);
                var assembly = loadContext.LoadFromAssemblyPath(consumerPath);
                return (string)assembly.GetType("Probe", throwOnError: true)!
                    .GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!
                    .Invoke(null, null)!;
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
