// <copyright file="Issue2351ExtensionMethodImportSynthesisTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2351: <see cref="CSharpTypeMapper.TrackShortenedNamespace"/> records the
/// namespace of every TYPE reference the translator shortens (issue #2211), so a
/// missing <c>using</c> for a shortened type name synthesizes a matching
/// <c>import</c>. An extension-method CALL SITE (<c>key.All(...)</c>) names no
/// type at all — neither <c>Enumerable</c> nor <c>System.Linq</c> appear in its
/// syntax — so that tracking never observed it. A C# file that reaches the
/// extension only through an IMPLICIT <c>using</c> (SDK <c>ImplicitUsings</c>
/// global usings, or a hand-authored <c>GlobalUsings.cs</c>, or a namespace-less
/// source-generator file per ADR-0145) previously round-tripped to G# with the
/// call intact but NO import for its owning namespace at all — unresolvable
/// output (GS0159), exactly the shape observed in Oahu.Diagnostics'
/// <c>ExportCheck.Run</c> (<c>key.All(char.IsAsciiHexDigit)</c>, whose project
/// enables <c>ImplicitUsings</c> and has no explicit <c>using System.Linq;</c>).
/// <para>
/// The fix (<see cref="CSharpTypeMapper.TrackExtensionMethodNamespace"/>) records
/// the declaring namespace of any RESOLVED extension method — whether reached via
/// an invocation (<see cref="Cs2Gs.Translator.CSharpToGSharpTranslator"/>'s
/// <c>TranslateInvocation</c>, covering the reduced instance form, the unreduced
/// static form, and the bare-sibling-static form) or via a bare, non-invoked
/// method-group reference (<c>TranslateMemberAccess</c>) — into the SAME
/// <see cref="CSharpTypeMapper.ShortenedNamespaces"/> set that issue #2211's fix
/// already drains into synthesized imports, so the existing
/// dedup-against-explicit-usings and skip-own-package logic in
/// <c>CSharpToGSharpTranslator.TranslateDocument</c> applies uniformly with no
/// separate code path.
/// </para>
/// </summary>
public class Issue2351ExtensionMethodImportSynthesisTests
{
    [Fact]
    public void RealOahuExportCheckShape_ImplicitLinqUsing_SynthesizesImport()
    {
        // Mirrors the exact reported shape: Oahu.Diagnostics' ExportCheck.cs has
        // NO `using System.Linq;` of its own (ImplicitUsings supplies it via a
        // separate, SDK-generated GlobalUsings.g.cs file) and calls the bare
        // method-group form `key.All(char.IsAsciiHexDigit)`.
        string printed = TranslateNamed(
            "ExportCheck.cs",
            ("ExportCheck.cs", @"
namespace Oahu.Diagnostics.Checks
{
    public static class ExportCheck
    {
        public static bool CheckKeyFormat(string key)
        {
            return key.Length == 32 && key.All(char.IsAsciiHexDigit);
        }
    }
}"),
            ("GlobalUsings.g.cs", "global using System.Linq;\n"));

        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"));
        Assert.Contains("key.All(", printed);
    }

    [Fact]
    public void LambdaEquivalentShape_MissingLinqUsing_SynthesizesImportAndCompilesEndToEnd()
    {
        // Same missing-using shape as the Oahu repro, but with an equivalent
        // lambda predicate instead of the bare method-group form — this avoids
        // relying on the SEPARATE method-group-inference fix (issue #2347) so
        // this test proves, with the REAL gsc, that the import synthesized by
        // THIS fix alone is sufficient for the call to resolve end-to-end.
        string printed = TranslateNamed(
            "Checker.cs",
            ("Checker.cs", @"
namespace Demo
{
    public static class Checker
    {
        public static bool AllDigits(string key)
        {
            return key.All(c => char.IsAsciiHexDigit(c));
        }
    }
}"),
            ("GlobalUsings.g.cs", "global using System.Linq;\n"));

        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"));
        AssertCompiles(printed);
    }

    [Fact]
    public void ExplicitUsingAlreadyPresent_NoDuplicateImportSynthesized()
    {
        // Control: an explicit `using System.Linq;` already covers the call, so
        // no duplicate is synthesized alongside the ordinary explicit import.
        string printed = TranslateUnit(@"
using System.Linq;

namespace Demo
{
    public static class Checker
    {
        public static bool AllDigits(string key)
        {
            return key.All(char.IsAsciiHexDigit);
        }
    }
}");

        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"));
    }

    [Fact]
    public void CustomExtensionNamespace_DifferentNamespaceSameCompilation_SynthesizesImport()
    {
        // A custom (source-defined, non-BCL) extension method declared in a
        // DIFFERENT namespace than its call site, reached only through a
        // hand-authored global-using file (the same shape a repo's own
        // `GlobalUsings.cs` takes) rather than a per-file `using` — proves the
        // fix generalizes beyond BCL/System.Linq to any imported (same-
        // compilation, different-namespace) extension.
        string printed = TranslateNamed(
            "Consumer.cs",
            ("Extensions.cs", @"
namespace Acme.Extensions
{
    public static class StringChecks
    {
        public static bool IsFoo(this string s) { return s == ""foo""; }
    }
}"),
            ("Consumer.cs", @"
namespace Acme.App
{
    public class Consumer
    {
        public bool Check(string s)
        {
            return s.IsFoo();
        }
    }
}"),
            ("GlobalUsings.g.cs", "global using Acme.Extensions;\n"));

        Assert.Equal(1, CountOccurrences(printed, "import Acme.Extensions"));
        Assert.Contains("s.IsFoo()", printed);
    }

    [Fact]
    public void CustomExtensionNamespace_SameNamespaceAsCallSite_NoSpuriousOwnPackageImport()
    {
        // Control: a custom extension declared in the SAME namespace as its
        // call site needs no import at all — the existing own-package filter
        // in `CSharpToGSharpTranslator.TranslateDocument` (`ns != package`)
        // must still suppress a self-import once extension namespaces flow
        // through the same tracked set.
        string printed = TranslateUnit(@"
namespace Acme.App
{
    public static class StringChecks
    {
        public static bool IsFoo(this string s) { return s == ""foo""; }
    }

    public class Consumer
    {
        public bool Check(string s)
        {
            return s.IsFoo();
        }
    }
}");

        Assert.DoesNotContain("import Acme.App", printed);
    }

    [Fact]
    public void NestedNamespaceCustomExtension_SynthesizesImport()
    {
        // A custom extension declared in a multi-segment nested namespace,
        // reached through a global using rather than a per-file `using`.
        string printed = TranslateNamed(
            "Consumer.cs",
            ("Extensions.cs", @"
namespace Acme.Deep.Nested.Extensions
{
    public static class NumberChecks
    {
        public static bool IsPositive(this int n) { return n > 0; }
    }
}"),
            ("Consumer.cs", @"
namespace Acme.App
{
    public class Consumer
    {
        public bool Check(int n)
        {
            return n.IsPositive();
        }
    }
}"),
            ("GlobalUsings.g.cs", "global using Acme.Deep.Nested.Extensions;\n"));

        Assert.Equal(1, CountOccurrences(printed, "import Acme.Deep.Nested.Extensions"));
    }

    [Fact]
    public void BareMethodGroupReference_NonInvokedExtension_SynthesizesImport()
    {
        // A bare (non-invoked) reference to an extension method — assigned to a
        // delegate rather than called directly — is not an
        // InvocationExpressionSyntax at all, so it only reaches the translator
        // through TranslateMemberAccess, never TranslateInvocation. Exercises
        // that second tracking call site.
        string printed = TranslateNamed(
            "Consumer.cs",
            ("Consumer.cs", @"
using System.Collections.Generic;

namespace Demo
{
    public class Consumer
    {
        public int CountOf(IEnumerable<int> seq)
        {
            System.Func<int> counter = seq.Count;
            return counter();
        }
    }
}"),
            ("GlobalUsings.g.cs", "global using System.Linq;\n"));

        Assert.Equal(1, CountOccurrences(printed, "import System.Linq"));
    }

    [Fact]
    public void AliasedStaticFormCustomExtension_SynthesizesRealNamespaceImport_NotAliasName()
    {
        // A custom extension called through its unreduced static form via a
        // TYPE alias (`using SC = Acme.Extensions.StringChecks;`). The C#
        // `using SC = ...;` alias itself is preserved as its own explicit
        // `import SC = Acme.Extensions.StringChecks` (pre-existing,
        // unrelated behavior) — but that alias entry does NOT satisfy the
        // dedup check for the REAL namespace `Acme.Extensions`, since the
        // bound extension-method symbol resolves identically regardless of
        // the alias spelling: the real namespace must still be imported in
        // its own right for the call to resolve.
        // The extension and its consumer must live in SEPARATE files/namespaces
        // (rather than two `namespace` blocks in one file) since the translator
        // merges multiple same-file namespaces into one dominant package,
        // which would make them share a package and hide the cross-namespace
        // import requirement this test targets.
        string printed = TranslateNamed(
            "Consumer.cs",
            ("Extensions.cs", @"
namespace Acme.Extensions
{
    public static class StringChecks
    {
        public static bool IsFoo(this string s) { return s == ""foo""; }
    }
}"),
            ("Consumer.cs", @"
namespace Acme.App
{
    using SC = Acme.Extensions.StringChecks;

    public class Consumer
    {
        public bool Check(string s)
        {
            return SC.IsFoo(s);
        }
    }
}"));

        Assert.Equal(1, CountOccurrences(printed, "import Acme.Extensions"));
    }

    private static string TranslateUnit(string source)
    {
        return TranslateNamed("Snippet.cs", ("Snippet.cs", source));
    }

    private static string TranslateNamed(string targetFileName, params (string FileName, string Source)[] sources)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            "Inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents, d => d.FilePath == targetFileName);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> with the real <c>gsc</c> and asserts
    /// zero errors — proving the synthesized import actually resolves the call,
    /// not just that the printed text looks right.
    /// </summary>
    private static void AssertCompiles(string printed, params string[] extraReferences)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2351-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed);

        string refArgs = string.Concat(extraReferences.Select(r => $" /r:\"{r}\""));
        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:library{refArgs} /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);

        // Read stdout/stderr concurrently to avoid a classic pipe deadlock: reading
        // one stream fully before starting the other can hang forever if the
        // child fills the OS pipe buffer on the stream not yet read.
        System.Threading.Tasks.Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        System.Threading.Tasks.Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        System.Threading.Tasks.Task.WaitAll(stdoutTask, stderrTask);
        process.WaitForExit();
        return (process.ExitCode, stdoutTask.Result + stderrTask.Result);
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

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }
}
