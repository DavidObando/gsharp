// <copyright file="Issue2916NestedStructArityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Regression coverage for issue #2916.</summary>
public sealed class Issue2916NestedStructArityEmitTests
{
    [Fact]
    public void CSharpConsumer_NamesAndRunsNestedStructsByOwnArity()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2916NestedStructArityEmitTests) + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var libraryPath = Path.Combine(directory, "Issue2916.Library.dll");
            var consumerPath = Path.Combine(directory, "Issue2916.Consumer.dll");

            EmitGSharpLibrary(libraryPath);
            EmitCSharpConsumer(libraryPath, consumerPath);
            AssertMetadataNames(libraryPath);
            Assert.Equal($"11{Environment.NewLine}22{Environment.NewLine}33{Environment.NewLine}", RunConsumer(directory, consumerPath));
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void EmitGSharpLibrary(string outputPath)
    {
        const string source = """
            package Issue2916

            public struct Outer[T any] {
                public struct Inner {
                    public var Value int32
                }

                public struct Middle {
                    public struct Deep {
                        public var Value int32
                    }
                }

                public struct GenericInner[U any] {
                    public var Value int32
                }
            }
            """;

        using var resolver = ReferenceResolver.WithReferences(Array.Empty<string>());
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };
        using var output = File.Create(outputPath);
        var result = compilation.Emit(
            output,
            pdbStream: null,
            refStream: null,
            assemblyName: "Issue2916.Library");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static void EmitCSharpConsumer(string libraryPath, string outputPath)
    {
        const string source = """
            using System;
            using Issue2916;

            public static class Program
            {
                public static void Main()
                {
                    var direct = new Outer<int>.Inner { Value = 11 };
                    var throughNonGenericMiddle = new Outer<int>.Middle.Deep { Value = 22 };
                    var ownGeneric = new Outer<int>.GenericInner<string> { Value = 33 };

                    Console.WriteLine(direct.Value);
                    Console.WriteLine(throughNonGenericMiddle.Value);
                    Console.WriteLine(ownGeneric.Value);
                }
            }
            """;

        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(libraryPath));
        var compilation = CSharpCompilation.Create(
            "Issue2916.Consumer",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication));

        using var output = File.Create(outputPath);
        var result = compilation.Emit(output);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static void AssertMetadataNames(string libraryPath)
    {
        using var stream = File.OpenRead(libraryPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();

        AssertType(reader, "Outer`1", genericParameterCount: 1);
        AssertType(reader, "Inner", genericParameterCount: 1);
        AssertType(reader, "Middle", genericParameterCount: 1);
        AssertType(reader, "Deep", genericParameterCount: 1);
        AssertType(reader, "GenericInner`1", genericParameterCount: 2);
    }

    private static void AssertType(MetadataReader reader, string name, int genericParameterCount)
    {
        var type = reader.TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Single(definition => reader.GetString(definition.Name) == name);
        Assert.Equal(genericParameterCount, type.GetGenericParameters().Count);
    }

    private static string RunConsumer(string directory, string consumerPath)
    {
        var runtimeConfigPath = Path.ChangeExtension(consumerPath, ".runtimeconfig.json");
        File.WriteAllText(runtimeConfigPath, """
            {
              "runtimeOptions": {
                "tfm": "net10.0",
                "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
              }
            }
            """);

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(consumerPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start C# consumer");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "C# consumer timed out");
        Assert.True(
            process.ExitCode == 0,
            $"C# consumer exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }
}
