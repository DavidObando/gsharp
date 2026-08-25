// <copyright file="Adr0169AnalyzerProjectTransformTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0169 / docs/cs2gs-analyzer-translation.md §Project transform: a Roslyn
/// analyzer csproj retargets netstandard2.0 → net10.0, drops the
/// Microsoft.CodeAnalysis packages and Roslyn-authoring properties, and gains
/// a G# analyzer-API reference; a consumer's
/// <c>OutputItemType="Analyzer"</c> wiring becomes
/// dropped analyzer wiring (until the analyzer translation lands).
/// </summary>
public sealed class Adr0169AnalyzerProjectTransformTests : IDisposable
{
    private readonly DirectoryInfo root = Directory.CreateTempSubdirectory("cs2gs-analyzer-transform");

    public void Dispose()
    {
        try
        {
            root.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void AnalyzerProject_RetargetsAndDropsRoslynAuthoringShape()
    {
        string projectPath = Write("Analyzers.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
    <NoWarn>RS1036;CA1000</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include=""Microsoft.CodeAnalysis.CSharp"" Version=""5.6.0"" PrivateAssets=""all"" />
  </ItemGroup>
</Project>");

        XDocument transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());

        string xml = transformed.ToString();
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("EnforceExtendedAnalyzerRules", xml, StringComparison.Ordinal);
        Assert.DoesNotContain("Microsoft.CodeAnalysis.CSharp", xml, StringComparison.Ordinal);
        Assert.Contains("$(GsharpAnalyzerApiProject)", xml, StringComparison.Ordinal);

        // RS suppressions drop; unrelated suppressions survive.
        Assert.DoesNotContain("RS1036", xml, StringComparison.Ordinal);
        Assert.Contains("<NoWarn>CA1000</NoWarn>", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void ConsumerAnalyzerWiring_DropsTheReferenceUntilTranslationLands()
    {
        // Issue #3501: the cs2gs analyzer-API translation is designed but not
        // built, so the migrated analyzer assembly carries no
        // [GSharpDiagnosticAnalyzer] types and wiring it fails every consumer
        // build (GS9301). Restore the GsharpCodeAnalyzer rewrite once the
        // translation exists.
        string projectPath = Write("Consumer.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\Analyzers\Analyzers.csproj"" OutputItemType=""Analyzer"" ReferenceOutputAssembly=""false"" PrivateAssets=""all"" />
  </ItemGroup>
</Project>");

        XDocument transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());

        Assert.DoesNotContain(
            transformed.Descendants(),
            element => element.Name.LocalName == "ProjectReference");
    }

    [Fact]
    public void NonAnalyzerProject_KeepsItsTargetFramework()
    {
        string projectPath = Write("Plain.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
  </PropertyGroup>
</Project>");

        XDocument transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());

        Assert.Contains("<TargetFramework>netstandard2.0</TargetFramework>", transformed.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("GsharpAnalyzerApiProject", transformed.ToString(), StringComparison.Ordinal);
    }

    private string Write(string fileName, string content)
    {
        string path = Path.Combine(root.FullName, fileName);
        File.WriteAllText(path, content);
        return path;
    }
}
