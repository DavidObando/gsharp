// <copyright file="CrossAssemblyNavigationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// Regression coverage for cross-assembly Go-to-Definition (Tier 2, portable-PDB
/// navigation) and for CodeLens in a real project context. These exercise the exact
/// "navigate to a C# type/member in the same solution" and "reference lenses" features.
/// The imported contract is compiled from C# source data with Roslyn, independently
/// of the language used to build Core or this test harness.
/// </summary>
public class CrossAssemblyNavigationTests
{
    private readonly ITestOutputHelper output;

    public CrossAssemblyNavigationTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Tier2_PdbNavigation_ResolvesCSharpCompiledTypeToSource()
    {
        using var fixture = new NativeNavigationFixture();
        AssertPdbNavigation(fixture);
    }

    [Fact]
    public void GoToDefinition_OnCSharpTypeReferencedFromGsharp_NavigatesToSource()
    {
        using var fixture = new NativeNavigationFixture();
        AssertDefinitionNavigation(fixture);
    }

    [Theory]
    [InlineData(false, ".cs")]
    [InlineData(true, ".gs")]
    public void NativeNavigationOracle_RejectsMissingPdbOrMigratedSource(bool keepPdb, string sourceExtension)
    {
        using var fixture = new NativeNavigationFixture(sourceExtension);
        if (!keepPdb)
        {
            File.Delete(fixture.PdbPath);
        }

        // Run the same real navigators and final oracles as the positive cases.
        // A matching type name in a .gs document is not native C# navigation.
        var pdbFailure = Record.Exception(() => AssertPdbNavigation(fixture));
        var definitionFailure = Record.Exception(() => AssertDefinitionNavigation(fixture));
        foreach (var failure in new[] { pdbFailure, definitionFailure })
        {
            if (keepPdb)
            {
                var pathFailure = Assert.IsType<EqualException>(failure);
                Assert.Contains("NativeType.cs", pathFailure.Message);
                Assert.Contains("NativeType.gs", pathFailure.Message);
            }
            else
            {
                var missingPdbFailure = Assert.IsType<TrueException>(failure);
                Assert.Contains("Required native portable PDB is missing", missingPdbFailure.Message);
            }

            output.WriteLine($"Rejected fixture keepPdb={keepPdb} extension={sourceExtension}: {failure}");
        }
    }

    private void AssertPdbNavigation(NativeNavigationFixture fixture)
    {
        var assembly = EmittedFixture.Load(fixture.AssemblyPath);
        var type = assembly.GetType("NavigationFixture.NativeType", throwOnError: true);
        Assert.NotNull(type);
        Assert.True(type.IsPublic);
        Assert.Equal(0x02000002, type.MetadataToken);
        var ok = PdbSourceLocator.TryGetTypeSourceLocation(fixture.AssemblyPath, type.MetadataToken, out var loc);
        output.WriteLine($"PdbSourceLocator assembly={fixture.AssemblyPath} type={type.FullName} token=0x{type.MetadataToken:X8} resolved={ok} location={loc}");

        AssertPortablePdb(fixture);
        Assert.True(ok, "Tier-2 PDB navigation should resolve a C#-compiled type to source.");
        Assert.Equal(fixture.ExpectedSourcePath, loc.FilePath);
        Assert.Equal((5, 9, 5, 28), (loc.StartLine, loc.StartColumn, loc.EndLine, loc.EndColumn));
    }

    private void AssertDefinitionNavigation(NativeNavigationFixture fixture)
    {
        const string source = "import NavigationFixture\n\nfunc F(s NativeType) {\n}\n";
        var gsPath = Path.Combine(fixture.Root, "Consumer.gs");
        File.WriteAllText(gsPath, source);
        var project = new ProjectState(Path.Combine(fixture.Root, "Consumer.gsproj"));
        project.References = new[] { fixture.AssemblyPath };
        project.UpdateFile(gsPath, source);
        var tree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(
            GSharp.Core.CodeAnalysis.Text.SourceText.From(source, gsPath));
        var lines = Enumerable.Range(0, source.Length).Where(i => source[i] == '\n').ToList();
        var content = new DocumentContent(tree, lines, project, new WorkspaceState());
        var uri = DocumentUri.FromFileSystemPath(gsPath);

        var loc = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "NativeType"));
        output.WriteLine($"DefinitionComputer consumer={gsPath} reference={Assert.Single(project.References)} position=2:9 location={loc?.Uri.GetFileSystemPath()} range={loc?.Range.Start.Line}:{loc?.Range.Start.Character}-{loc?.Range.End.Line}:{loc?.Range.End.Character}");

        AssertPortablePdb(fixture);
        Assert.NotNull(loc);
        Assert.Equal(fixture.ExpectedSourcePath, loc.Uri.GetFileSystemPath());
        Assert.Equal((4, 8, 4, 27), (loc.Range.Start.Line, loc.Range.Start.Character, loc.Range.End.Line, loc.Range.End.Character));
    }

    private void AssertPortablePdb(NativeNavigationFixture fixture)
    {
        output.WriteLine($"Native fixture Roslyn={typeof(CSharpCompilation).Assembly.GetName().Version} source={fixture.SourcePath} sourceSha256={Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.SourcePath)))} assembly={fixture.AssemblyPath} assemblySha256={Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.AssemblyPath)))} pdb={fixture.PdbPath} pdbExists={File.Exists(fixture.PdbPath)}");
        Assert.True(File.Exists(fixture.PdbPath), $"Required native portable PDB is missing: {fixture.PdbPath}");
        using var stream = File.OpenRead(fixture.PdbPath);
        using var provider = MetadataReaderProvider.FromPortablePdbStream(stream);
        var reader = provider.GetMetadataReader();
        var document = reader.GetDocument(Assert.Single(reader.Documents));
        var documentPath = reader.GetString(document.Name);
        var language = reader.GetGuid(document.Language);
        output.WriteLine($"Portable PDB sha256={Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.PdbPath)))} document={documentPath} language={language}");
        Assert.Equal(fixture.SourcePath, documentPath);
        Assert.Equal(new Guid("3f5162f8-07c6-11d3-9053-00c04fa302a1"), language);
        Assert.Equal(new Guid("8829d00f-11b8-4213-878b-770e8597ac16"), reader.GetGuid(document.HashAlgorithm));
        Assert.Equal(SHA256.HashData(File.ReadAllBytes(fixture.SourcePath)), reader.GetBlobBytes(document.Hash));
    }

    [Fact]
    public async Task CodeLens_InProjectContext_ReturnsReferenceLenses()
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gscl_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);
        try
        {
            File.WriteAllText(
                Path.Combine(projDir, "Demo.gsproj"),
                "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

            const string source = "package Demo\n\nclass Rect {\n    prop Width int32\n    prop Height int32\n    func Area() int32 { return Width * Height }\n}\n\nclass User {\n    func Make() Rect { return Rect() }\n}\n";
            var gsPath = Path.Combine(projDir, "Rect.gs");
            File.WriteAllText(gsPath, source);

            var workspace = new WorkspaceState();
            WorkspaceInitializer.Initialize(workspace, rootDir);
            var server = new LspServer(new DocumentContentService(), workspace);
            var uri = DocumentUri.FromFileSystemPath(gsPath);
            await server.DidOpenAsync(new DidOpenTextDocumentParams
            {
                TextDocument = new TextDocumentItem { Uri = uri, Text = source },
            });

            var lenses = await server.CodeLensAsync(new CodeLensParams { TextDocument = new TextDocumentIdentifier { Uri = uri } });

            Assert.NotNull(lenses);
            Assert.NotEmpty(lenses);
            // The Rect class declaration carries a reference lens (referenced by User.Make).
            Assert.Contains(lenses, l => l.Command != null && l.Command.Title.Contains("reference"));
        }
        finally
        {
            try { Directory.Delete(rootDir, recursive: true); } catch { }
        }
    }

    private sealed class NativeNavigationFixture : IDisposable
    {
        private const string NativeSource = "namespace NavigationFixture\n{\n    public class NativeType\n    {\n        public NativeType()\n        {\n        }\n    }\n}\n";

        public NativeNavigationFixture(string sourceExtension = ".cs")
        {
            Root = Path.Combine(Directory.GetCurrentDirectory(), "native-navigation-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Root);
            SourcePath = Path.Combine(Root, "NativeType" + sourceExtension);
            AssemblyPath = Path.Combine(Root, "NativeNavigation.dll");
            PdbPath = Path.ChangeExtension(AssemblyPath, ".pdb");
            try
            {
                File.WriteAllText(SourcePath, NativeSource, new UTF8Encoding(false));
                var source = Microsoft.CodeAnalysis.Text.SourceText.From(NativeSource, new UTF8Encoding(false), Microsoft.CodeAnalysis.Text.SourceHashAlgorithm.Sha256);
                var compilation = CSharpCompilation.Create(
                    "NativeNavigation",
                    new[] { CSharpSyntaxTree.ParseText(source, path: SourcePath) },
                    new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Debug));
                using var assemblyStream = File.Create(AssemblyPath);
                using var pdbStream = File.Create(PdbPath);
                var result = compilation.Emit(
                    assemblyStream,
                    pdbStream,
                    options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb, pdbFilePath: PdbPath));
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public string Root { get; }

        public string SourcePath { get; }

        public string ExpectedSourcePath => Path.Combine(Root, "NativeType.cs");

        public string AssemblyPath { get; }

        public string PdbPath { get; }

        public void Dispose() => Directory.Delete(Root, recursive: true);
    }
}
