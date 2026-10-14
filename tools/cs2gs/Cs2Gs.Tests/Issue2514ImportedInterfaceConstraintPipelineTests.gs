// <copyright file="Issue2514ImportedInterfaceConstraintPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Security.Cryptography
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

/// Default SDK-backed regression for imported constraint properties.
class Issue2514ImportedInterfaceConstraintPipelineTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    async func Pipeline_ViaSdkDefault_ImportedConstraintReadsWritesAndCalls_Compile() {
        let compiler string? = FindSiblingTool("Compiler", "gsc.dll")
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        Assert.NotNull(compiler)
        Assert.NotNull(repoRoot)
        let sdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot)
        Assert.NotNull(sdk)
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        this.output.WriteLine(
            "Compiler: " + compiler + " SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(compiler!!)))
        )
        this.output.WriteLine("SDK package: " + sdk.ToString())
        let sourceRoot = NewDirectory("scratch-projects")
        try {
            let (contractsProject, consumerProject) = WriteFixture(sourceRoot)
            let nativeDirectory = Path.Combine(sourceRoot, "native")
            Directory.CreateDirectory(nativeDirectory)
            let nativeContracts = Path.Combine(nativeDirectory, "Contracts.dll")
            let nativeConsumer = Path.Combine(nativeDirectory, "Consumer.dll")
            CompileCSharpFixture(nativeContracts, File.ReadAllText(Path.ChangeExtension(contractsProject, ".cs")))
            CompileCSharpFixture(
                nativeConsumer,
                File.ReadAllText(Path.Combine(Path.GetDirectoryName(consumerProject)!!, "Repro.cs")),
                nativeContracts
            )
            AssertRuntimeContract(nativeContracts, nativeConsumer)
            let outputRoot = NewDirectory("pipeline-tests")
            try {
                let options = PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot}
                Assert.True(options.CompileViaSdk)
                let pipeline = MigrationPipeline(
                    options,
                    []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage()}
                )
                let result = await pipeline.RunAsync(
                    []CorpusApp{
                        CorpusApp("test/Contracts", contractsProject, TargetKind.Library),
                        CorpusApp("test/Consumer", consumerProject, TargetKind.Library)
                    }
                )
                Assert.Equal(2, result.Apps.Count)
                Assert.All(
                    result.Apps,
                    (app AppResult) -> {
                        Assert.True(
                            app.Succeeded,
                            app.AppId +
                                " should compile and verify through default --via-sdk/gsc. Stages: " +
                                string.Join(
                                "; ",
                                app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                            )
                        )
                        Assert.Equal(3, app.Stages.Count)
                        Assert.All(app.Stages, (stage StageResult) -> Assert.Equal("passed", stage.Status))
                    }
                )
                let RunDirectory = func (appId string) string {
                    return Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(appId))
                }
                let consumerDirectory = RunDirectory("test/Consumer")
                let emitted = File.ReadAllText(Path.Combine(consumerDirectory, "Repro.gs"))
                this.output.WriteLine("FULL Consumer.gs:\n" + emitted)
                for app in result.Apps {
                    this.output.WriteLine(
                        app.AppId + ": " + string.Join(
                            "; ",
                            app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
                        )
                    )
                    this.output.WriteLine(File.ReadAllText(Path.Combine(RunDirectory(app.AppId), "ilverify.log")))
                }
                Assert.Contains("shared class Repro {", emitted, StringComparison.Ordinal)
                Assert.DoesNotContain("shared {", emitted, StringComparison.Ordinal)
                // A constrained T can be a mutable struct, so its interface
                // getter needs mutable storage in the flat shared class.
                let expectedRead = string.Join(
                    Environment.NewLine,
                    "func Read[T IPerson](value T) string {",
                    "        var value = value",
                    "        return value.Name",
                    "    }"
                )
                Assert.Contains(expectedRead, emitted, StringComparison.Ordinal)
                Assert.Contains(
                    "func Write[T IPerson](value T, name string, book string)",
                    emitted,
                    StringComparison.Ordinal
                )
                Assert.Contains("value.Name = name", emitted, StringComparison.Ordinal)
                // gsc types Books non-null, so polish strips forgiveness.
                Assert.Contains("value.Books.Add(book)", emitted, StringComparison.Ordinal)
                Assert.Contains("func Test(value Author) string -> Read(value)", emitted, StringComparison.Ordinal)
                AssertRuntimeContract(
                    Path.Combine(RunDirectory("test/Contracts"), "bin", options.Config, "net10.0", "Contracts.dll"),
                    Path.Combine(consumerDirectory, "bin", options.Config, "net10.0", "Consumer.dll")
                )
                this.output.WriteLine(
                    "Native and migrated metadata/runtime: IPerson constraints, Ada -> Grace, one G# book, and Test -> Read passed."
                )
            } finally {
                Directory.Delete(outputRoot, recursive: true)
            }
        } finally {
            Directory.Delete(sourceRoot, recursive: true)
        }
    }

    shared {
        private func CompileCSharpFixture(path string, source string, reference string? = nil) {
            var references IEnumerable[MetadataReference] = CSharpProjectLoader.RuntimeReferences()
            if reference != nil {
                references = references.Append(MetadataReference.CreateFromFile(reference)).ToArray()
            }
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(path),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let image = File.Create(path)
            let emit = compilation.Emit(image)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        }

        private func AssertRuntimeContract(contractsPath string, consumerPath string) {
            Assert.True(File.Exists(contractsPath), contractsPath)
            Assert.True(File.Exists(consumerPath), consumerPath)
            let context = AssemblyLoadContext("Issue2514-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                using let contractsImage = MemoryStream(File.ReadAllBytes(contractsPath))
                using let consumerImage = MemoryStream(File.ReadAllBytes(consumerPath))
                let contracts = context.LoadFromStream(contractsImage)
                let consumer = context.LoadFromStream(consumerImage)
                let person Type? = contracts.GetType("Issue2514.Contracts.IPerson")
                let authorType Type? = contracts.GetType("Issue2514.Contracts.Author")
                let repro Type? = consumer.GetType("Issue2514.Consumer.Repro")
                Assert.NotNull(person)
                Assert.NotNull(authorType)
                Assert.NotNull(repro)
                Assert.True(repro!!.IsAbstract && repro!!.IsSealed)
                for name in[]string{"Read", "Write"} {
                    let method MethodInfo? = repro!!.GetMethod(name, BindingFlags.Public | BindingFlags.Static)
                    Assert.NotNull(method)
                    let parameter = Assert.Single(method!!.GetGenericArguments())
                    Assert.Equal("T", parameter.Name)
                    Assert.Equal(person, Assert.Single(parameter.GetGenericParameterConstraints()))
                    Assert.Equal(parameter, method!!.GetParameters()[0].ParameterType)
                    Assert.Equal("value", method!!.GetParameters()[0].Name)
                }
                let read MethodInfo? = repro!!.GetMethod("Read")
                let write MethodInfo? = repro!!.GetMethod("Write")
                let test MethodInfo? = repro!!.GetMethod("Test")
                Assert.NotNull(read)
                Assert.NotNull(write)
                Assert.NotNull(test)
                Assert.Equal(typeof(string), read!!.ReturnType)
                let author object? = Activator.CreateInstance(authorType!!)
                Assert.NotNull(author)
                let nameProperty PropertyInfo? = authorType!!.GetProperty("Name")
                let booksProperty PropertyInfo? = authorType!!.GetProperty("Books")
                Assert.NotNull(nameProperty)
                Assert.NotNull(booksProperty)
                let books = Assert.IsAssignableFrom[IList[string]](booksProperty!!.GetValue(author))
                Assert.Empty(books)
                Assert.Equal("Ada", read!!.MakeGenericMethod(authorType!!).Invoke(nil, []object{author}))
                write!!.MakeGenericMethod(authorType!!).Invoke(nil, []object{author, "Grace", "G# book"})
                Assert.Equal("Grace", nameProperty!!.GetValue(author))
                Assert.Equal("G# book", Assert.Single(books))
                Assert.Equal("Grace", read!!.MakeGenericMethod(authorType!!).Invoke(nil, []object{author}))
                Assert.Equal("Grace", test!!.Invoke(nil, []object{author}))
            } finally {
                context.Unload()
            }
        }

        private func WriteFixture(sourceRoot string)(ContractsProject string, ConsumerProject string) {
            File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
            let contractsDirectory = Path.Combine(sourceRoot, "Contracts")
            Directory.CreateDirectory(contractsDirectory)
            let contractsProject = Path.Combine(contractsDirectory, "Contracts.csproj")
            File.WriteAllText(contractsProject, ProjectFile(nil))
            File.WriteAllText(Path.Combine(contractsDirectory, "Contracts.cs"), `using System.Collections.Generic;

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
}`)
            let consumerDirectory = Path.Combine(sourceRoot, "Consumer")
            Directory.CreateDirectory(consumerDirectory)
            let consumerProject = Path.Combine(consumerDirectory, "Consumer.csproj")
            File.WriteAllText(consumerProject, ProjectFile("../Contracts/Contracts.csproj"))
            File.WriteAllText(Path.Combine(consumerDirectory, "Repro.cs"), `using Issue2514.Contracts;

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
}`)
            return (contractsProject, consumerProject)
        }

        private func ProjectFile(projectReference string?) string {
            let reference = if projectReference == nil {
                string.Empty
            } else {
                (`
  <ItemGroup>
    <ProjectReference Include="` + "$projectReference" + `" />
  </ItemGroup>`)
            }
            return (`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>` + "$reference" + `
</Project>`)
        }

        private func NewDirectory(category string) string {
            return Directory.CreateTempSubdirectory("issue2514_" + category + "_").FullName
        }

        private func FindSiblingTool(projectDirectoryName string, dllName string) string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(
                        directory.FullName,
                        "out",
                        "bin",
                        configuration,
                        projectDirectoryName,
                        dllName
                    )
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
