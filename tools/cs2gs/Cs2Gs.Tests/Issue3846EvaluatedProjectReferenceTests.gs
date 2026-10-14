// <copyright file="Issue3846EvaluatedProjectReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Regression coverage for issue #3846: raw project XML cannot resolve
/// `@(Item)`/`$(Property)` ProjectReference includes, so consumers
/// must use the evaluated MSBuild graph rather than silently treating them as
/// no references.
class Issue3846EvaluatedProjectReferenceTests : IDisposable {
    private let root string
    private let appProject string
    private let itemProject string
    private let propertyProject string

    /// Creates a three-project graph whose two edges are MSBuild expressions.
    init() {
        this.root = Path.Combine(Path.GetTempPath(), "cs2gs-issue3846-" + Guid.NewGuid().ToString("N"))
        this.itemProject = this.WriteProject("ItemDependency", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        this.propertyProject = this.WriteProject("PropertyDependency", "<Project Sdk=\"Microsoft.NET.Sdk\" />")
        this.appProject = this.WriteProject("App", `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <PropertyDependency>..\PropertyDependency\PropertyDependency.csproj</PropertyDependency>
  </PropertyGroup>
  <ItemGroup>
    <ItemDependencies Include="..\ItemDependency\ItemDependency.csproj" />
    <ProjectReference Include="@(ItemDependencies)" />
    <ProjectReference Include="$(PropertyDependency)" />
  </ItemGroup>
</Project>`)
    }

    /// Deletes the isolated project graph.
    func Dispose() {
        try {
            Directory.Delete(this.root, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// Both expression shapes remain observable in the declared items, and a
    /// consumer that omits evaluated references receives a stable diagnostic
    /// instead of an indistinguishable empty path list.
    @Fact
    func DeclaredExpressionIncludes_AreObservableAndDiagnosed() {
        let items = DeclaredProjectItems.Read(this.appProject, "ProjectReference")
        Assert.Equal(2, items.Count)
        Assert.All(items, (item DeclaredProjectItem) -> Assert.Null(item.SourceInclude))
        Assert.All(
            items,
            (item DeclaredProjectItem) -> Assert.True(DeclaredProjectItems.HasMsbuildExpressionInclude(item))
        )
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return DeclaredProjectItems.ProjectReferencePaths(this.appProject)
            }
        )
        Assert.Equal(
            "Project '${Path.GetFullPath(this.appProject)}' declares ProjectReference Include " +
                "expressions that require MSBuild evaluation: '$$(PropertyDependency)', '@(ItemDependencies)'.",
            error.Message
        )
    }

    /// Roslyn/MSBuildWorkspace supplies both concrete compile-reference paths,
    /// and the compile-surface probe consumes that evaluated answer.
    @Fact
    async func CompileReferenceDiscovery_UsesEvaluatedItemAndPropertyIncludes() {
        let evaluated = await DeclaredProjectItems.EvaluateCompileProjectReferencePathsAsync(this.appProject)
        let graph = Dictionary[string, IReadOnlyList[string]](StringComparer.OrdinalIgnoreCase){
            [Path.GetFullPath(this.appProject)] = evaluated
        }
        let referenced = DeclaredProjectItems.CollectCompileReferencedProjectPaths([]string{this.appProject}, graph)
        Assert.Contains(Path.GetFullPath(this.itemProject), referenced)
        Assert.Contains(Path.GetFullPath(this.propertyProject), referenced)
    }

    /// The diagnostic-run build path uses the same evaluated edges as the
    /// repository path, so both dependencies are deterministically ordered
    /// before their consumer.
    @Fact
    async func SdkBuildOrdering_UsesEvaluatedItemAndPropertyIncludesDeterministically() {
        let evaluated = await DeclaredProjectItems.EvaluateCompileProjectReferencePathsAsync(this.appProject)
        let graph = Dictionary[string, IReadOnlyList[string]](StringComparer.OrdinalIgnoreCase){
            [Path.GetFullPath(this.appProject)] = evaluated,
            [Path.GetFullPath(this.itemProject)] = Array.Empty[string](),
            [Path.GetFullPath(this.propertyProject)] = Array.Empty[string]()
        }
        let apps = []CorpusApp{
            App("App", this.appProject),
            App("PropertyDependency", this.propertyProject),
            App("ItemDependency", this.itemProject)
        }
        let pipeline = MigrationPipeline(PipelineOptions{CompileViaSdk: true})
        let first = pipeline.OrderForSdkBuild(apps, graph).Select((app CorpusApp) -> app.Id).ToArray()
        let second = pipeline.OrderForSdkBuild(apps, graph).Select((app CorpusApp) -> app.Id).ToArray()
        Assert.Equal(first, second)
        Assert.True(Array.IndexOf(first, "ItemDependency") < Array.IndexOf(first, "App"))
        Assert.True(Array.IndexOf(first, "PropertyDependency") < Array.IndexOf(first, "App"))
    }

    private func WriteProject(name string, xml string) string {
        let directory = Path.Combine(this.root, name)
        Directory.CreateDirectory(directory)
        let path = Path.Combine(directory, name + ".csproj")
        File.WriteAllText(path, xml)
        File.WriteAllText(Path.Combine(directory, name + ".cs"), "public class $name { }")
        return path
    }

    shared {
        private func App(id string, projectPath string) CorpusApp -> CorpusApp(id, projectPath, TargetKind.Library)
    }
}
