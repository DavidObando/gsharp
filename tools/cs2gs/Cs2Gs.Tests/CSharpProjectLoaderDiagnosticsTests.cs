// <copyright file="CSharpProjectLoaderDiagnosticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1742: <see cref="CSharpProjectLoader"/> must not
/// silently swallow MSBuild workspace load failures, and must not exclude a
/// hand-written source file merely because its name matches a generated-file
/// pattern (it must check for an actual generated marker instead).
/// </summary>
public class CSharpProjectLoaderDiagnosticsTests
{
    /// <summary>
    /// A project whose <c>ProjectReference</c> points at a file that does not
    /// exist is a classic MSBuild "soft fail": <c>OpenProjectAsync</c> does not
    /// throw, but the workspace records a <see cref="WorkspaceDiagnosticKind.Failure"/>
    /// diagnostic. That failure must be surfaced as an <see cref="DiagnosticSeverity.Error"/>
    /// in <see cref="LoadedCSharpProject.LoadDiagnostics"/> (and therefore fail
    /// <see cref="LoadedCSharpProject.BoundWithoutErrors"/>) instead of being
    /// dropped on the floor.
    /// </summary>
    [Fact]
    public async Task LoadProjectAsync_SurfacesMSBuildWorkspaceLoadFailure()
    {
        string projectDir = NewScratchDir("load-failure");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Broken.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\DoesNotExist\DoesNotExist.csproj"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), "public class Program { public static void Main() { } }");

        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.NotEmpty(project.LoadDiagnostics);
        Assert.Contains(project.LoadDiagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.False(
            project.BoundWithoutErrors,
            "A project with an unresolvable ProjectReference must not report BoundWithoutErrors=true.");
    }

    /// <summary>
    /// Issue #2321 (loader path 1 of 2): a project whose only MSBuild workspace
    /// failure is a NuGet audit vulnerability advisory (the NU1901-NU1904
    /// shape — here NU1903/high for the well-known
    /// <c>Newtonsoft.Json 12.0.1</c> advisory GHSA-5crp-9r3c-p9vr) must still
    /// bind: the advisory must not trip <see cref="CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId"/>
    /// (CS2GS0001), <see cref="LoadedCSharpProject.WorkspaceLoadFailed"/>, or
    /// <see cref="LoadedCSharpProject.BoundWithoutErrors"/>. The advisory
    /// remains visible as an informational
    /// <see cref="CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId"/> (CS2GS0003)
    /// diagnostic instead of being dropped silently.
    /// </summary>
    [Fact]
    public async Task LoadProjectAsync_NuGetAuditAdvisoryDoesNotFailWorkspaceLoad()
    {
        string projectDir = NewScratchDir("nuget-audit-advisory");
        WriteVulnerablePackageProject(projectDir, "Vulnerable.csproj");

        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(
            Path.Combine(projectDir, "Vulnerable.csproj"));

        Assert.False(
            project.WorkspaceLoadFailed,
            "A benign NuGet audit vulnerability advisory (NU1901-NU1904 shape) must not trip CS2GS0001.");
        Assert.True(
            project.BoundWithoutErrors,
            "A benign NuGet audit vulnerability advisory must not report BoundWithoutErrors=false.");
        Assert.DoesNotContain(
            project.ErrorDiagnostics,
            d => d.Id == CSharpProjectLoader.WorkspaceLoadFailureDiagnosticId);
        Assert.Contains(
            project.LoadDiagnostics,
            d => d.Id == CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId && d.Severity == DiagnosticSeverity.Info);
    }

    /// <summary>
    /// Issue #2321 (loader path 2 of 2): the same benign-advisory exemption
    /// applies to <see cref="CSharpProjectLoader.LoadProjectWithReferencesAsync"/>
    /// — the second project-loading path that independently gates on MSBuild
    /// workspace load failures.
    /// </summary>
    [Fact]
    public async Task LoadProjectWithReferencesAsync_NuGetAuditAdvisoryDoesNotFailWorkspaceLoad()
    {
        string projectDir = NewScratchDir("nuget-audit-advisory-with-refs");
        WriteVulnerablePackageProject(projectDir, "Vulnerable.csproj");

        System.Collections.Generic.IReadOnlyList<LoadedCSharpProject> projects =
            await CSharpProjectLoader.LoadProjectWithReferencesAsync(Path.Combine(projectDir, "Vulnerable.csproj"));

        LoadedCSharpProject project = Assert.Single(projects);
        Assert.False(
            project.WorkspaceLoadFailed,
            "A benign NuGet audit vulnerability advisory (NU1901-NU1904 shape) must not trip CS2GS0001.");
        Assert.True(project.BoundWithoutErrors);
        Assert.Contains(
            project.LoadDiagnostics,
            d => d.Id == CSharpProjectLoader.NuGetAuditAdvisoryDiagnosticId && d.Severity == DiagnosticSeverity.Info);
    }

    /// <summary>
    /// Issue #2321 regression guard: <see cref="CSharpProjectLoader.LoadProjectWithReferencesAsync"/>
    /// must keep gating on a GENUINE workspace load failure exactly like
    /// <see cref="LoadProjectAsync_SurfacesMSBuildWorkspaceLoadFailure"/> proves
    /// for <see cref="CSharpProjectLoader.LoadProjectAsync"/> — the narrowed
    /// policy must not have weakened this second loading path.
    /// </summary>
    [Fact]
    public async Task LoadProjectWithReferencesAsync_SurfacesMSBuildWorkspaceLoadFailure()
    {
        string projectDir = NewScratchDir("with-references-load-failure");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Broken.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\DoesNotExist\DoesNotExist.csproj"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), "public class Program { public static void Main() { } }");

        System.Collections.Generic.IReadOnlyList<LoadedCSharpProject> projects =
            await CSharpProjectLoader.LoadProjectWithReferencesAsync(projectPath);

        LoadedCSharpProject project = Assert.Single(projects);
        Assert.True(project.WorkspaceLoadFailed);
        Assert.False(
            project.BoundWithoutErrors,
            "A project with an unresolvable ProjectReference must not report BoundWithoutErrors=true.");
    }

    /// <summary>
    /// A hand-written file whose NAME matches a generated-file pattern
    /// (<c>*.Designer.cs</c>) but carries no <c>&lt;auto-generated&gt;</c> marker
    /// must still be translated — filename alone is not a generated-code signal.
    /// </summary>
    [Fact]
    public void LoadInMemory_IncludesHandWrittenFileNamedLikeGenerated()
    {
        const string handWritten = @"
namespace Sample
{
    public class Foo
    {
        public int Bar() => 42;
    }
}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Foo.Designer.cs", handWritten) });

        LoadedDocument document = Assert.Single(project.Documents);
        Assert.Equal("Foo.Designer.cs", document.FilePath);
        Assert.DoesNotContain(
            project.LoadDiagnostics,
            d => d.Descriptor.Id == "CS2GS0002");
    }

    /// <summary>
    /// A file carrying the standard <c>// &lt;auto-generated&gt;</c> header is a
    /// genuinely generated file and must still be excluded from translation,
    /// with an informational diagnostic recorded (not silent).
    /// </summary>
    [Fact]
    public void LoadInMemory_ExcludesGenuinelyGeneratedFile()
    {
        const string generated = @"//------------------------------------------------------------------------------
// <auto-generated>
//     This code was generated by a tool.
// </auto-generated>
//------------------------------------------------------------------------------
namespace Sample
{
    public class Foo
    {
        public int Bar() => 42;
    }
}
";
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Foo.Designer.cs", generated) });

        Assert.Empty(project.Documents);
        Assert.Contains(
            project.LoadDiagnostics,
            d => d.Descriptor.Id == "CS2GS0002" && d.Severity == DiagnosticSeverity.Info);
    }

    /// <summary>
    /// N1/S2 (issue #1742 review follow-up): the project-directory-relative
    /// obj/bin exclusion in <c>IsGeneratedSource</c> is a path-boundary check —
    /// a file physically under <c>&lt;projDir&gt;/obj/</c> is excluded, but a
    /// hand-written file merely living in a folder whose name happens to START
    /// WITH <c>obj</c> (e.g. <c>src/obji/Foo.cs</c>, NOT the <c>obj</c> output
    /// dir) is not. The explicit <c>&lt;Compile Include&gt;</c> items below
    /// force both files into the compilation, bypassing the SDK's own default
    /// glob exclude for <c>obj/</c>/<c>bin/</c> so the loader's own boundary
    /// check is what is actually exercised.
    /// </summary>
    [Fact]
    public async Task LoadProjectAsync_ObjBinExclusion_IsPathBoundaryNotPrefixMatch()
    {
        string projectDir = NewScratchDir("obj-boundary");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");

        Directory.CreateDirectory(Path.Combine(projectDir, "obj"));
        File.WriteAllText(
            Path.Combine(projectDir, "obj", "Manual.cs"),
            "public class ManualUnderObj { public int Bar() => 1; }");

        Directory.CreateDirectory(Path.Combine(projectDir, "src", "obji"));
        File.WriteAllText(
            Path.Combine(projectDir, "src", "obji", "Foo.cs"),
            "public class HandWrittenInObjiFolder { public int Bar() => 2; }");

        string projectPath = Path.Combine(projectDir, "ObjBoundary.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <Compile Remove=""obj/**/*.cs"" />
    <Compile Include=""obj/Manual.cs"" />
    <Compile Include=""src/obji/Foo.cs"" />
  </ItemGroup>
</Project>
");

        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.DoesNotContain(project.Documents, d => d.FilePath.Replace('\\', '/').EndsWith("obj/Manual.cs", StringComparison.Ordinal));
        Assert.Contains(project.Documents, d => d.FilePath.Replace('\\', '/').EndsWith("src/obji/Foo.cs", StringComparison.Ordinal));
    }

    /// <summary>
    /// Refs #914: an app that references a sibling class-library project must be
    /// loaded together with that sibling so the app's uses of sibling types can
    /// be resolved at the gsc compile stage.
    /// <see cref="CSharpProjectLoader.LoadProjectWithReferencesAsync"/> returns
    /// the app first followed by its transitively referenced C# projects, so the
    /// sibling's source documents are available for translation.
    /// </summary>
    [Fact]
    public async Task LoadProjectWithReferencesAsync_IncludesReferencedSiblingProject()
    {
        string root = NewScratchDir("with-references");
        File.WriteAllText(Path.Combine(root, "Directory.Build.props"), "<Project></Project>");

        string libDir = Path.Combine(root, "Lib");
        Directory.CreateDirectory(libDir);
        File.WriteAllText(Path.Combine(libDir, "Lib.csproj"), @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(libDir, "IWidget.cs"),
            "namespace Lib { public interface IWidget { int Value { get; } } }");

        string appDir = Path.Combine(root, "App");
        Directory.CreateDirectory(appDir);
        File.WriteAllText(Path.Combine(appDir, "App.csproj"), @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\Lib\Lib.csproj"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(appDir, "Widget.cs"),
            "namespace App { public class Widget : Lib.IWidget { public int Value => 42; } }");

        System.Collections.Generic.IReadOnlyList<LoadedCSharpProject> projects =
            await CSharpProjectLoader.LoadProjectWithReferencesAsync(Path.Combine(appDir, "App.csproj"));

        Assert.True(projects.Count >= 2, "Expected the app project plus its referenced sibling.");
        Assert.Contains(
            projects[0].Documents,
            d => d.FilePath.Replace('\\', '/').EndsWith("App/Widget.cs", StringComparison.Ordinal));
        Assert.Contains(
            projects.Skip(1).SelectMany(p => p.Documents),
            d => d.FilePath.Replace('\\', '/').EndsWith("Lib/IWidget.cs", StringComparison.Ordinal));
    }

    /// <summary>
    /// Issue #2412 regression guard: on a fresh, never-restored/never-built
    /// sibling project (the shape <see cref="LoadProjectWithReferencesAsync_IncludesReferencedSiblingProject"/>
    /// exercises), MSBuildWorkspace cannot resolve a prebuilt output assembly
    /// for the <c>ProjectReference</c>, so it always keeps the sibling as a
    /// source <see cref="Project"/> in the solution regardless of the
    /// <c>LoadMetadataForReferencedProjects</c> setting — that test alone would
    /// NOT have caught this bug. Once the sibling has actually been restored
    /// and built (its real-world state — e.g. any already-built solution like
    /// Oahu.Core referencing Oahu.Data/Oahu.Foundation/Oahu.Decrypt), a
    /// prebuilt <c>bin/</c> output exists for MSBuildWorkspace to substitute,
    /// and setting <c>LoadMetadataForReferencedProjects = true</c> makes it
    /// collapse the sibling <c>ProjectReference</c> into a pure metadata
    /// reference — dropping it from <c>Solution.Projects</c> entirely and
    /// silently degrading <see cref="CSharpProjectLoader.LoadProjectWithReferencesAsync"/>
    /// to returning only the primary project. This regressed cross-project
    /// oblivious-nullability taint analysis (Refs #914's sibling-source
    /// requirement) because the sibling's source was never available to
    /// analyze. <see cref="CSharpProjectLoader.LoadProjectWithReferencesAsync"/>
    /// must not set that flag.
    /// </summary>
    [Fact]
    public async Task LoadProjectWithReferencesAsync_IncludesReferencedSiblingProject_WhenSiblingIsPrebuilt()
    {
        string root = NewScratchDir("with-prebuilt-reference");
        File.WriteAllText(Path.Combine(root, "Directory.Build.props"), "<Project></Project>");

        string libDir = Path.Combine(root, "Lib");
        Directory.CreateDirectory(libDir);
        string libProjectPath = Path.Combine(libDir, "Lib.csproj");
        File.WriteAllText(libProjectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(libDir, "IWidget.cs"),
            "namespace Lib { public interface IWidget { int Value { get; } } }");

        string appDir = Path.Combine(root, "App");
        Directory.CreateDirectory(appDir);
        File.WriteAllText(Path.Combine(appDir, "App.csproj"), @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include=""..\Lib\Lib.csproj"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(appDir, "Widget.cs"),
            "namespace App { public class Widget : Lib.IWidget { public int Value => 42; } }");

        // Reproduce the real-world precondition (Refs #2412): the sibling has
        // already been restored and built, so a prebuilt output assembly
        // exists on disk for MSBuildWorkspace to (incorrectly, if the buggy
        // flag were set) substitute in place of the source Project.
        RunDotnetBuild(libProjectPath);

        System.Collections.Generic.IReadOnlyList<LoadedCSharpProject> projects =
            await CSharpProjectLoader.LoadProjectWithReferencesAsync(Path.Combine(appDir, "App.csproj"));

        Assert.True(
            projects.Count >= 2,
            "Expected the app project plus its prebuilt referenced sibling as a source project.");
        Assert.Contains(
            projects[0].Documents,
            d => d.FilePath.Replace('\\', '/').EndsWith("App/Widget.cs", StringComparison.Ordinal));
        Assert.Contains(
            projects.Skip(1).SelectMany(p => p.Documents),
            d => d.FilePath.Replace('\\', '/').EndsWith("Lib/IWidget.cs", StringComparison.Ordinal));
    }

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet", $"build \"{projectPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(
            process.ExitCode == 0,
            $"Prerequisite `dotnet build` failed (exit {process.ExitCode}); cannot exercise the prebuilt-sibling path.\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    /// <summary>
    /// Issue #2321: writes a buildable console project referencing
    /// <c>Newtonsoft.Json 12.0.1</c>, whose known high-severity vulnerability
    /// (GHSA-5crp-9r3c-p9vr) NuGet reports as warning NU1903 during restore —
    /// the exact benign advisory shape this policy must exempt. An empty
    /// <c>Directory.Build.props</c> override stops MSBuild's directory search
    /// from climbing to this repo's own root props (which sets
    /// <c>TreatWarningsAsErrors</c>), matching this file's other scratch
    /// projects and keeping the test independent of that repo-wide setting.
    /// </summary>
    private static void WriteVulnerablePackageProject(string projectDir, string projectFileName)
    {
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, projectFileName);
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include=""Newtonsoft.Json"" Version=""12.0.1"" />
  </ItemGroup>
</Project>
");
        File.WriteAllText(
            Path.Combine(projectDir, "Program.cs"),
            "public class Program { public static void Main() { } }");

        // Issue #2321: the advisory only surfaces through MSBuildWorkspace once
        // the project has an on-disk obj/project.assets.json to replay — same
        // as any already-restored/built app cs2gs is pointed at in practice (a
        // brand-new, never-restored project simply has no resolved package
        // assets for OpenProjectAsync to evaluate against). Run a real
        // `dotnet restore` here to reproduce that real-world precondition.
        RunDotnetRestore(projectPath);
    }

    private static void RunDotnetRestore(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet", $"restore \"{projectPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        // `dotnet restore` itself exits 0 here because the vulnerability is a
        // plain warning (not elevated) under the empty Directory.Build.props
        // override — a non-zero exit means something unrelated broke restore
        // (e.g. no network access to nuget.org), which every assertion below
        // would otherwise misattribute to the policy under test.
        Assert.True(
            process.ExitCode == 0,
            $"Prerequisite `dotnet restore` failed (exit {process.ExitCode}); cannot exercise the NuGet audit advisory path.\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }
}
