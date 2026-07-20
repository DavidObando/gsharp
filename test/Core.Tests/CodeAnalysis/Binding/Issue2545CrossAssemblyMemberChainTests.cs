// <copyright file="Issue2545CrossAssemblyMemberChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2545CrossAssemblyMemberChainTests
{
    [Fact]
    public void ImportedProjectTypes_MultiHopPropertiesAndFields_ReadAndWrite()
    {
        var libraryPath = EmitCSharpLibrary();
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Issue2545.Consumer
                import Issue2545.Library

                func Read(settings Settings) string ->
                    settings.DownloadSettings.Profile.Name +
                    settings.FieldDownload.FieldProfile.FieldName

                func Write(settings Settings, profile Profile, value string) {
                    settings.DownloadSettings.Profile = profile
                    settings.DownloadSettings.Profile.Name = value
                    settings.FieldDownload.FieldProfile = profile
                    settings.FieldDownload.FieldProfile.FieldName = value
                }
                """)));

        using var stream = new MemoryStream();
        var result = consumer.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2545.Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ImportedProjectTypes_HidingStillSelectsDerivedMembers()
    {
        var libraryPath = EmitCSharpLibrary();
        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Issue2545.Consumer
                import Issue2545.Library

                func Read(settings Settings) string? -> settings.Hidden.Value

                func Write(settings Settings, value string) {
                    settings.Hidden.Value = value
                }
                """)));

        using var stream = new MemoryStream();
        var result = consumer.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2545.Consumer");

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string EmitCSharpLibrary()
    {
        const string source = """
            namespace Issue2545.Library;

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
            }
            """;

        var outputDirectory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2545CrossAssemblyMemberChainTests));
        Directory.CreateDirectory(outputDirectory);
        var libraryPath = Path.Combine(outputDirectory, "Issue2545.Library.dll");
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue2545.Library",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
