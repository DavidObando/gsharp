// <copyright file="Issue1911ExplicitInterfaceImplementationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1911: a C# explicit interface implementation
/// (<c>string IGreeter.Greet() { ... }</c>, an <c>ExplicitInterfaceSpecifierSyntax</c>
/// on the method) was lowered to a plain method whose visibility was mapped
/// straight from Roslyn's <see cref="Microsoft.CodeAnalysis.Accessibility.Private"/>
/// (an explicit impl has no accessibility keyword, so Roslyn reports it as
/// private). Two symptoms followed:
/// <list type="bullet">
/// <item>alone, the emitted <c>private func Greet()</c> type-checked (name
/// match is enough for gsc's binder) but failed <c>ilverify</c> with "Class
/// implements interface but not method", because a <c>private</c> G# method
/// is never wired into the CLR <c>InterfaceImpl</c> v-table slot;</item>
/// <item>alongside a same-name public method, translating both produced an
/// exact-signature duplicate (GS0264).</item>
/// </list>
/// The #1911 fix forced explicit implementations public and dropped
/// colliding duplicates with an <c>Unsupported</c> diagnostic. Issue #2010
/// (see <c>Issue2010ExplicitInterfaceImplementationTests</c>) replaced that
/// with a full-fidelity fix keyed on a reserved mangled name; issue #2362's
/// ADR-0149 redesign (see that class's doc comment) replaced the mangled
/// name with a first-class explicit-interface qualifier clause
/// (<c>func (IGreeter) Greet()</c>) that keeps the member's own plain source
/// name — the underlying full-fidelity guarantee (no collision, no drop,
/// C#-faithful visibility) is unchanged.
/// </summary>
public class Issue1911ExplicitInterfaceImplementationTests
{
    /// <summary>
    /// A lone explicit interface implementation translates to a method
    /// carrying an ADR-0149 explicit-interface qualifier clause
    /// (<c>func (IGreeter) Greet()</c>) with C#-faithful (non-public)
    /// visibility — the emitter fills the interface's CLR slot via an
    /// explicit MethodImpl row rather than requiring public/name-based
    /// dispatch.
    /// </summary>
    [Fact]
    public void LoneExplicitImplementation_TranslatesToExplicitInterfaceClauseMethod()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
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
            return ""hello-explicit"";
        }
    }
}");
        string printed = GSharpPrinter.Print(unit);

        Assert.Contains("private func (IGreeter) Greet() string {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported && d.Message.Contains("explicit interface", StringComparison.OrdinalIgnoreCase));
        AssertRoundTripParses(printed);
    }

    /// <summary>
    /// End-to-end (issue #1911 DoD): the re-enabled
    /// <c>corpus/grid/G06-Types-Console</c> grid fixture (its
    /// <c>ExplicitInterfaceSpecifierFixture</c>) migrates fully green —
    /// translate, compile, ilverify, and stdout parity all pass — proving the
    /// ADR-0149 explicit-interface-clause fix at the real
    /// <c>gsc</c>/<c>ilverify</c> level, not just in-memory translation.
    /// Gated on the compiler artifact and the <c>dotnet-ilverify</c> tool
    /// being present, like the other e2e tests.
    /// </summary>
    [Fact]
    public async Task G06TypesConsole_MigratesGreen_EndToEnd()
    {
        string compiler = FindCompiler();
        if (compiler is null || !IlVerifyToolAvailable())
        {
            return;
        }

        string corpus = ResolveCorpusDir();
        string outRoot = NewOutputRoot("g06-explicit-interface-e2e");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options);

        CorpusApp g06 = CorpusDiscovery.FindById(corpus, "corpus/G06-Types-Console");
        Assert.NotNull(g06);

        RunResult result = await pipeline.RunAsync(new[] { g06 });
        AppResult app = Assert.Single(result.Apps);

        Assert.True(
            app.Succeeded,
            "corpus/G06-Types-Console must migrate green end-to-end (issue #1911). Failure category: " +
                (app.FailureCategory ?? "<none>") + "; artifacts: " + string.Join(", ", app.Artifacts));
        Assert.Empty(app.Artifacts);
        Assert.All(app.Stages, s => Assert.Equal("passed", s.Status));
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }

    private static bool IlVerifyToolAvailable()
    {
        if (!IlVerifyRunner.IsEnabled)
        {
            return true;
        }

        try
        {
            var runner = new IlVerifyRunner();
            var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = runner.RepoRoot,
            };
            foreach (string arg in new[] { "tool", "run", "ilverify", "--version" })
            {
                psi.ArgumentList.Add(arg);
            }

            using var proc = System.Diagnostics.Process.Start(psi);
            proc.StandardOutput.ReadToEnd();
            proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode == 0)
            {
                return true;
            }

            var restore = new System.Diagnostics.ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = runner.RepoRoot,
            };
            foreach (string arg in new[] { "tool", "restore" })
            {
                restore.ArgumentList.Add(arg);
            }

            using var rp = System.Diagnostics.Process.Start(restore);
            rp.StandardOutput.ReadToEnd();
            rp.StandardError.ReadToEnd();
            rp.WaitForExit();
            return rp.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
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

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate tools/cs2gs/corpus above " + AppContext.BaseDirectory);
    }
}
