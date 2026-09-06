// <copyright file="Issue3860TestDocumentationPolicyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Xml.Linq;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Regression coverage for the test-project documentation policy from issue #3860.
/// </summary>
public sealed class Issue3860TestDocumentationPolicyTests : IDisposable
{
    private readonly DirectoryInfo root = Directory.CreateDirectory(Path.Combine(
        RepoRoot.Path,
        "out",
        "test",
        nameof(Issue3860TestDocumentationPolicyTests),
        Guid.NewGuid().ToString("N")));

    [Fact]
    public void InvalidParamNamesFailWithoutPublishingTestDocumentation()
    {
        this.WriteProject();

        var survey = this.Build(treatWarningsAsErrors: false, rebuild: false);

        Assert.Equal(0, survey.ExitCode);
        Assert.Contains("warning CS1572", survey.Output);
        Assert.Contains("warning CS1573", survey.Output);
        Assert.DoesNotContain("CS1591", survey.Output);
        Assert.Single(Directory.GetFiles(
            Path.Combine(this.root.FullName, "obj"),
            "GSharp.InvalidTestDocumentation.xml",
            SearchOption.AllDirectories));
        Assert.Empty(Directory.GetFiles(
            Path.Combine(this.root.FullName, "bin"),
            "GSharp.InvalidTestDocumentation.xml",
            SearchOption.AllDirectories));

        var strict = this.Build(treatWarningsAsErrors: true, rebuild: true);

        Assert.NotEqual(0, strict.ExitCode);
        Assert.Contains("error CS1572", strict.Output);
        Assert.Contains("error CS1573", strict.Output);
        Assert.DoesNotContain("CS1591", strict.Output);
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (this.root.Exists)
        {
            this.root.Delete(recursive: true);
        }
    }

    private (int ExitCode, string Output) Build(bool treatWarningsAsErrors, bool rebuild)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = this.root.FullName,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("build");
        startInfo.ArgumentList.Add("InvalidTestDocumentation.csproj");
        startInfo.ArgumentList.Add("--configuration");
        startInfo.ArgumentList.Add("Release");
        startInfo.ArgumentList.Add("--nologo");
        startInfo.ArgumentList.Add("--verbosity:minimal");
        startInfo.ArgumentList.Add("-p:RestorePackagesWithLockFile=false");
        startInfo.ArgumentList.Add($"-p:TreatWarningsAsErrors={treatWarningsAsErrors.ToString().ToLowerInvariant()}");
        startInfo.ArgumentList.Add($"-p:BaseOutputPath={Path.Combine(this.root.FullName, "bin")}{Path.DirectorySeparatorChar}");
        startInfo.ArgumentList.Add($"-p:BaseIntermediateOutputPath={Path.Combine(this.root.FullName, "obj")}{Path.DirectorySeparatorChar}");
        if (rebuild)
        {
            startInfo.ArgumentList.Add("--no-restore");
            startInfo.ArgumentList.Add("-t:Rebuild");
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Could not start dotnet build.");
        Task<string> standardOutput = process.StandardOutput.ReadToEndAsync();
        Task<string> standardError = process.StandardError.ReadToEndAsync();
        Assert.True(process.WaitForExit(120_000), "dotnet build timed out.");
        Task.WaitAll(standardOutput, standardError);
        return (process.ExitCode, standardOutput.Result + standardError.Result);
    }

    private void WriteProject()
    {
        new XDocument(
            new XElement(
                "Project",
                new XElement(
                    "PropertyGroup",
                    new XElement("IsTestProject", "true")),
                new XElement(
                    "Import",
                    new XAttribute("Project", Path.Combine(RepoRoot.Path, "Directory.Build.props")))))
            .Save(Path.Combine(this.root.FullName, "Directory.Build.props"));

        File.WriteAllText(
            Path.Combine(this.root.FullName, "InvalidTestDocumentation.csproj"),
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <IsPackable>false</IsPackable>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Remove="@(PackageReference)" />
              </ItemGroup>
            </Project>
            """);

        File.WriteAllText(
            Path.Combine(this.root.FullName, "InvalidDocumentation.cs"),
            """
            public static class InvalidDocumentation
            {
                /// <summary>Deliberately stale parameter documentation.</summary>
                /// <param name="stale">A parameter that does not exist.</param>
                public static void Verify(int actual)
                {
                }

                public static void Undocumented()
                {
                }
            }
            """);
    }
}
