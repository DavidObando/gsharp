// <copyright file="Issue3617AnalyzerReferenceOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Regression tests for issue #3617: the repository-layout app ordering must
/// see analyzer-shaped project references (`OutputItemType="Analyzer"
/// ReferenceOutputAssembly="false"`) as dependency edges. The Roslyn
/// project loader follows compile references only, so the ordering unions in
/// the XML-declared `ProjectReference` paths — this suite pins the
/// contract that declared-path reading surfaces analyzer references, which is
/// what keeps a consumer app from building its analyzer dependency out of a
/// source-less mirror directory into a husk assembly that later fails
/// analyzer discovery (GS9301).
open class Issue3617AnalyzerReferenceOrderingTests {
    @Fact
    func ProjectReferencePaths_IncludesAnalyzerShapedReference() {
        using let directory = Issue3617AnalyzerReferenceOrderingTests.ScratchDirectory()
        let appDirectory = Path.Combine(directory.Path, "src", "Core")
        let analyzerDirectory = Path.Combine(directory.Path, "src", "Analyzers", "InternalAnalyzers")
        Directory.CreateDirectory(appDirectory)
        Directory.CreateDirectory(analyzerDirectory)
        let analyzerProject = Path.Combine(analyzerDirectory, "InternalAnalyzers.csproj")
        File.WriteAllText(analyzerProject, "<Project></Project>")
        let appProject = Path.Combine(appDirectory, "Core.csproj")
        File.WriteAllText(
            appProject,
            "<Project><ItemGroup>" +
                "<ProjectReference Include=\"..\\Analyzers\\InternalAnalyzers\\InternalAnalyzers.csproj\" " +
                "OutputItemType=\"Analyzer\" ReferenceOutputAssembly=\"false\" PrivateAssets=\"all\" />" +
                "</ItemGroup></Project>"
        )
        let paths = DeclaredProjectItems.ProjectReferencePaths(appProject)
        let resolved = Assert.Single(paths)
        Assert.Equal(Path.GetFullPath(analyzerProject), resolved)
    }

    private class ScratchDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(Path.GetTempPath(), "cs2gs-issue3617-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            Directory.Delete(this.Path, recursive: true)
        }
    }
}
