// <copyright file="TranslateStageCSharpBindingErrorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import System.Threading.Tasks
import Xunit

/// Issue #2842: (cref:TranslateStage)'s only load gate is
/// `LoadedCSharpProject.WorkspaceLoadFailed` (CS2GS0001), which fires
/// solely when MSBuild could not open the project at all. Ordinary C#
/// compiler errors were collected by
/// `CSharpProjectLoader.SignificantDiagnostics` into
/// `LoadedCSharpProject.LoadDiagnostics` and then never inspected again,
/// so a project whose C# does NOT bind was translated anyway — silently, with
/// no signal anywhere in the run.
///
/// That silence is what made #2842 so hard to diagnose. cs2gs binds each
/// `ProjectReference` against the sibling's on-disk reference assembly
/// (`obj/<Config>/ref/*.dll`), so a STALE artifact makes a single
/// member disappear while its containing type still resolves. Roslyn hands the
/// translator an error type with a null symbol, every nullability predicate
/// keyed on that symbol answers "no", and the emitted G# loses a `!!` it
/// needed — surfacing only as an inexplicable `gsc` GS0156 far from the
/// real cause.
///
/// The stage must therefore REPORT C# binding errors while still PASSING, so
/// the corpus fixtures that carry a deliberate C# error to exercise later
/// stages (`CompileGap-Library`) keep working and no triage artifact,
/// fingerprint, or gap-ledger entry changes.
open class TranslateStageCSharpBindingErrorTests {
    /// A project whose C# does not bind must still PASS the Translate stage
    /// (non-fatal by design) and must leave the offending diagnostic in
    /// `<AppRunDir>/translate.log`, together with the stale-artifact
    /// hint that explains the most common cause.
    @Fact
    async func TranslateStage_CSharpBindingError_PassesAndIsNotedInTranslateLog() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-csharp-binding-error")
        let projectPath = WriteProject(
            projectDir,
            "Unbound.csproj",
            "public class Probe { public int Run(int value) { return UndefinedHelper(value); } }"
        )
        let logContent = await RunTranslateAndReadLogAsync(compiler, projectDir, projectPath, "test/UnboundMember")
        // The C# error itself, verbatim enough to identify the offending symbol.
        Assert.Contains("CS0103", logContent)
        Assert.Contains("UndefinedHelper", logContent)
        // The header naming the count and the stale-reference-assembly hint —
        // the whole point of the report is that a reader can act on it.
        Assert.Contains("C# binding errors", logContent)
        Assert.Contains("non-fatal", logContent)
        Assert.Contains("reference assembly", logContent)
    }

    /// The exact #2842 shape: the containing type resolves but a MEMBER does
    /// not (CS1061), which is what a stale reference assembly produces. This
    /// pins the case that previously degraded translation silently rather than
    /// only the blunt "identifier does not exist" form above.
    @Fact
    async func TranslateStage_MissingMemberBindingError_IsNotedInTranslateLog() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-csharp-missing-member")
        let projectPath = WriteProject(projectDir, "MissingMember.csproj", `public class Entity { public string Present { get; set; } }
public class Consumer { public string Read(Entity e) { string reason = e.FailureReason; return reason; } }`)
        let logContent = await RunTranslateAndReadLogAsync(compiler, projectDir, projectPath, "test/MissingMember")
        Assert.Contains("CS1061", logContent)
        Assert.Contains("FailureReason", logContent)
        Assert.Contains("C# binding errors", logContent)
    }

    /// Non-vacuity control: a project that binds cleanly must produce NO
    /// binding-error report, so the assertions above cannot pass merely
    /// because the header is always written.
    @Fact
    async func TranslateStage_CleanProject_WritesNoBindingErrorNote() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-csharp-clean")
        let projectPath = WriteProject(
            projectDir,
            "Clean.csproj",
            "public class Probe { public int Run(int value) { return value + 1; } }"
        )
        let outRoot = NewOutputRoot("translate-csharp-clean")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let app = CorpusApp("test/CleanBinding", projectPath, TargetKind.Exe)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.True(appResult.Succeeded, "A cleanly binding project must pass the Translate stage.")
        let translateLogs = Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)
        let logContent = if translateLogs.Length == 0 {
            string.Empty
        } else {
            File.ReadAllText(translateLogs[0])
        }
        Assert.DoesNotContain("C# binding errors", logContent)
    }

    shared {
        private async func RunTranslateAndReadLogAsync(
            compiler string,
            projectDir string,
            projectPath string,
            appId string
        ) string {
            let outRoot = NewOutputRoot(Path.GetFileName(projectDir))
            let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
            let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
            let app = CorpusApp(appId, projectPath, TargetKind.Exe)
            let result = await pipeline.RunAsync([]CorpusApp{app})
            let appResult = Assert.Single(result.Apps)
            // Non-fatal by design: the deliberate-C#-error corpus fixtures
            // (CompileGap-Library) rely on the Translate stage passing so the
            // Compile stage can produce their triage artifact.
            Assert.True(
                appResult.Succeeded,
                "A C# binding error must be REPORTED, not made fatal — corpus fixtures carry deliberate C# errors."
            )
            let translateLogs = Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)
            let translateLog = Assert.Single(translateLogs)
            return File.ReadAllText(translateLog)
        }

        /// Writes a minimal buildable console project plus one source file. The
        /// empty `Directory.Build.props` override stops MSBuild's directory
        /// search from climbing to this repo's own root props (which sets
        /// `TreatWarningsAsErrors`), matching the convention already used in
        /// `CSharpProjectLoaderDiagnosticsTests` and
        /// `TranslateStageNuGetAuditAdvisoryTests`.
        private func WriteProject(projectDir string, projectFileName string, source string) string {
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
            let projectPath = Path.Combine(projectDir, projectFileName)
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`)
            File.WriteAllText(
                Path.Combine(projectDir, "Program.cs"),
                "public class Program { public static void Main() { } }"
            )
            File.WriteAllText(Path.Combine(projectDir, "Probe.cs"), source)
            return projectPath
        }

        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func NewScratchDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
