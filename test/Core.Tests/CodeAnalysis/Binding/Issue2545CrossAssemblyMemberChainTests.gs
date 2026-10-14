// <copyright file="Issue2545CrossAssemblyMemberChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import Xunit

class Issue2545CrossAssemblyMemberChainTests {
    @Fact
    func ImportedProjectTypes_MultiHopPropertiesAndFields_ReadAndWrite() {
        let libraryPath = EmitCSharpLibrary()
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Issue2545.Consumer
import Issue2545.Library

func Read(settings Settings) string ->
    settings.DownloadSettings.Profile.Name +
    settings.FieldDownload.FieldProfile.FieldName

func Write(settings Settings, profile Profile, value string) {
    settings.DownloadSettings.Profile = profile
    settings.DownloadSettings.Profile.Name = value
    settings.FieldDownload.FieldProfile = profile
    settings.FieldDownload.FieldProfile.FieldName = value
}`)))
        using let stream = MemoryStream()
        let result = consumer.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2545.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ImportedProjectTypes_HidingStillSelectsDerivedMembers() {
        let libraryPath = EmitCSharpLibrary()
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package Issue2545.Consumer
import Issue2545.Library

func Read(settings Settings) string? -> settings.Hidden.Value

func Write(settings Settings, value string) {
    settings.Hidden.Value = value
}`)))
        using let stream = MemoryStream()
        let result = consumer.Emit(stream, pdbStream: nil, refStream: nil, assemblyName: "Issue2545.Consumer")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    shared {
        private func EmitCSharpLibrary() string {
            const source = `namespace Issue2545.Library;

public sealed class Profile
{
    public string Name { get; set; } = "";
    public string FieldName = "";
}

public sealed class DownloadSettings
{
    public Profile Profile { get; set; } = new();
    public Profile FieldProfile = new();
}

public class BaseSettings
{
    public object Value { get; set; } = new();
}

public sealed class DerivedSettings : BaseSettings
{
    public new string Value { get; set; } = "";
}

public sealed class Settings
{
    public DownloadSettings DownloadSettings { get; set; } = new();
    public DownloadSettings FieldDownload = new();
    public DerivedSettings Hidden { get; set; } = new();
}`
            let outputDirectory = Path.Combine(AppContext.BaseDirectory, "Issue2545CrossAssemblyMemberChainTests")
            Directory.CreateDirectory(outputDirectory)
            let libraryPath = Path.Combine(outputDirectory, "Issue2545.Library.dll")
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Issue2545.Library",
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(libraryPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return libraryPath
        }
    }
}
