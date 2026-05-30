// <copyright file="ProjectDiscoveryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class ProjectDiscoveryTests
{
    [Fact]
    public void DiscoverProjects_FindsGsprojFiles()
    {
        // Use the real samples directory
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return; // Skip if not running from expected location
        }

        var projects = ProjectDiscovery.DiscoverProjects(samplesDir);

        Assert.NotEmpty(projects);
        Assert.All(projects, p => Assert.EndsWith(".gsproj", p.ProjectFilePath));
    }

    [Fact]
    public void DiscoverProjects_ReturnsEmptyForNonexistentDir()
    {
        var projects = ProjectDiscovery.DiscoverProjects("/nonexistent/path");

        Assert.Empty(projects);
    }

    [Fact]
    public void DiscoverProjects_ReturnsEmptyForNullDir()
    {
        var projects = ProjectDiscovery.DiscoverProjects(null);

        Assert.Empty(projects);
    }

    [Fact]
    public void DiscoverProject_FindsSourceFiles()
    {
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return;
        }

        var multiFilePath = Path.Combine(samplesDir, "MultiFile", "MultiFile.gsproj");
        if (!File.Exists(multiFilePath))
        {
            return;
        }

        var project = ProjectDiscovery.DiscoverProject(multiFilePath);

        Assert.NotNull(project);
        Assert.True(project.SourceFiles.Count >= 3, $"Expected at least 3 .gs files, found {project.SourceFiles.Count}");
        Assert.All(project.SourceFiles, f => Assert.EndsWith(".gs", f));
    }

    [Fact]
    public void DiscoverProject_ExcludesBinObj()
    {
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return;
        }

        var multiFilePath = Path.Combine(samplesDir, "MultiFile", "MultiFile.gsproj");
        if (!File.Exists(multiFilePath))
        {
            return;
        }

        var project = ProjectDiscovery.DiscoverProject(multiFilePath);

        Assert.NotNull(project);
        Assert.DoesNotContain(project.SourceFiles, f => f.Contains("/bin/") || f.Contains("/obj/"));
    }

    [Fact]
    public void DiscoverProject_FindsProjectReferences()
    {
        var samplesDir = FindSamplesDir();
        if (samplesDir == null)
        {
            return;
        }

        var appPath = Path.Combine(samplesDir, "ProjectRef", "App", "App.gsproj");
        if (!File.Exists(appPath))
        {
            return;
        }

        var project = ProjectDiscovery.DiscoverProject(appPath);

        Assert.NotNull(project);
        Assert.Single(project.ProjectReferences);
        Assert.Contains("Lib.gsproj", project.ProjectReferences[0]);
    }

    [Fact]
    public void DiscoverProject_ReturnsNullForMissingFile()
    {
        var project = ProjectDiscovery.DiscoverProject("/nonexistent/project.gsproj");

        Assert.Null(project);
    }

    private static string FindSamplesDir()
    {
        var dir = Directory.GetCurrentDirectory();
        while (dir != null)
        {
            var samples = Path.Combine(dir, "samples");
            if (Directory.Exists(samples) && Directory.GetFiles(samples, "*.gsproj", SearchOption.AllDirectories).Any())
            {
                return samples;
            }

            dir = Path.GetDirectoryName(dir);
        }

        return null;
    }
}
