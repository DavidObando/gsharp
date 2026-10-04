// <copyright file="Issue2514ImportedInterfaceConstraintPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace Cs2Gs.Tests;

/// <summary>Default SDK-backed regression for imported constraint properties.</summary>
public sealed class Issue2514ImportedInterfaceConstraintPipelineTests
{
    private readonly ITestOutputHelper output;

    public Issue2514ImportedInterfaceConstraintPipelineTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public async Task Pipeline_ViaSdkDefault_ImportedConstraintReadsWritesAndCalls_Compile()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        Assert.NotNull(compiler);
        Assert.NotNull(repoRoot);
        var sdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot);
        Assert.NotNull(sdk);
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        this.output.WriteLine("Compiler: " + compiler + " SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(compiler))));
        this.output.WriteLine("SDK package: " + sdk);

        string sourceRoot = NewDirectory("scratch-projects");
        try
        {
            (string contractsProject, string consumerProject) = WriteFixture(sourceRoot);
            string nativeDirectory = Path.Combine(sourceRoot, "native");
            Directory.CreateDirectory(nativeDirectory);
            string nativeContracts = Path.Combine(nativeDirectory, "Contracts.dll");
            string nativeConsumer = Path.Combine(nativeDirectory, "Consumer.dll");
            CompileCSharpFixture(nativeContracts, File.ReadAllText(Path.ChangeExtension(contractsProject, ".cs")));
            CompileCSharpFixture(nativeConsumer, File.ReadAllText(Path.Combine(Path.GetDirectoryName(consumerProject), "Repro.cs")), nativeContracts);
            AssertRuntimeContract(nativeContracts, nativeConsumer);

            string outputRoot = NewDirectory("pipeline-tests");
            try
            {
                var options = new PipelineOptions
                {
                    GscPath = compiler,
                    OutputRoot = outputRoot,
                    SourceRoot = sourceRoot,
                };
                Assert.True(options.CompileViaSdk);

                var pipeline = new MigrationPipeline(
                    options,
                    new IMigrationStage[] { new TranslateStage(), new CompileStage(), new IlVerifyStage() });
                RunResult result = await pipeline.RunAsync(new[]
                {
                    new CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
                    new CorpusApp("test/Consumer", consumerProject, TargetKind.Library),
                });

                Assert.Equal(2, result.Apps.Count);
                Assert.All(result.Apps, app =>
                {
                    Assert.True(
                        app.Succeeded,
                        app.AppId + " should compile and verify through default --via-sdk/gsc. Stages: "
                            + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
                    Assert.Equal(3, app.Stages.Count);
                    Assert.All(app.Stages, stage => Assert.Equal("passed", stage.Status));
                });

                string RunDirectory(string appId) => Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appId));
                string consumerDirectory = RunDirectory("test/Consumer");
                string emitted = File.ReadAllText(Path.Combine(consumerDirectory, "Repro.gs"));
                this.output.WriteLine("FULL Consumer.gs:\n" + emitted);
                foreach (var app in result.Apps)
                {
                    this.output.WriteLine(app.AppId + ": " + string.Join("; ", app.Stages.Select(stage => stage.Stage + "=" + stage.Status)));
                    this.output.WriteLine(File.ReadAllText(Path.Combine(RunDirectory(app.AppId), "ilverify.log")));
                }
                Assert.Contains("shared class Repro {", emitted, StringComparison.Ordinal);
                Assert.DoesNotContain("shared {", emitted, StringComparison.Ordinal);

                // A constrained T can be a mutable struct, so its interface
                // getter needs mutable storage in the flat shared class.
                string expectedRead = string.Join(
                    Environment.NewLine,
                    "func Read[T IPerson](value T) string {",
                    "        var value = value",
                    "        return value.Name",
                    "    }");
                Assert.Contains(expectedRead, emitted, StringComparison.Ordinal);
                Assert.Contains("func Write[T IPerson](value T, name string, book string)", emitted, StringComparison.Ordinal);
                Assert.Contains("value.Name = name", emitted, StringComparison.Ordinal);
                // gsc types Books non-null, so polish strips forgiveness.
                Assert.Contains("value.Books.Add(book)", emitted, StringComparison.Ordinal);
                Assert.Contains("func Test(value Author) string -> Read(value)", emitted, StringComparison.Ordinal);
                AssertRuntimeContract(
                    Path.Combine(RunDirectory("test/Contracts"), "bin", options.Config, "net10.0", "Contracts.dll"),
                    Path.Combine(consumerDirectory, "bin", options.Config, "net10.0", "Consumer.dll"));
                this.output.WriteLine("Native and migrated metadata/runtime: IPerson constraints, Ada -> Grace, one G# book, and Test -> Read passed.");
            }
            finally
            {
                Directory.Delete(outputRoot, recursive: true);
            }
        }
        finally
        {
            Directory.Delete(sourceRoot, recursive: true);
        }
    }

    private static void CompileCSharpFixture(string path, string source, string reference = null)
    {
        IEnumerable<MetadataReference> references = CSharpProjectLoader.RuntimeReferences();
        if (reference != null)
        {
            references = references.Append(MetadataReference.CreateFromFile(reference)).ToArray();
        }

        var compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(path),
            new[] { CSharpSyntaxTree.ParseText(source) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var image = File.Create(path);
        var emit = compilation.Emit(image);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
    }

    private static void AssertRuntimeContract(string contractsPath, string consumerPath)
    {
        Assert.True(File.Exists(contractsPath), contractsPath);
        Assert.True(File.Exists(consumerPath), consumerPath);
        var context = new AssemblyLoadContext("Issue2514-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            using var contractsImage = new MemoryStream(File.ReadAllBytes(contractsPath));
            using var consumerImage = new MemoryStream(File.ReadAllBytes(consumerPath));
            var contracts = context.LoadFromStream(contractsImage);
            var consumer = context.LoadFromStream(consumerImage);
            var person = contracts.GetType("Issue2514.Contracts.IPerson");
            var authorType = contracts.GetType("Issue2514.Contracts.Author");
            var repro = consumer.GetType("Issue2514.Consumer.Repro");
            Assert.NotNull(person);
            Assert.NotNull(authorType);
            Assert.NotNull(repro);
            Assert.True(repro.IsAbstract && repro.IsSealed);
            foreach (var name in new[] { "Read", "Write" })
            {
                var method = repro.GetMethod(name, BindingFlags.Public | BindingFlags.Static);
                Assert.NotNull(method);
                var parameter = Assert.Single(method.GetGenericArguments());
                Assert.Equal("T", parameter.Name);
                Assert.Equal(person, Assert.Single(parameter.GetGenericParameterConstraints()));
                Assert.Equal(parameter, method.GetParameters()[0].ParameterType);
                Assert.Equal("value", method.GetParameters()[0].Name);
            }

            var read = repro.GetMethod("Read");
            var write = repro.GetMethod("Write");
            var test = repro.GetMethod("Test");
            Assert.NotNull(read);
            Assert.NotNull(write);
            Assert.NotNull(test);
            Assert.Equal(typeof(string), read.ReturnType);
            var author = Activator.CreateInstance(authorType);
            Assert.NotNull(author);
            var nameProperty = authorType.GetProperty("Name");
            var booksProperty = authorType.GetProperty("Books");
            Assert.NotNull(nameProperty);
            Assert.NotNull(booksProperty);
            var books = Assert.IsAssignableFrom<IList<string>>(booksProperty.GetValue(author));
            Assert.Empty(books);
            Assert.Equal("Ada", read.MakeGenericMethod(authorType).Invoke(null, new[] { author }));
            write.MakeGenericMethod(authorType).Invoke(null, new[] { author, "Grace", "G# book" });
            Assert.Equal("Grace", nameProperty.GetValue(author));
            Assert.Equal("G# book", Assert.Single(books));
            Assert.Equal("Grace", read.MakeGenericMethod(authorType).Invoke(null, new[] { author }));
            Assert.Equal("Grace", test.Invoke(null, new[] { author }));
        }
        finally
        {
            context.Unload();
        }
    }

    private static (string ContractsProject, string ConsumerProject) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string contractsDirectory = Path.Combine(sourceRoot, "Contracts");
        Directory.CreateDirectory(contractsDirectory);
        string contractsProject = Path.Combine(contractsDirectory, "Contracts.csproj");
        File.WriteAllText(contractsProject, ProjectFile(null));
        File.WriteAllText(Path.Combine(contractsDirectory, "Contracts.cs"), """
            using System.Collections.Generic;

            namespace Issue2514.Contracts;

            public interface IPerson
            {
                string Name { get; set; }
                IList<string> Books { get; }
            }

            public sealed class Author : IPerson
            {
                public string Name { get; set; } = "Ada";
                public IList<string> Books { get; } = new List<string>();
            }
            """);

        string consumerDirectory = Path.Combine(sourceRoot, "Consumer");
        Directory.CreateDirectory(consumerDirectory);
        string consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj");
        File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"));
        File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), """
            using Issue2514.Contracts;

            namespace Issue2514.Consumer;

            public static class Repro
            {
                public static string Read<T>(T value) where T : IPerson => value.Name;

                public static void Write<T>(T value, string name, string book) where T : IPerson
                {
                    value.Name = name;
                    value.Books.Add(book);
                }

                public static string Test(Author value) => Read(value);
            }
            """);

        return (contractsProject, consumerProject);
    }

    private static string ProjectFile(string projectReference)
    {
        string reference = projectReference is null
            ? string.Empty
            : $"""

                <ItemGroup>
                  <ProjectReference Include="{projectReference}" />
                </ItemGroup>
              """;
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>disable</Nullable>
              </PropertyGroup>{reference}
            </Project>
            """;
    }

    private static string NewDirectory(string category)
    {
        return Directory.CreateTempSubdirectory("issue2514_" + category + "_").FullName;
    }

    private static string FindSiblingTool(string projectDirectoryName, string dllName)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    projectDirectoryName,
                    dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
