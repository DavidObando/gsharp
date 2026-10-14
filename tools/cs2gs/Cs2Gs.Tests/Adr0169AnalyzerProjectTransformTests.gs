// <copyright file="Adr0169AnalyzerProjectTransformTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit

/// ADR-0169 / docs/cs2gs-analyzer-translation.md §Project transform: a Roslyn
/// analyzer csproj retargets netstandard2.0 → net10.0, drops the
/// Microsoft.CodeAnalysis packages and Roslyn-authoring properties, and gains
/// a G# analyzer-API reference; a consumer's
/// `OutputItemType="Analyzer"` wiring becomes
/// `OutputItemType="GsharpCodeAnalyzer"`.
class Adr0169AnalyzerProjectTransformTests : IDisposable {
    private let root DirectoryInfo = Directory.CreateTempSubdirectory("cs2gs-analyzer-transform")

    func Dispose() {
        try {
            root.Delete(recursive: true)
        } catch (IOException) { }
    }

    @Fact
    func AnalyzerProject_RetargetsAndDropsRoslynAuthoringShape() {
        let projectPath = Write("Analyzers.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
    <NoWarn>RS1036;CA1000</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        let xml = transformed.ToString()
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", xml, StringComparison.Ordinal)
        Assert.DoesNotContain("EnforceExtendedAnalyzerRules", xml, StringComparison.Ordinal)
        Assert.DoesNotContain("Microsoft.CodeAnalysis.CSharp", xml, StringComparison.Ordinal)
        Assert.Contains("<Reference Include=\"GSharp.Core\">", xml, StringComparison.Ordinal)
        Assert.Contains("$$(GsharpCompilerFullPath)", xml, StringComparison.Ordinal)
        // RS suppressions drop; unrelated suppressions survive.
        Assert.DoesNotContain("RS1036", xml, StringComparison.Ordinal)
        Assert.Contains("<NoWarn>CA1000</NoWarn>", xml, StringComparison.Ordinal)
    }

    @Fact
    func AnalyzerProject_PrivateRoslynPackageMarkerSurvivesEvaluatedProjection() {
        let projectPath = Write("ProjectedAnalyzer.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="5.6.0" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        let xml = transformed.ToString()
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", xml, StringComparison.Ordinal)
        Assert.DoesNotContain("Microsoft.CodeAnalysis.CSharp", xml, StringComparison.Ordinal)
        Assert.Contains("<Reference Include=\"GSharp.Core\">", xml, StringComparison.Ordinal)
    }

    @Fact
    func ConsumerAnalyzerWiring_RetainsReferenceWithGSharpItemType() {
        let projectPath = Write("Consumer.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\Analyzers\Analyzers.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" PrivateAssets="all" />
  </ItemGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        let reference = Assert.Single(
            transformed.Descendants(),
            (element XElement) -> element.Name.LocalName == "ProjectReference"
        )
        Assert.Equal("GsharpCodeAnalyzer", reference.Attribute(XName?("OutputItemType")!!)?.Value)
        Assert.Equal("..\\Analyzers\\Analyzers.csproj", reference.Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("false", reference.Attribute(XName?("ReferenceOutputAssembly")!!)?.Value)
        Assert.Equal("all", reference.Attribute(XName?("PrivateAssets")!!)?.Value)
    }

    @Fact
    func NonAnalyzerProject_KeepsItsTargetFramework() {
        let projectPath = Write("Plain.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
  </PropertyGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        Assert.Contains(
            "<TargetFramework>netstandard2.0</TargetFramework>",
            transformed.ToString(),
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("<Reference Include=\"GSharp.Core\">", transformed.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func AnalyzerProject_CompilerHostedReferenceResolvesAgainstGscDirectory() {
        // Issue #3608: the injected GSharp.Core reference is anchored at the
        // compiler's directory with Private=false, so stage 3 must be able to
        // resolve it against a concrete gsc path for ilverify's reference set.
        let projectPath = Write("Analyzers.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
</Project>`)
        let transformed = GSharpProjectTransformer.Transform(
            projectPath,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        let gsprojPath = Path.Combine(root.FullName, "Analyzers.gsproj")
        transformed.Save(gsprojPath)
        let compilerDir = Path.Combine(root.FullName, "compiler")
        Directory.CreateDirectory(compilerDir)
        let gscPath = Path.Combine(compilerDir, "gsc.dll")
        File.WriteAllText(gscPath, string.Empty)
        let coreDll = Path.Combine(compilerDir, "GSharp.Core.dll")
        File.WriteAllText(coreDll, string.Empty)
        let resolved = GSharpProjectTransformer.ResolveCompilerHostedReferences(gsprojPath, gscPath)
        let single = Assert.Single(resolved)
        Assert.Equal(Path.GetFullPath(coreDll), single)
    }

    @Fact
    func CompilerHostedReferences_MissingAssemblyOrPlainProject_ResolveEmpty() {
        // A gsc directory without the hosted assembly resolves to nothing (no
        // phantom -r paths), as does a project with no compiler-hosted refs.
        let analyzerProject = Write("Analyzers.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
</Project>`)
        let analyzerTransformed = GSharpProjectTransformer.Transform(
            analyzerProject,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        let analyzerGsproj = Path.Combine(root.FullName, "Analyzers.gsproj")
        analyzerTransformed.Save(analyzerGsproj)
        let emptyCompilerDir = Path.Combine(root.FullName, "compiler-empty")
        Directory.CreateDirectory(emptyCompilerDir)
        let gscPath = Path.Combine(emptyCompilerDir, "gsc.dll")
        File.WriteAllText(gscPath, string.Empty)
        Assert.Empty(GSharpProjectTransformer.ResolveCompilerHostedReferences(analyzerGsproj, gscPath))
        let plainProject = Write("Plain2.csproj", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>`)
        let plainTransformed = GSharpProjectTransformer.Transform(
            plainProject,
            root.FullName,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        let plainGsproj = Path.Combine(root.FullName, "Plain2.gsproj")
        plainTransformed.Save(plainGsproj)
        Assert.Empty(GSharpProjectTransformer.ResolveCompilerHostedReferences(plainGsproj, gscPath))
    }

    private func Write(fileName string, content string) string {
        let path = Path.Combine(root.FullName, fileName)
        File.WriteAllText(path, content)
        return path
    }
}
