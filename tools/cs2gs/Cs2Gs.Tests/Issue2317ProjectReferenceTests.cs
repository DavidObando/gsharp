// <copyright file="Issue2317ProjectReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Regression tests for issue #2317 dependency and solution fidelity.</summary>
public class Issue2317ProjectReferenceTests
{
    [Fact]
    public void PipelineOptions_UsesSdkCompilationByDefault()
    {
        Assert.True(new PipelineOptions().CompileViaSdk);
    }

    [Fact]
    public void RewriteProjectReferences_UsesGeneratedProjectForMigratedTarget()
    {
        using var directory = new ScratchDirectory();
        string sourceApp = Path.Combine(directory.Path, "src", "App");
        string sourceLib = Path.Combine(directory.Path, "src", "Lib");
        string targetApp = Path.Combine(directory.Path, "out", "App");
        string targetLib = Path.Combine(directory.Path, "out", "Lib", "Lib.gsproj");
        Directory.CreateDirectory(sourceApp);
        Directory.CreateDirectory(sourceLib);
        Directory.CreateDirectory(targetApp);
        string projectPath = Path.Combine(sourceApp, "App.csproj");
        File.WriteAllText(
            projectPath,
            "<Project><ItemGroup Condition=\"'$(Configuration)' == 'Release'\">" +
            "<ProjectReference Include=\"../Lib/Lib.csproj\" Aliases=\"lib\" />" +
            "</ItemGroup></Project>");

        IReadOnlyList<DeclaredProjectItem> items =
            DeclaredProjectItems.Read(projectPath, "ProjectReference");
        IReadOnlyList<DeclaredProjectItem> rewritten =
            DeclaredProjectItems.RewriteProjectReferences(
                items,
                targetApp,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    [Path.Combine(sourceLib, "Lib.csproj")] = targetLib,
                });

        DeclaredProjectItem item = Assert.Single(rewritten);
        Assert.Equal("'$(Configuration)' == 'Release'", item.ItemGroupCondition);
        Assert.Equal(
            Path.GetRelativePath(targetApp, targetLib),
            item.Element.Attribute("Include")?.Value);
        Assert.Equal("lib", item.Element.Attribute("Aliases")?.Value);
    }

    [Fact]
    public void GenerateSolutions_WritesSlnxAndRewritesOnlyMigratedProjects()
    {
        using var directory = new ScratchDirectory();
        string source = Path.Combine(directory.Path, "source");
        string target = Path.Combine(directory.Path, "target");
        string app = Path.Combine(source, "App", "App.csproj");
        string library = Path.Combine(source, "Lib", "Lib.csproj");
        string generatedApp = Path.Combine(target, "corpus_App", "App.gsproj");
        Directory.CreateDirectory(Path.GetDirectoryName(app));
        Directory.CreateDirectory(Path.GetDirectoryName(library));
        File.WriteAllText(app, "<Project />");
        File.WriteAllText(library, "<Project />");
        Directory.CreateDirectory(source);
        File.WriteAllText(
            Path.Combine(source, "Sample.sln"),
            "Microsoft Visual Studio Solution File, Format Version 12.00\n" +
            "Project(\"{66A26720-8FB5-11D2-AA7E-00C04F688DDE}\") = \"src\", \"src\", \"{0}\"\n" +
            "EndProject\n" +
            "Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"App\", \"App\\App.csproj\", \"{1}\"\n" +
            "EndProject\n" +
            "Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"Lib\", \"Lib\\Lib.csproj\", \"{2}\"\n" +
            "EndProject\n");

        IReadOnlyList<string> solutions = SolutionGenerator.Generate(
            source,
            target,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [app] = generatedApp,
            });

        string solution = Assert.Single(solutions);
        Assert.Equal(".slnx", Path.GetExtension(solution));
        IReadOnlyList<string> projects = SolutionGenerator.ReadProjects(solution);
        Assert.Contains(generatedApp, projects, StringComparer.OrdinalIgnoreCase);
        Assert.Contains(library, projects, StringComparer.OrdinalIgnoreCase);
    }

    private sealed class ScratchDirectory : IDisposable
    {
        public ScratchDirectory()
        {
            this.Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "cs2gs-issue2317-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            Directory.Delete(this.Path, recursive: true);
        }
    }
}
