// <copyright file="Issue3086GeneratedRegexPipelineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #3086 / #4301: GeneratedRegex partial methods migrate to G# declaring
/// parts, which the SDK build implements with the real Regex generator (gsgen).
@Collection("IlVerifyPipeline")
class Issue3086GeneratedRegexPipelineTests {
    @Fact
    async func GeneratedRegexDeclaringParts_TranslateCompileVerifyAndRun() {
        let compiler string? = FindCompiler()
        let repoRoot string? = GsharpTestProjectRunner.FindRepoRoot()
        if compiler == nil || repoRoot == nil || GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot) == nil ||
            !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3086GeneratedRegex")
        CopyFixture(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3086GeneratedRegex.csproj")
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue3086GeneratedRegex", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{GscPath: compiler, OutputRoot: outputRoot, SourceRoot: sourceRoot},
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        // Issue #4301: each [GeneratedRegex] method is a G# declaring part;
        // gsgen implements it with the real Regex generator during the SDK
        // compile. The const pattern and the named timeout are re-spelled
        // positionally from their values.
        Assert.DoesNotContain("__generatedRegex_", translated, StringComparison.Ordinal)
        // The gsfmt post-pass wraps the long GitHub-URL attribute across lines,
        // so its arguments are checked one at a time. That pattern also
        // backtracks inside a loop, which builds since #4422.
        Assert.Contains("\"^https://(www\\\\.)?github\\\\.com/", translated, StringComparison.Ordinal)
        Assert.Contains("RegexOptions.ExplicitCapture,", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("matchTimeoutMilliseconds", translated, StringComparison.Ordinal)
        Assert.Contains("partial data class GitHubUrl", translated, StringComparison.Ordinal)
        Assert.Contains("private partial func Pattern() Regex;", translated, StringComparison.Ordinal)
        Assert.Contains(
            "@GeneratedRegex(\"^infinite$$$$\", RegexOptions.None, -1)",
            translated,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "@GeneratedRegex(\"^i$$$$\", RegexOptions.IgnoreCase, \"tr-TR\")",
            translated,
            StringComparison.Ordinal
        )
        Assert.Contains("private partial func TurkishI() Regex;", translated, StringComparison.Ordinal)
        Assert.Contains(
            "partial class InstanceRegexOwner {" +
                Environment.NewLine +
                "    @GeneratedRegex(\"^[a-z]+$$$$\")" +
                Environment.NewLine +
                "    partial func LowercaseWords() Regex;",
            translated,
            StringComparison.Ordinal
        )
        Assert.True(
            appResult.Succeeded,
            string.Join("; ", appResult.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status))
        )
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
    }

    @Fact
    async func InlineIgnoreCaseWithoutInvariant_TranslatesToDeclaringParts() {
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3086InlineIgnoreCase")
        CopyFixture(projectDirectory)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), `using System.Text.RegularExpressions;

public static partial class Patterns
{
    [GeneratedRegex("(?i)abc")]
    private static partial Regex GlobalIgnoreCase();

    [GeneratedRegex("(?i:abc)")]
    private static partial Regex ScopedIgnoreCase();

    [GeneratedRegex("(?-i)(?m-i)(?im-s:abc)")]
    private static partial Regex ToggledIgnoreCase();

    [GeneratedRegex("(?-i:abc)")]
    private static partial Regex DisabledIgnoreCase();

    [GeneratedRegex(@"\(\?i\)")]
    private static partial Regex EscapedLiteral();

    [GeneratedRegex("[(?i)]")]
    private static partial Regex CharacterClassLiteral();

    [GeneratedRegex("(?i)abc", RegexOptions.CultureInvariant)]
    private static partial Regex InvariantIgnoreCase();
}

public static class Program
{
    public static void Main()
    {
    }
}`)
        let projectPath = Path.Combine(projectDirectory, "Issue3086GeneratedRegex.csproj")
        let project = await CSharpProjectLoader.LoadProjectAsync(projectPath)
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = project.Documents.Single(
            (candidate LoadedDocument) -> Path.GetFileName(candidate.FilePath) == "Program.cs"
        )
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // The pre-#4301 rewrite constructed the Regex itself and reported
        // culture-sensitive IgnoreCase; the real generator handles it.
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("private partial func GlobalIgnoreCase() Regex;", translated, StringComparison.Ordinal)
        Assert.Contains("private partial func ScopedIgnoreCase() Regex;", translated, StringComparison.Ordinal)
        Assert.Contains("private partial func ToggledIgnoreCase() Regex;", translated, StringComparison.Ordinal)
        Assert.Contains("private partial func DisabledIgnoreCase() Regex;", translated, StringComparison.Ordinal)
        Assert.Contains("private partial func InvariantIgnoreCase() Regex;", translated, StringComparison.Ordinal)
    }

    shared {
        private func CopyFixture(destination string) {
            let source string? = TestFixtureSource.Resolve(
                "tools",
                "cs2gs",
                "Cs2Gs.Tests",
                "Fixtures",
                "Issue3086GeneratedRegex"
            )
            Directory.CreateDirectory(destination)
            for file in Directory.GetFiles(source!!) {
                File.Copy(file, Path.Combine(destination, Path.GetFileName(file)))
            }
        }

        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3086", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
