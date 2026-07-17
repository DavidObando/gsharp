// <copyright file="Issue2412SdkBackedCrossProjectObliviousNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #2412's reopening: PR #2413 fixed
/// cross-project oblivious-nullability taint (issue #2412) only for
/// <c>TranslateStage</c>'s NO-<c>--via-sdk</c> path — its own regression suite
/// (<see cref="Issue2412CrossProjectObliviousNullabilityTranslationTests"/>)
/// exercises the translator directly, in-memory, never through the real
/// pipeline. A fresh, default (<c>--via-sdk</c>, <see cref="PipelineOptions.CompileViaSdk"/>
/// true) <c>cs2gs migrate</c> on an on-disk, multi-project corpus with a
/// PREBUILT sibling (the real Oahu.Core precondition — its siblings
/// Oahu.Data/Oahu.Foundation/Oahu.Decrypt are always already restored and
/// built) still emitted the bare, un-forgiven read: <c>TranslateStage</c>'s
/// project-loading step was gated on <c>CompileViaSdk</c> itself, so the
/// default path only ever loaded the app's OWN project
/// (<c>CSharpProjectLoader.LoadProjectAsync</c>, no siblings at all) — the
/// <see cref="Cs2Gs.Translator.TranslationContext.SiblingCompilations"/> list
/// #2413 introduced was always a single-element list in this path, so the
/// cross-compilation <c>ObliviousNullabilityAnalyzer.IsTainted</c> overload had
/// nothing to redirect to. This test exercises the true default pipeline
/// end-to-end (<see cref="MigrationPipeline"/> with <see cref="TranslateStage"/>
/// + <see cref="CompileStage"/>, <see cref="PipelineOptions.CompileViaSdk"/>
/// left at its true default) against a real, on-disk, MSBuild-loaded
/// multi-project corpus (app + two sibling projects, one already built before
/// the run) and proves the fix downstream: the emitted G# actually contains the
/// <c>!!</c> forgiveness and the real <c>dotnet build</c> (via the packed
/// <c>Gsharp.NET.Sdk</c>) actually succeeds — not just that an in-memory
/// translator call produces the right string.
/// </summary>
public class Issue2412SdkBackedCrossProjectObliviousNullabilityTests
{
    [Fact]
    public async Task Pipeline_ViaSdkDefault_MultiProjectCorpus_PrebuiltSibling_CrossProjectTaint_EmitsForgivenessAndCompiles()
    {
        string compiler = FindSiblingTool("Compiler", "gsc.dll");
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        if (compiler is null || repoRoot is null ||
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) is null)
        {
            // Gated exactly like every other live --via-sdk e2e test in this
            // suite (e.g. Issue2319AppLocalNbgvPackageReferenceTests): build
            // GSharp.sln (which also packs Gsharp.NET.Sdk) first.
            return;
        }

        string sourceRoot = NewScratchDir("issue2412-via-sdk");
        (string libProjectPath, string libEnabledProjectPath, string appProjectPath) = WriteFixture(sourceRoot);

        // Issue #2412 (reopened)'s exact real-world precondition: Oahu.Core's
        // siblings (Oahu.Data/Oahu.Foundation/Oahu.Decrypt) are always already
        // restored and built by the time Oahu.Core is migrated. Prebuild ONE
        // sibling directly (outside the pipeline) so MSBuildWorkspace sees a
        // real prebuilt output assembly on disk for its ProjectReference —
        // the exact condition #2413's own CSharpProjectLoaderDiagnosticsTests
        // regression guards at the loader level; this test proves the SAME
        // precondition does not break the fix end-to-end through the real
        // default pipeline.
        RunDotnetBuild(libProjectPath);

        string outputRoot = NewOutputRoot("issue2412-via-sdk");
        RunResult firstRun = await RunPipeline(outputRoot, sourceRoot, libProjectPath, libEnabledProjectPath, appProjectPath, compiler);

        AppResult firstAppResult = firstRun.Apps.Single(a => a.AppId == "test/App");
        Assert.True(
            firstAppResult.Succeeded,
            "Expected the --via-sdk build to succeed for the App project. Stages: " +
                string.Join("; ", firstAppResult.Stages.Select(s => s.Stage + "=" + s.Status)));

        string firstConsumerGs = ReadEmittedFile(outputRoot, firstRun.RunId, "test_App", "Consumer.gs");
        AssertExpectedForgiveness(firstConsumerGs);

        // Issue #2412 (reopened)'s own regression-test requirement: no
        // dependence on stale caches. Re-run the identical migration from
        // scratch (a fresh run id/output directory, but the SAME already
        // packed-and-fed local Gsharp.NET.Sdk nupkg and the SAME prebuilt
        // sibling output on disk) and confirm the forgiveness and the compile
        // success are fully deterministic, not an artifact of the first run's
        // now-populated NuGet/MSBuild caches.
        RunResult secondRun = await RunPipeline(outputRoot, sourceRoot, libProjectPath, libEnabledProjectPath, appProjectPath, compiler);
        AppResult secondAppResult = secondRun.Apps.Single(a => a.AppId == "test/App");
        Assert.True(
            secondAppResult.Succeeded,
            "Expected the second (repeated) --via-sdk run to succeed identically. Stages: " +
                string.Join("; ", secondAppResult.Stages.Select(s => s.Stage + "=" + s.Status)));

        string secondConsumerGs = ReadEmittedFile(outputRoot, secondRun.RunId, "test_App", "Consumer.gs");
        Assert.Equal(Compact(firstConsumerGs), Compact(secondConsumerGs));
        AssertExpectedForgiveness(secondConsumerGs);
    }

    private static async Task<RunResult> RunPipeline(
        string outputRoot,
        string sourceRoot,
        string libProjectPath,
        string libEnabledProjectPath,
        string appProjectPath,
        string compiler)
    {
        var options = new PipelineOptions
        {
            GscPath = compiler,
            OutputRoot = outputRoot,
            SourceRoot = sourceRoot,

            // Left at its true default (issue #2261): this is exactly the
            // path issue #2412's reopening reported as still broken.
        };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage(), new CompileStage() });

        // All three projects are migrated together as their own corpus apps —
        // the exact real-world shape of the reported command
        // (`cs2gs migrate --corpus <Oahu>/src --app Foundation --app Decrypt
        // --app Data --app Core`): every project in the dependency chain is
        // itself a selected app, and Lib is ADDITIONALLY prebuilt on disk
        // before this call (mirroring an already-built solution).
        var libApp = new CorpusApp("test/Lib", libProjectPath, TargetKind.Library);
        var libEnabledApp = new CorpusApp("test/LibEnabled", libEnabledProjectPath, TargetKind.Library);
        var appApp = new CorpusApp("test/App", appProjectPath, TargetKind.Library);

        return await pipeline.RunAsync(new[] { libApp, libEnabledApp, appApp });
    }

    private static void AssertExpectedForgiveness(string consumerGs)
    {
        string compact = Compact(consumerGs);

        // Property control (interface-edge taint — the exact real Oahu
        // AaxExporter.Asin/IBookMeta shape: the tainting `?.` evidence and the
        // interface-implementation edge both live in the sibling, Impl.Name
        // implements IFoo.Name).
        Assert.Contains("Target{Name: foo.Name!!}", compact);

        // Method control (direct return-position taint from the sibling's own
        // `?.`-seeded expression body).
        Assert.Contains("Target{Label: widget.GetLabel()!!}", compact);

        // Field control (direct `= null` seed on the sibling's own field).
        Assert.Contains("Target{Tag: widget.Tag!!}", compact);

        // Generic control: the cross-project-tainted interface member read
        // THROUGH a generic wrapper type instantiated with it (Box<IFoo>) —
        // proves the fix is not defeated by an intervening generic
        // substitution between the sibling declaration and the consumption
        // site. `Wrapped` itself also gets `!!`: it is a receiver-position
        // read of an oblivious sibling member, and the pre-existing (#2113/
        // #2202) blanket "unknowably-nullable oblivious external member"
        // receiver rule intentionally still applies to it — this is a
        // harmless, compiling extra forgiveness, not a defect. (An earlier
        // version of this fix tried to discriminate sibling-project members
        // out of that receiver rule so only `Value.Name` — not `Wrapped`
        // itself — got forgiven; that was empirically PROVEN, against the
        // real Oahu.Core corpus, to regress 47 -> 90 compile errors and to
        // newly break the previously-clean Oahu.Data app. This fix
        // deliberately leaves that receiver rule untouched and relies solely
        // on restoring `TranslateStage`'s sibling-compilation loading, which
        // resolves the reopened issue with zero new errors.)
        Assert.Contains("Target{First: widget.Wrapped!!.Value.Name!!}", compact);

        // Negative control: a sibling member with NO taint evidence anywhere
        // must stay a bare, non-forgiven read — the fix must not over-promote
        // every cross-project symbol wholesale.
        Assert.Contains("Target{Untainted: widget.FixedLabel}", compact);
        Assert.DoesNotContain("widget.FixedLabel!!", compact);

        // Genuinely-nullable negative: a DIFFERENT sibling project that is
        // nullable-ENABLED (a real `string?` annotation, not oblivious taint)
        // must be completely unaffected by this fix — same forgiveness an
        // intra-project nullable-enabled reference already gets, driven
        // entirely by its own declared annotation.
        Assert.Contains("Target{A: e.NonNull, B: e.Nullable!!}", compact);
    }

    private static (string LibProjectPath, string LibEnabledProjectPath, string AppProjectPath) WriteFixture(string sourceRoot)
    {
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>");

        string libDir = Path.Combine(sourceRoot, "Lib");
        Directory.CreateDirectory(libDir);
        string libProjectPath = Path.Combine(libDir, "Lib.csproj");
        File.WriteAllText(libProjectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(libDir, "Types.cs"), """
            namespace Lib
            {
                public interface IFoo
                {
                    string Name { get; }
                }

                public class Impl : IFoo
                {
                    public Impl Other { get; set; }

                    public string Name => Other?.Name;
                }

                public class Box<T>
                {
                    public T Value { get; set; }
                }

                public class Widget
                {
                    public Widget Other { get; set; }

                    public string GetLabel() => Other?.GetLabel();

                    public string Tag = null;

                    public Box<IFoo> Wrapped { get; set; }

                    public string FixedLabel => "fixed";
                }
            }
            """);

        string libEnabledDir = Path.Combine(sourceRoot, "LibEnabled");
        Directory.CreateDirectory(libEnabledDir);
        string libEnabledProjectPath = Path.Combine(libEnabledDir, "LibEnabled.csproj");
        File.WriteAllText(libEnabledProjectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(libEnabledDir, "Enabled.cs"), """
            namespace LibEnabled
            {
                public class Enabled
                {
                    public string NonNull => "x";

                    public string? Nullable => null;
                }
            }
            """);

        string appDir = Path.Combine(sourceRoot, "App");
        Directory.CreateDirectory(appDir);
        string appProjectPath = Path.Combine(appDir, "App.csproj");
        File.WriteAllText(appProjectPath, """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="../Lib/Lib.csproj" />
                <ProjectReference Include="../LibEnabled/LibEnabled.csproj" />
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(appDir, "Consumer.cs"), """
            using Lib;
            using LibEnabled;

            namespace App
            {
                public class Target
                {
                    public string Name { get; set; }

                    public string Label { get; set; }

                    public string Tag { get; set; }

                    public string First { get; set; }

                    public string Untainted { get; set; }

                    public string A { get; set; }

                    public string B { get; set; }
                }

                public class Consumer
                {
                    public Target FromInterfaceProperty(IFoo foo) => new Target { Name = foo.Name };

                    public Target FromMethod(Widget widget) => new Target { Label = widget.GetLabel() };

                    public Target FromField(Widget widget) => new Target { Tag = widget.Tag };

                    public Target FromGenericWrapper(Widget widget) => new Target { First = widget.Wrapped.Value.Name };

                    public Target FromUntainted(Widget widget) => new Target { Untainted = widget.FixedLabel };

                    public Target FromNullableEnabledSibling(Enabled e) => new Target { A = e.NonNull, B = e.Nullable! };
                }
            }
            """);

        return (libProjectPath, libEnabledProjectPath, appProjectPath);
    }

    private static string ReadEmittedFile(string outputRoot, string runId, string sanitizedAppId, string fileName)
    {
        string appRunDir = Path.Combine(outputRoot, runId, sanitizedAppId);
        string[] matches = Directory.GetFiles(appRunDir, fileName, SearchOption.AllDirectories);
        Assert.True(matches.Length == 1, $"Expected exactly one '{fileName}' under '{appRunDir}', found {matches.Length}.");
        return File.ReadAllText(matches[0]);
    }

    // Collapses incidental whitespace/newlines around composite-literal braces
    // so an assertion on `Target{Name: foo.Name!!}` is not sensitive to the
    // printer's exact line-wrapping.
    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));

    private static void RunDotnetBuild(string projectPath)
    {
        var startInfo = new System.Diagnostics.ProcessStartInfo("dotnet", $"build \"{projectPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using System.Diagnostics.Process process = System.Diagnostics.Process.Start(startInfo);
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(
            process.ExitCode == 0,
            $"Prerequisite `dotnet build` failed (exit {process.ExitCode}); cannot exercise the prebuilt-sibling path.\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "scratch-projects", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindSiblingTool(string projectDirName, string dllName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, projectDirName, dllName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
