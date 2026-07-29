// <copyright file="Issue2868MirroredArtifactLayoutTests.cs" company="GSharp">
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
/// Issue #2868 — the mirrored-project build redirected every project's output
/// to a FLAT <c>$(Cs2GsArtifactRoot)/bin/$(MSBuildProjectName)/</c>, collapsing
/// the repo structure. Any test that locates a sibling project's output by
/// walking up from its own assembly directory — the standard end-to-end
/// pattern, e.g. <c>../../../../../src/App/bin/$(Config)/$(TFM)/app.dll</c> —
/// could therefore never resolve it, no matter how correct the translation
/// was, so such suites were permanently red.
/// <para>
/// The layout now reproduces each project's repo-relative directory under
/// <c>$(Cs2GsArtifactRoot)/bin</c>, which acts as the migrated repo root.
/// Everything still lives under <c>bin/</c>, preserving the existing
/// "search <c>&lt;artifactDir&gt;/bin</c> recursively" contract.
/// </para>
/// </summary>
public class Issue2868MirroredArtifactLayoutTests
{
    [Fact]
    public void ResolveMirrorRoot_IsTheCommonAncestorOfEveryGeneratedProject()
    {
        string root = Path.Combine(Path.GetTempPath(), "mig-out");
        var projects = new[]
        {
            Path.Combine(root, "src", "App", "App.gsproj"),
            Path.Combine(root, "tests", "App.Tests", "App.Tests.gsproj"),
            Path.Combine(root, "tools", "Diag", "Diag.gsproj"),
        };

        Assert.Equal(
            Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar),
            SdkCompileRunner.ResolveMirrorRoot(projects));
    }

    [Fact]
    public void ResolveMirrorRoot_ForASingleProject_IsItsParent()
    {
        // A lone project has no sibling to resolve, so its own parent is the
        // root and its relative directory stays its own folder name.
        string root = Path.Combine(Path.GetTempPath(), "mig-single");
        string project = Path.Combine(root, "App", "App.gsproj");

        string mirrorRoot = SdkCompileRunner.ResolveMirrorRoot(new[] { project });

        Assert.Equal(Path.GetFullPath(Path.Combine(root, "App")), Path.Combine(mirrorRoot, "App"));
        Assert.Equal(
            "App",
            SdkCompileRunner.MirroredProjectDirectory(Path.Combine(root, "App"), mirrorRoot));
    }

    [Fact]
    public void MirroredProjectDirectory_PreservesTheRepoRelativePath()
    {
        string root = Path.Combine(Path.GetTempPath(), "mig-rel");

        Assert.Equal(
            "tests/App.E2E.Tests",
            SdkCompileRunner.MirroredProjectDirectory(
                Path.Combine(root, "tests", "App.E2E.Tests"),
                root));
        Assert.Equal(
            "src/App",
            SdkCompileRunner.MirroredProjectDirectory(Path.Combine(root, "src", "App"), root));
    }

    [Fact]
    public void MirroredProjectDirectory_WithoutAMirrorRoot_FallsBackToTheFolderName()
    {
        Assert.Equal(
            "App",
            SdkCompileRunner.MirroredProjectDirectory(
                Path.Combine(Path.GetTempPath(), "anywhere", "App"),
                mirrorRoot: null));
    }

    [Fact]
    public void PreparedBuildProps_MirrorTheRepoLayoutSoSiblingOutputsResolve()
    {
        string root = Directory.CreateTempSubdirectory("gs_2868_").FullName;
        try
        {
            string appDir = Path.Combine(root, "src", "App");
            string testsDir = Path.Combine(root, "tests", "App.E2E.Tests");
            Directory.CreateDirectory(appDir);
            Directory.CreateDirectory(testsDir);
            var projects = new[]
            {
                Path.Combine(appDir, "App.gsproj"),
                Path.Combine(testsDir, "App.E2E.Tests.gsproj"),
            };

            IReadOnlyList<(string Path, byte[] Original)> prepared =
                SdkCompileRunner.PrepareTemporaryBuildProps(projects);
            try
            {
                Assert.Equal(
                    "$(Cs2GsArtifactRoot)/bin/src/App/bin/",
                    ReadProperty(Path.Combine(appDir, "Directory.Build.props"), "BaseOutputPath"));
                Assert.Equal(
                    "$(Cs2GsArtifactRoot)/bin/tests/App.E2E.Tests/bin/",
                    ReadProperty(
                        Path.Combine(testsDir, "Directory.Build.props"),
                        "BaseOutputPath"));

                // The whole point: from
                // `<root>/bin/tests/App.E2E.Tests/bin/<Config>/<TFM>` the
                // standard five-level walk up lands on `<root>/bin`, where
                // `src/App/bin/<Config>/<TFM>` is exactly where the sibling's
                // output was written.
                string testsOutput = Path.Combine(
                    root, "bin", "tests", "App.E2E.Tests", "bin", "Debug", "net10.0");
                string walkedUp = Path.GetFullPath(
                    Path.Combine(testsOutput, "..", "..", "..", "..", ".."));
                Assert.Equal(Path.Combine(root, "bin"), walkedUp);
                Assert.Equal(
                    Path.Combine(walkedUp, "src", "App", "bin", "Debug", "net10.0"),
                    Path.Combine(root, "bin", "src", "App", "bin", "Debug", "net10.0"));

                // Intermediate output is mirrored the same way so two projects
                // sharing a name in different folders cannot collide.
                Assert.Equal(
                    "$(Cs2GsArtifactRoot)/obj/src/App/obj/",
                    ReadProperty(
                        Path.Combine(appDir, "Directory.Build.props"),
                        "BaseIntermediateOutputPath"));
            }
            finally
            {
                SdkCompileRunner.RestoreTemporaryBuildProps(prepared);
            }

            // The props files are temporary: restoring removes the ones that
            // did not exist beforehand.
            Assert.False(File.Exists(Path.Combine(appDir, "Directory.Build.props")));
            Assert.False(File.Exists(Path.Combine(testsDir, "Directory.Build.props")));
        }
        finally
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string ReadProperty(string propsPath, string name)
    {
        Assert.True(File.Exists(propsPath), $"expected {propsPath} to exist");
        return XDocument.Load(propsPath)
            .Descendants()
            .Where(element => element.Name.LocalName == name)
            .Select(element => element.Value)
            .Single();
    }
}
