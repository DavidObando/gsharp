// <copyright file="Issue2868MirroredArtifactLayoutTests.cs" company="GSharp">
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

/// Issue #2868 — the mirrored-project build redirected every project's output
/// to a FLAT `$(Cs2GsArtifactRoot)/bin/$(MSBuildProjectName)/`, collapsing
/// the repo structure. Any test that locates a sibling project's output by
/// walking up from its own assembly directory — the standard end-to-end
/// pattern, e.g. `../../../../../src/App/bin/$(Config)/$(TFM)/app.dll` —
/// could therefore never resolve it, no matter how correct the translation
/// was, so such suites were permanently red.
///
/// The layout now reproduces each project's repo-relative directory under
/// `$(Cs2GsArtifactRoot)/bin`, which acts as the migrated repo root.
/// Everything still lives under `bin/`, preserving the existing
/// "search `<artifactDir>/bin` recursively" contract.
open class Issue2868MirroredArtifactLayoutTests {
    @Fact
    func ResolveMirrorRoot_IsTheCommonAncestorOfEveryGeneratedProject() {
        let root = Path.Combine(Path.GetTempPath(), "mig-out")
        let projects = []string{
            Path.Combine(root, "src", "App", "App.gsproj"),
            Path.Combine(root, "tests", "App.Tests", "App.Tests.gsproj"),
            Path.Combine(root, "tools", "Diag", "Diag.gsproj")
        }
        Assert.Equal(
            Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar),
            SdkCompileRunner.ResolveMirrorRoot(projects)
        )
    }

    @Fact
    func ResolveMirrorRoot_ForASingleProject_IsItsParent() {
        // A lone project has no sibling to resolve, so its own parent is the
        // root and its relative directory stays its own folder name.
        let root = Path.Combine(Path.GetTempPath(), "mig-single")
        let project = Path.Combine(root, "App", "App.gsproj")
        let mirrorRoot = SdkCompileRunner.ResolveMirrorRoot([]string{project})!!
        Assert.Equal(Path.GetFullPath(Path.Combine(root, "App")), Path.Combine(mirrorRoot, "App"))
        Assert.Equal("App", SdkCompileRunner.MirroredProjectDirectory(Path.Combine(root, "App"), mirrorRoot))
    }

    @Fact
    func MirroredProjectDirectory_PreservesTheRepoRelativePath() {
        let root = Path.Combine(Path.GetTempPath(), "mig-rel")
        Assert.Equal(
            "tests/App.E2E.Tests",
            SdkCompileRunner.MirroredProjectDirectory(Path.Combine(root, "tests", "App.E2E.Tests"), root)
        )
        Assert.Equal("src/App", SdkCompileRunner.MirroredProjectDirectory(Path.Combine(root, "src", "App"), root))
    }

    @Fact
    func MirroredProjectDirectory_WithoutAMirrorRoot_FallsBackToTheFolderName() {
        Assert.Equal(
            "App",
            SdkCompileRunner.MirroredProjectDirectory(
                Path.Combine(Path.GetTempPath(), "anywhere", "App"),
                mirrorRoot: nil
            )
        )
    }

    @Fact
    func PreparedBuildProps_MirrorTheRepoLayoutSoSiblingOutputsResolve() {
        let root = Directory.CreateTempSubdirectory("gs_2868_").FullName
        try {
            let appDir = Path.Combine(root, "src", "App")
            let testsDir = Path.Combine(root, "tests", "App.E2E.Tests")
            Directory.CreateDirectory(appDir)
            Directory.CreateDirectory(testsDir)
            let projects = []string{Path.Combine(appDir, "App.gsproj"), Path.Combine(testsDir, "App.E2E.Tests.gsproj")}
            let prepared = SdkCompileRunner.PrepareTemporaryBuildProps(projects)
            try {
                Assert.Equal(
                    "$$(Cs2GsArtifactRoot)/bin/src/App/bin/",
                    ReadProperty(Path.Combine(appDir, "Directory.Build.props"), "BaseOutputPath")
                )
                Assert.Equal(
                    "$$(Cs2GsArtifactRoot)/bin/tests/App.E2E.Tests/bin/",
                    ReadProperty(Path.Combine(testsDir, "Directory.Build.props"), "BaseOutputPath")
                )
                // The whole point: from
                // `<root>/bin/tests/App.E2E.Tests/bin/<Config>/<TFM>` the
                // standard five-level walk up lands on `<root>/bin`, where
                // `src/App/bin/<Config>/<TFM>` is exactly where the sibling's
                // output was written.
                let testsOutput = Path.Combine(root, "bin", "tests", "App.E2E.Tests", "bin", "Debug", "net10.0")
                let walkedUp = Path.GetFullPath(Path.Combine(testsOutput, "..", "..", "..", "..", ".."))
                Assert.Equal(Path.Combine(root, "bin"), walkedUp)
                Assert.Equal(
                    Path.Combine(walkedUp, "src", "App", "bin", "Debug", "net10.0"),
                    Path.Combine(root, "bin", "src", "App", "bin", "Debug", "net10.0")
                )
                // Intermediate output is mirrored the same way so two projects
                // sharing a name in different folders cannot collide.
                Assert.Equal(
                    "$$(Cs2GsArtifactRoot)/obj/src/App/obj/",
                    ReadProperty(Path.Combine(appDir, "Directory.Build.props"), "BaseIntermediateOutputPath")
                )
            } finally {
                SdkCompileRunner.RestoreTemporaryBuildProps(prepared)
            }
            // The props files are temporary: restoring removes the ones that
            // did not exist beforehand.
            Assert.False(File.Exists(Path.Combine(appDir, "Directory.Build.props")))
            Assert.False(File.Exists(Path.Combine(testsDir, "Directory.Build.props")))
        } finally {
            try {
                Directory.Delete(root, recursive: true)
            } catch (IOException) { }
        }
    }

    shared {
        private func ReadProperty(propsPath string, name string) string {
            Assert.True(File.Exists(propsPath), "expected $propsPath to exist")
            return XDocument
                .Load(propsPath)
                .Descendants()
                .Where((element XElement) -> element.Name.LocalName == name)
                .Select((element XElement) -> element.Value)
                .Single()
        }
    }
}
