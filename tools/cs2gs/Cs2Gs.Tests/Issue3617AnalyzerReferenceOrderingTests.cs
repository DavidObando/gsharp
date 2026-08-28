// <copyright file="Issue3617AnalyzerReferenceOrderingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #3617: the repository-layout app ordering must
/// see analyzer-shaped project references (<c>OutputItemType="Analyzer"
/// ReferenceOutputAssembly="false"</c>) as dependency edges. The Roslyn
/// project loader follows compile references only, so the ordering unions in
/// the XML-declared <c>ProjectReference</c> paths — this suite pins the
/// contract that declared-path reading surfaces analyzer references, which is
/// what keeps a consumer app from building its analyzer dependency out of a
/// source-less mirror directory into a husk assembly that later fails
/// analyzer discovery (GS9301).
/// </summary>
public class Issue3617AnalyzerReferenceOrderingTests
{
    [Fact]
    public void ProjectReferencePaths_IncludesAnalyzerShapedReference()
    {
        using var directory = new ScratchDirectory();
        string appDirectory = Path.Combine(directory.Path, "src", "Core");
        string analyzerDirectory = Path.Combine(directory.Path, "src", "Analyzers", "InternalAnalyzers");
        Directory.CreateDirectory(appDirectory);
        Directory.CreateDirectory(analyzerDirectory);
        string analyzerProject = Path.Combine(analyzerDirectory, "InternalAnalyzers.csproj");
        File.WriteAllText(analyzerProject, "<Project></Project>");
        string appProject = Path.Combine(appDirectory, "Core.csproj");
        File.WriteAllText(
            appProject,
            "<Project><ItemGroup>" +
            "<ProjectReference Include=\"..\\Analyzers\\InternalAnalyzers\\InternalAnalyzers.csproj\" " +
            "OutputItemType=\"Analyzer\" ReferenceOutputAssembly=\"false\" PrivateAssets=\"all\" />" +
            "</ItemGroup></Project>");

        IReadOnlyList<string> paths = DeclaredProjectItems.ProjectReferencePaths(appProject);

        string resolved = Assert.Single(paths);
        Assert.Equal(Path.GetFullPath(analyzerProject), resolved);
    }

    private sealed class ScratchDirectory : IDisposable
    {
        public ScratchDirectory()
        {
            this.Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "cs2gs-issue3617-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            Directory.Delete(this.Path, recursive: true);
        }
    }
}
