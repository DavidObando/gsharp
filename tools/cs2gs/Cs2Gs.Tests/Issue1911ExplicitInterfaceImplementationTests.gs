// <copyright file="Issue1911ExplicitInterfaceImplementationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Regression tests for issue #1911: a C# explicit interface implementation
/// (`string IGreeter.Greet() { ... }`, an `ExplicitInterfaceSpecifierSyntax`
/// on the method) was lowered to a plain method whose visibility was mapped
/// straight from Roslyn's (cref:Microsoft.CodeAnalysis.Accessibility.Private)
/// (an explicit impl has no accessibility keyword, so Roslyn reports it as
/// private). Two symptoms followed:
/// - alone, the emitted `private func Greet()` type-checked (name match is enough for gsc's binder) but
/// failed `ilverify` with "Class implements interface but not method", because a `private` G# method is
/// never wired into the CLR `InterfaceImpl` v-table slot;
/// - alongside a same-name public method, translating both produced an exact-signature duplicate
/// (GS0264).
/// The #1911 fix forced explicit implementations public and dropped
/// colliding duplicates with an `Unsupported` diagnostic. Issue #2010
/// (see `Issue2010ExplicitInterfaceImplementationTests`) replaced that
/// with a full-fidelity fix keyed on a reserved mangled name; issue #2362's
/// ADR-0149 redesign (see that class's doc comment) replaced the mangled
/// name with a first-class explicit-interface qualifier clause
/// (`func (IGreeter) Greet()`) that keeps the member's own plain source
/// name — the underlying full-fidelity guarantee (no collision, no drop,
/// C#-faithful visibility) is unchanged.
open class Issue1911ExplicitInterfaceImplementationTests {
    /// A lone explicit interface implementation translates to a method
    /// carrying an ADR-0149 explicit-interface qualifier clause
    /// (`func (IGreeter) Greet()`) with C#-faithful (non-public)
    /// visibility — the emitter fills the interface's CLR slot via an
    /// explicit MethodImpl row rather than requiring public/name-based
    /// dispatch.
    @Fact
    func LoneExplicitImplementation_TranslatesToExplicitInterfaceClauseMethod() {
        let (unit, context) = Translate(`
namespace Corpus.Issue1911
{
    public interface IGreeter
    {
        string Greet();
    }

    public class QuietHost : IGreeter
    {
        string IGreeter.Greet()
        {
            return "hello-explicit";
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("private func (IGreeter) Greet() string {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "explicit interface",
                StringComparison.OrdinalIgnoreCase
            )
        )
        AssertRoundTripParses(printed)
    }

    /// End-to-end (issue #1911 DoD): the re-enabled
    /// `corpus/grid/G06-Types-Console` grid fixture (its
    /// `ExplicitInterfaceSpecifierFixture`) migrates fully green —
    /// translate, compile, ilverify, and stdout parity all pass — proving the
    /// ADR-0149 explicit-interface-clause fix at the real
    /// `gsc`/`ilverify` level, not just in-memory translation.
    /// Gated on the compiler artifact and the `dotnet-ilverify` tool
    /// being present, like the other e2e tests.
    @Fact
    async func G06TypesConsole_MigratesGreen_EndToEnd() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        let corpus string? = ResolveCorpusDir()
        let outRoot = NewOutputRoot("g06-explicit-interface-e2e")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options)
        let g06 = CorpusDiscovery.FindById(corpus, "corpus/G06-Types-Console")!!
        Assert.NotNull(g06)
        let result = await pipeline.RunAsync([]CorpusApp{g06})
        let app = Assert.Single(result.Apps)
        Assert.True(
            app.Succeeded,
            "corpus/G06-Types-Console must migrate green end-to-end (issue #1911). Failure category: " +
                (app.FailureCategory ?? "<none>") +
                "; artifacts: " +
                string.Join(", ", app.Artifacts)
        )
        Assert.Empty(app.Artifacts)
        Assert.All(app.Stages, (s StageResult) -> Assert.Equal("passed", s.Status))
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }

        private func IlVerifyToolAvailable() bool {
            if !IlVerifyRunner.IsEnabled {
                return true
            }
            try {
                let runner = IlVerifyRunner()
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = runner.RepoRoot!!
                }
                for arg in[]string{"tool", "run", "ilverify", "--version"} {
                    psi.ArgumentList.Add(arg)
                }
                using let proc Process? = Process.Start(psi)
                proc!!.StandardOutput.ReadToEnd()
                proc!!.StandardError.ReadToEnd()
                proc!!.WaitForExit()
                if proc!!.ExitCode == 0 {
                    return true
                }
                let restore = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = runner.RepoRoot!!
                }
                for arg in[]string{"tool", "restore"} {
                    restore.ArgumentList.Add(arg)
                }
                using let rp Process? = Process.Start(restore)
                rp!!.StandardOutput.ReadToEnd()
                rp!!.StandardError.ReadToEnd()
                rp!!.WaitForExit()
                return rp!!.ExitCode == 0
            } catch {
                return false
            }
        }

        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
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

        private func ResolveCorpusDir() string? -> TestFixtureSource.Resolve("tools", "cs2gs", "corpus")
    }
}
