// <copyright file="Issue3846EvaluatedProjectReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #3846: raw project XML cannot resolve
/// <c>@(Item)</c>/<c>$(Property)</c> ProjectReference includes, so consumers
/// must use the evaluated MSBuild graph rather than silently treating them as
/// no references.
/// </summary>
public sealed class Issue3846EvaluatedProjectReferenceTests : IDisposable
{
    private readonly string root;
    private readonly string appProject;
    private readonly string itemProject;
    private readonly string propertyProject;

    /// <summary>Creates a three-project graph whose two edges are MSBuild expressions.</summary>
    public Issue3846EvaluatedProjectReferenceTests()
    {
        this.root = Path.Combine(
            Path.GetTempPath(),
            "cs2gs-issue3846-" + Guid.NewGuid().ToString("N"));
        this.itemProject = this.WriteProject("ItemDependency", "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        this.propertyProject = this.WriteProject("PropertyDependency", "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        this.appProject = this.WriteProject(
            "App",
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <PropertyDependency>..\PropertyDependency\PropertyDependency.csproj</PropertyDependency>
              </PropertyGroup>
              <ItemGroup>
                <ItemDependencies Include="..\ItemDependency\ItemDependency.csproj" />
                <ProjectReference Include="@(ItemDependencies)" />
                <ProjectReference Include="$(PropertyDependency)" />
              </ItemGroup>
            </Project>
            """);
    }

    /// <summary>Deletes the isolated project graph.</summary>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// Both expression shapes remain observable in the declared items, and a
    /// consumer that omits evaluated references receives a stable diagnostic
    /// instead of an indistinguishable empty path list.
    /// </summary>
    [Fact]
    public void DeclaredExpressionIncludes_AreObservableAndDiagnosed()
    {
        IReadOnlyList<DeclaredProjectItem> items =
            DeclaredProjectItems.Read(this.appProject, "ProjectReference");

        Assert.Equal(2, items.Count);
        Assert.All(items, item => Assert.Null(item.SourceInclude));
        Assert.All(items, item => Assert.True(
            DeclaredProjectItems.HasMsbuildExpressionInclude(item)));

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => DeclaredProjectItems.ProjectReferencePaths(this.appProject));
        Assert.Equal(
            $"Project '{Path.GetFullPath(this.appProject)}' declares ProjectReference Include " +
            "expressions that require MSBuild evaluation: '$(PropertyDependency)', '@(ItemDependencies)'.",
            error.Message);
    }

    /// <summary>
    /// Roslyn/MSBuildWorkspace supplies both concrete compile-reference paths,
    /// and the compile-surface probe consumes that evaluated answer.
    /// </summary>
    [Fact]
    public async Task CompileReferenceDiscovery_UsesEvaluatedItemAndPropertyIncludes()
    {
        IReadOnlyList<string> evaluated =
            await DeclaredProjectItems.EvaluateCompileProjectReferencePathsAsync(this.appProject);
        var graph = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase)
        {
            [Path.GetFullPath(this.appProject)] = evaluated,
        };

        IReadOnlyCollection<string> referenced =
            DeclaredProjectItems.CollectCompileReferencedProjectPaths(
                new[] { this.appProject },
                graph);

        Assert.Contains(Path.GetFullPath(this.itemProject), referenced);
        Assert.Contains(Path.GetFullPath(this.propertyProject), referenced);
    }

    /// <summary>
    /// The diagnostic-run build path uses the same evaluated edges as the
    /// repository path, so both dependencies are deterministically ordered
    /// before their consumer.
    /// </summary>
    [Fact]
    public async Task SdkBuildOrdering_UsesEvaluatedItemAndPropertyIncludesDeterministically()
    {
        IReadOnlyList<string> evaluated =
            await DeclaredProjectItems.EvaluateCompileProjectReferencePathsAsync(this.appProject);
        var graph = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase)
        {
            [Path.GetFullPath(this.appProject)] = evaluated,
            [Path.GetFullPath(this.itemProject)] = Array.Empty<string>(),
            [Path.GetFullPath(this.propertyProject)] = Array.Empty<string>(),
        };
        var apps = new[]
        {
            App("App", this.appProject),
            App("PropertyDependency", this.propertyProject),
            App("ItemDependency", this.itemProject),
        };
        var pipeline = new MigrationPipeline(new PipelineOptions { CompileViaSdk = true });

        string[] first = pipeline.OrderForSdkBuild(apps, graph).Select(app => app.Id).ToArray();
        string[] second = pipeline.OrderForSdkBuild(apps, graph).Select(app => app.Id).ToArray();

        Assert.Equal(first, second);
        Assert.True(Array.IndexOf(first, "ItemDependency") < Array.IndexOf(first, "App"));
        Assert.True(Array.IndexOf(first, "PropertyDependency") < Array.IndexOf(first, "App"));
    }

    private static CorpusApp App(string id, string projectPath) =>
        new CorpusApp(id, projectPath, TargetKind.Library);

    private string WriteProject(string name, string xml)
    {
        string directory = Path.Combine(this.root, name);
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, name + ".csproj");
        File.WriteAllText(path, xml);
        File.WriteAllText(Path.Combine(directory, name + ".cs"), $"public class {name} {{ }}");
        return path;
    }
}
