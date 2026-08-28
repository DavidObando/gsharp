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
/// <c>OutputItemType="GsharpCodeAnalyzer"</c>.
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
        Assert.Contains("<Reference Include=\"GSharp.Core\">", xml, StringComparison.Ordinal);
        Assert.Contains("$(GsharpCompilerFullPath)", xml, StringComparison.Ordinal);

        // RS suppressions drop; unrelated suppressions survive.
        Assert.DoesNotContain("RS1036", xml, StringComparison.Ordinal);
        Assert.Contains("<NoWarn>CA1000</NoWarn>", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void AnalyzerProject_PrivateRoslynPackageMarkerSurvivesEvaluatedProjection()
    {
        string projectPath = Write("ProjectedAnalyzer.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
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
        Assert.DoesNotContain("Microsoft.CodeAnalysis.CSharp", xml, StringComparison.Ordinal);
        Assert.Contains("<Reference Include=\"GSharp.Core\">", xml, StringComparison.Ordinal);
    }

    [Fact]
    public void ConsumerAnalyzerWiring_RetainsReferenceWithGSharpItemType()
    {
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

        XElement reference = Assert.Single(
            transformed.Descendants(),
            element => element.Name.LocalName == "ProjectReference");
        Assert.Equal("GsharpCodeAnalyzer", reference.Attribute("OutputItemType")?.Value);
        Assert.Equal(@"..\Analyzers\Analyzers.csproj", reference.Attribute("Include")?.Value);
        Assert.Equal("false", reference.Attribute("ReferenceOutputAssembly")?.Value);
        Assert.Equal("all", reference.Attribute("PrivateAssets")?.Value);
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
        Assert.DoesNotContain("<Reference Include=\"GSharp.Core\">", transformed.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void AnalyzerProject_CompilerHostedReferenceResolvesAgainstGscDirectory()
    {
        // Issue #3608: the injected GSharp.Core reference is anchored at the
        // compiler's directory with Private=false, so stage 3 must be able to
        // resolve it against a concrete gsc path for ilverify's reference set.
        string projectPath = Write("Analyzers.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
</Project>");

        XDocument transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());
        string gsprojPath = Path.Combine(root.FullName, "Analyzers.gsproj");
        transformed.Save(gsprojPath);

        string compilerDir = Path.Combine(root.FullName, "compiler");
        Directory.CreateDirectory(compilerDir);
        string gscPath = Path.Combine(compilerDir, "gsc.dll");
        File.WriteAllText(gscPath, string.Empty);
        string coreDll = Path.Combine(compilerDir, "GSharp.Core.dll");
        File.WriteAllText(coreDll, string.Empty);

        IReadOnlyList<string> resolved =
            GSharpProjectTransformer.ResolveCompilerHostedReferences(gsprojPath, gscPath);

        string single = Assert.Single(resolved);
        Assert.Equal(Path.GetFullPath(coreDll), single);
    }

    [Fact]
    public void CompilerHostedReferences_MissingAssemblyOrPlainProject_ResolveEmpty()
    {
        // A gsc directory without the hosted assembly resolves to nothing (no
        // phantom -r paths), as does a project with no compiler-hosted refs.
        string analyzerProject = Write("Analyzers.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
</Project>");
        XDocument analyzerTransformed = GSharpProjectTransformer.Transform(
            analyzerProject, root.FullName, "Gsharp.NET.Sdk", new Dictionary<string, string>());
        string analyzerGsproj = Path.Combine(root.FullName, "Analyzers.gsproj");
        analyzerTransformed.Save(analyzerGsproj);

        string emptyCompilerDir = Path.Combine(root.FullName, "compiler-empty");
        Directory.CreateDirectory(emptyCompilerDir);
        string gscPath = Path.Combine(emptyCompilerDir, "gsc.dll");
        File.WriteAllText(gscPath, string.Empty);

        Assert.Empty(GSharpProjectTransformer.ResolveCompilerHostedReferences(analyzerGsproj, gscPath));

        string plainProject = Write("Plain2.csproj", @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>");
        XDocument plainTransformed = GSharpProjectTransformer.Transform(
            plainProject, root.FullName, "Gsharp.NET.Sdk", new Dictionary<string, string>());
        string plainGsproj = Path.Combine(root.FullName, "Plain2.gsproj");
        plainTransformed.Save(plainGsproj);

        Assert.Empty(GSharpProjectTransformer.ResolveCompilerHostedReferences(plainGsproj, gscPath));
    }

    private string Write(string fileName, string content)
    {
        string path = Path.Combine(root.FullName, fileName);
        File.WriteAllText(path, content);
        return path;
    }
}
