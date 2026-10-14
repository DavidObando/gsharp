// <copyright file="CrossAssemblyNavigationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import System
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Security.Cryptography
import System.Text
import System.Threading.Tasks
import GSharp.LanguageServer.Protocol
import GSharp.LanguageServer.Server
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import Xunit
import Xunit.Abstractions
import Xunit.Sdk
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.LanguageServer
import Microsoft.CodeAnalysis.Text

/// Regression coverage for cross-assembly Go-to-Definition (Tier 2, portable-PDB
/// navigation) and for CodeLens in a real project context. These exercise the exact
/// "navigate to a C# type/member in the same solution" and "reference lenses" features.
/// The imported contract is compiled from C# source data with Roslyn, independently
/// of the language used to build Core or this test harness.
open class CrossAssemblyNavigationTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func Tier2_PdbNavigation_ResolvesCSharpCompiledTypeToSource() {
        using let fixture = NativeNavigationFixture()
        AssertPdbNavigation(fixture)
    }

    @Fact
    func GoToDefinition_OnCSharpTypeReferencedFromGsharp_NavigatesToSource() {
        using let fixture = NativeNavigationFixture()
        AssertDefinitionNavigation(fixture)
    }

    @Theory
    @InlineData(false, ".cs")
    @InlineData(true, ".gs")
    func NativeNavigationOracle_RejectsMissingPdbOrMigratedSource(keepPdb bool, sourceExtension string) {
        using let fixture = NativeNavigationFixture(sourceExtension)
        if !keepPdb {
            File.Delete(fixture.PdbPath)
        }
        // Run the same real navigators and final oracles as the positive cases.
        // A matching type name in a .gs document is not native C# navigation.
        let pdbFailure = Record.Exception(() -> AssertPdbNavigation(fixture))!!
        let definitionFailure = Record.Exception(() -> AssertDefinitionNavigation(fixture))!!
        for failure in[]Exception{pdbFailure, definitionFailure} {
            if keepPdb {
                let pathFailure = Assert.IsType[EqualException](failure)
                Assert.Contains("NativeType.cs", pathFailure.Message)
                Assert.Contains("NativeType.gs", pathFailure.Message)
            } else {
                let missingPdbFailure = Assert.IsType[TrueException](failure)
                Assert.Contains("Required native portable PDB is missing", missingPdbFailure.Message)
            }
            output.WriteLine("Rejected fixture keepPdb=$keepPdb extension=$sourceExtension: $failure")
        }
    }

    private func AssertPdbNavigation(fixture NativeNavigationFixture) {
        let assembly = EmittedFixture.Load(fixture.AssemblyPath)
        let type Type? = assembly.GetType("NavigationFixture.NativeType", throwOnError: true)
        Assert.NotNull(type)
        Assert.True(type!!.IsPublic)
        Assert.Equal(0x02000002, type!!.MetadataToken)
        let ok = PdbSourceLocator.TryGetTypeSourceLocation(fixture.AssemblyPath, type!!.MetadataToken, out var loc)
        output.WriteLine(
            "PdbSourceLocator assembly=${fixture.AssemblyPath} type=${type!!.FullName} token=0x${type!!.MetadataToken:X8} resolved=$ok location=$loc"
        )
        AssertPortablePdb(fixture)
        Assert.True(ok, "Tier-2 PDB navigation should resolve a C#-compiled type to source.")
        Assert.Equal(fixture.ExpectedSourcePath, loc.FilePath)
        Assert.Equal((5, 9, 5, 28), (loc.StartLine, loc.StartColumn, loc.EndLine, loc.EndColumn))
    }

    private func AssertDefinitionNavigation(fixture NativeNavigationFixture) {
        const source = `import NavigationFixture

func F(s NativeType) {
}
`
        let gsPath = Path.Combine(fixture.Root, "Consumer.gs")
        File.WriteAllText(gsPath, source)
        let project = ProjectState(Path.Combine(fixture.Root, "Consumer.gsproj"))
        project.References = []string{fixture.AssemblyPath}
        project.UpdateFile(gsPath, source)
        let tree = GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SyntaxTree
            .Parse(GSharp.Core.CodeAnalysis.Text.SourceText.From(source, gsPath))
        let lines = Enumerable.Range(0, source.Length).Where((i int32) -> source[i] == '\n').ToList()
        let content = DocumentContent(tree, lines, project, WorkspaceState())
        let uri = DocumentUri.FromFileSystemPath(gsPath)!!
        let loc GSharp.LanguageServer.Protocol.Location? = DefinitionComputer.ComputeDefinition(
            uri,
            content,
            LanguageServerTestHelpers.PositionOf(source, "NativeType")
        )
        output.WriteLine(
            "DefinitionComputer consumer=$gsPath reference=${Assert.Single(project.References)} position=2:9 location=${loc?.Uri!!.GetFileSystemPath()} range=${loc?.Range.Start.Line}:${loc?.Range.Start.Character}-${loc?.Range.End.Line}:${loc?.Range.End.Character}"
        )
        AssertPortablePdb(fixture)
        Assert.NotNull(loc)
        Assert.Equal(fixture.ExpectedSourcePath, loc!!.Uri!!.GetFileSystemPath())
        Assert.Equal(
            (4, 8, 4, 27),
            (loc!!.Range.Start.Line, loc!!.Range.Start.Character, loc!!.Range.End.Line, loc!!.Range.End.Character)
        )
    }

    private func AssertPortablePdb(fixture NativeNavigationFixture) {
        output.WriteLine(
            "Native fixture Roslyn=${typeof(CSharpCompilation).Assembly.GetName().Version} source=${fixture.SourcePath} sourceSha256=${Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.SourcePath)))} assembly=${fixture.AssemblyPath} assemblySha256=${Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.AssemblyPath)))} pdb=${fixture.PdbPath} pdbExists=${File.Exists(fixture.PdbPath)}"
        )
        Assert.True(File.Exists(fixture.PdbPath), "Required native portable PDB is missing: ${fixture.PdbPath}")
        using let stream = File.OpenRead(fixture.PdbPath)
        using let provider = MetadataReaderProvider.FromPortablePdbStream(stream)
        let reader = provider.GetMetadataReader()
        let document = reader.GetDocument(Assert.Single(reader.Documents))
        let documentPath = reader.GetString(document.Name)
        let language = reader.GetGuid(document.Language)
        output.WriteLine(
            "Portable PDB sha256=${Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(fixture.PdbPath)))} document=$documentPath language=$language"
        )
        Assert.Equal(fixture.SourcePath, documentPath)
        Assert.Equal(Guid("3f5162f8-07c6-11d3-9053-00c04fa302a1"), language)
        Assert.Equal(Guid("8829d00f-11b8-4213-878b-770e8597ac16"), reader.GetGuid(document.HashAlgorithm))
        Assert.Equal(SHA256.HashData(File.ReadAllBytes(fixture.SourcePath)), reader.GetBlobBytes(document.Hash))
    }

    @Fact
    async func CodeLens_InProjectContext_ReturnsReferenceLenses() {
        let rootDir = Path.Combine(Path.GetTempPath(), "gscl_" + Guid.NewGuid().ToString("N"))
        let projDir = Path.Combine(rootDir, "Demo")
        Directory.CreateDirectory(projDir)
        try {
            File.WriteAllText(Path.Combine(projDir, "Demo.gsproj"), `<Project Sdk="Gsharp.NET.Sdk">
  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>
</Project>
`)
            const source = `package Demo

class Rect {
    prop Width int32
    prop Height int32
    func Area() int32 { return Width * Height }
}

class User {
    func Make() Rect { return Rect() }
}
`
            let gsPath = Path.Combine(projDir, "Rect.gs")
            File.WriteAllText(gsPath, source)
            let workspace = WorkspaceState()
            WorkspaceInitializer.Initialize(workspace, rootDir)
            let server = LspServer(DocumentContentService(), workspace)
            let uri = DocumentUri.FromFileSystemPath(gsPath)!!
            await server.DidOpenAsync(DidOpenTextDocumentParams{TextDocument: TextDocumentItem{Uri: uri, Text: source}})
            let lenses = await server.CodeLensAsync(CodeLensParams{TextDocument: TextDocumentIdentifier{Uri: uri}})
            Assert.NotNull(lenses)
            Assert.NotEmpty(lenses)
            // The Rect class declaration carries a reference lens (referenced by User.Make).
            Assert.Contains(lenses, (l CodeLens) -> l.Command != nil && l.Command!!.Title.Contains("reference"))
        } finally {
            try {
                Directory.Delete(rootDir, recursive: true)
            } catch { }
        }
    }

    private class NativeNavigationFixture : IDisposable {
        init(sourceExtension string = ".cs") {
            Root = Path.Combine(Directory.GetCurrentDirectory(), "native-navigation-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(Root)
            SourcePath = Path.Combine(Root, "NativeType" + sourceExtension)
            AssemblyPath = Path.Combine(Root, "NativeNavigation.dll")
            PdbPath = Path.ChangeExtension(AssemblyPath, ".pdb")
            try {
                File.WriteAllText(SourcePath, NativeSource, UTF8Encoding(false))
                let source = Microsoft
                    .CodeAnalysis
                    .Text
                    .SourceText
                    .From(NativeSource, UTF8Encoding(false), SourceHashAlgorithm.Sha256)
                let compilation = CSharpCompilation.Create(
                    "NativeNavigation",
                    []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source, path: SourcePath)},
                    []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                    CSharpCompilationOptions(
                        OutputKind.DynamicallyLinkedLibrary,
                        optimizationLevel: OptimizationLevel.Debug
                    )
                )
                using let assemblyStream = File.Create(AssemblyPath)
                using let pdbStream = File.Create(PdbPath)
                let result = compilation.Emit(
                    assemblyStream,
                    pdbStream,
                    options: EmitOptions(
                        debugInformationFormat: DebugInformationFormat.PortablePdb,
                        pdbFilePath: PdbPath
                    )
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            } catch {
                Dispose()
                rethrow
            }
        }

        prop Root string {
            get;
        }

        prop SourcePath string {
            get;
        }

        prop ExpectedSourcePath string -> Path.Combine(Root, "NativeType.cs")

        prop AssemblyPath string {
            get;
        }

        prop PdbPath string {
            get;
        }

        func Dispose() -> Directory.Delete(Root, recursive: true)

        shared {
            private const NativeSource string = `namespace NavigationFixture
{
    public class NativeType
    {
        public NativeType()
        {
        }
    }
}
`
        }
    }
}
