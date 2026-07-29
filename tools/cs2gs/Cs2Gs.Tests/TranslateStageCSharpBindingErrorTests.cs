// <copyright file="TranslateStageCSharpBindingErrorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2842: <see cref="TranslateStage"/>'s only load gate is
/// <c>LoadedCSharpProject.WorkspaceLoadFailed</c> (CS2GS0001), which fires
/// solely when MSBuild could not open the project at all. Ordinary C#
/// compiler errors were collected by
/// <c>CSharpProjectLoader.SignificantDiagnostics</c> into
/// <c>LoadedCSharpProject.LoadDiagnostics</c> and then never inspected again,
/// so a project whose C# does NOT bind was translated anyway — silently, with
/// no signal anywhere in the run.
/// <para>
/// That silence is what made #2842 so hard to diagnose. cs2gs binds each
/// <c>ProjectReference</c> against the sibling's on-disk reference assembly
/// (<c>obj/&lt;Config&gt;/ref/*.dll</c>), so a STALE artifact makes a single
/// member disappear while its containing type still resolves. Roslyn hands the
/// translator an error type with a null symbol, every nullability predicate
/// keyed on that symbol answers "no", and the emitted G# loses a <c>!!</c> it
/// needed — surfacing only as an inexplicable <c>gsc</c> GS0156 far from the
/// real cause.
/// </para>
/// <para>
/// The stage must therefore REPORT C# binding errors while still PASSING, so
/// the corpus fixtures that carry a deliberate C# error to exercise later
/// stages (<c>CompileGap-Library</c>) keep working and no triage artifact,
/// fingerprint, or gap-ledger entry changes.
/// </para>
/// </summary>
public class TranslateStageCSharpBindingErrorTests
{
    /// <summary>
    /// A project whose C# does not bind must still PASS the Translate stage
    /// (non-fatal by design) and must leave the offending diagnostic in
    /// <c>&lt;AppRunDir&gt;/translate.log</c>, together with the stale-artifact
    /// hint that explains the most common cause.
    /// </summary>
    [Fact]
    public async Task TranslateStage_CSharpBindingError_PassesAndIsNotedInTranslateLog()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-csharp-binding-error");
        string projectPath = WriteProject(
            projectDir,
            "Unbound.csproj",
            "public class Probe { public int Run(int value) { return UndefinedHelper(value); } }");

        string logContent = await RunTranslateAndReadLogAsync(compiler, projectDir, projectPath, "test/UnboundMember");

        // The C# error itself, verbatim enough to identify the offending symbol.
        Assert.Contains("CS0103", logContent);
        Assert.Contains("UndefinedHelper", logContent);

        // The header naming the count and the stale-reference-assembly hint —
        // the whole point of the report is that a reader can act on it.
        Assert.Contains("C# binding errors", logContent);
        Assert.Contains("non-fatal", logContent);
        Assert.Contains("reference assembly", logContent);
    }

    /// <summary>
    /// The exact #2842 shape: the containing type resolves but a MEMBER does
    /// not (CS1061), which is what a stale reference assembly produces. This
    /// pins the case that previously degraded translation silently rather than
    /// only the blunt "identifier does not exist" form above.
    /// </summary>
    [Fact]
    public async Task TranslateStage_MissingMemberBindingError_IsNotedInTranslateLog()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-csharp-missing-member");
        string projectPath = WriteProject(
            projectDir,
            "MissingMember.csproj",
            @"public class Entity { public string Present { get; set; } }
public class Consumer { public string Read(Entity e) { string reason = e.FailureReason; return reason; } }");

        string logContent = await RunTranslateAndReadLogAsync(compiler, projectDir, projectPath, "test/MissingMember");

        Assert.Contains("CS1061", logContent);
        Assert.Contains("FailureReason", logContent);
        Assert.Contains("C# binding errors", logContent);
    }

    /// <summary>
    /// Non-vacuity control: a project that binds cleanly must produce NO
    /// binding-error report, so the assertions above cannot pass merely
    /// because the header is always written.
    /// </summary>
    [Fact]
    public async Task TranslateStage_CleanProject_WritesNoBindingErrorNote()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-csharp-clean");
        string projectPath = WriteProject(
            projectDir,
            "Clean.csproj",
            "public class Probe { public int Run(int value) { return value + 1; } }");

        string outRoot = NewOutputRoot("translate-csharp-clean");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });
        var app = new CorpusApp("test/CleanBinding", projectPath, TargetKind.Exe);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        Assert.True(appResult.Succeeded, "A cleanly binding project must pass the Translate stage.");

        string[] translateLogs = Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories);
        string logContent = translateLogs.Length == 0 ? string.Empty : File.ReadAllText(translateLogs[0]);
        Assert.DoesNotContain("C# binding errors", logContent);
    }

    private static async Task<string> RunTranslateAndReadLogAsync(
        string compiler, string projectDir, string projectPath, string appId)
    {
        string outRoot = NewOutputRoot(Path.GetFileName(projectDir));
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });
        var app = new CorpusApp(appId, projectPath, TargetKind.Exe);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);

        // Non-fatal by design: the deliberate-C#-error corpus fixtures
        // (CompileGap-Library) rely on the Translate stage passing so the
        // Compile stage can produce their triage artifact.
        Assert.True(
            appResult.Succeeded,
            "A C# binding error must be REPORTED, not made fatal — corpus fixtures carry deliberate C# errors.");

        string[] translateLogs = Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories);
        string translateLog = Assert.Single(translateLogs);
        return File.ReadAllText(translateLog);
    }

    /// <summary>
    /// Writes a minimal buildable console project plus one source file. The
    /// empty <c>Directory.Build.props</c> override stops MSBuild's directory
    /// search from climbing to this repo's own root props (which sets
    /// <c>TreatWarningsAsErrors</c>), matching the convention already used in
    /// <c>CSharpProjectLoaderDiagnosticsTests</c> and
    /// <c>TranslateStageNuGetAuditAdvisoryTests</c>.
    /// </summary>
    private static string WriteProject(string projectDir, string projectFileName, string source)
    {
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, projectFileName);
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(Path.Combine(projectDir, "Program.cs"), "public class Program { public static void Main() { } }");
        File.WriteAllText(Path.Combine(projectDir, "Probe.cs"), source);
        return projectPath;
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
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
