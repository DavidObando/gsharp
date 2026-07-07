// <copyright file="Issue2211FullyQualifiedNoUsingImportSynthesisTests.cs" company="GSharp">
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
/// Issue #2211: back-translating C# that fully-qualifies every type/enum
/// reference with NO <c>using</c> directives (the shape a Roslyn source
/// generator emits — see ADR-0145) shortened some of those references to a
/// bare name without synthesizing the matching <c>import</c>, producing G#
/// gsc rejects (GS0113/GS0157/GS0202). Root cause: <see cref="CSharpTypeMapper"/>
/// always shortens a non-nested named type to its simple name
/// (<c>QualifiedTypeName</c>), relying on the file's own <c>using</c>
/// directives to supply a matching <c>import</c> — but a generator-shaped
/// file with no <c>using</c>s at all has none. This affected EVERY call site
/// funneled through <c>CSharpTypeMapper.Map</c> (enum-constant attribute
/// arguments, field/local type annotations, generic type arguments, ...),
/// while a C# attribute's own type name (taken verbatim from syntax, not
/// through the type mapper) stayed fully qualified — the inconsistency the
/// issue observed within one file.
/// <para>
/// The fix collects every namespace the type mapper shortens a reference into
/// (<see cref="CSharpTypeMapper.ShortenedNamespaces"/>) and, once the whole
/// file is translated, synthesizes a matching <c>import</c> for any such
/// namespace not already covered by the file's own package or an explicit
/// <c>using</c> (<see cref="CSharpToGSharpTranslator.TranslateDocument"/>).
/// </para>
/// </summary>
public class Issue2211FullyQualifiedNoUsingImportSynthesisTests
{
    [Fact]
    public void EnumArgumentAndFieldType_FullyQualifiedNoUsing_SynthesizesImportAndRoundTrips()
    {
        // Mirrors the exact shape from the issue: a generator-emitted file with
        // NO `using` directives, an attribute whose enum argument is fully
        // qualified, and a field of a fully-qualified BCL type.
        string printed = TranslateUnit(@"
namespace CommunityToolkit.Mvvm.ComponentModel.__Internals
{
    [global::System.ComponentModel.EditorBrowsable(global::System.ComponentModel.EditorBrowsableState.Never)]
    internal static class __KnownINotifyPropertyChangedArgs
    {
        public static readonly global::System.ComponentModel.PropertyChangedEventArgs Message =
            new global::System.ComponentModel.PropertyChangedEventArgs(""Message"");
    }
}");

        Assert.Contains("import System.ComponentModel", printed);
        Assert.Contains("EditorBrowsableState.Never", printed);
        Assert.Contains("PropertyChangedEventArgs", printed);

        // Every shortened reference must actually resolve: compile the printed
        // G# with the real gsc. gsc's default (no `/r:`) resolver only probes
        // its own host process's already-loaded assemblies plus a small
        // well-known BCL set (System.Runtime, System.Private.CoreLib, ...) —
        // `PropertyChangedEventArgs` lives in System.ObjectModel.dll, which
        // that process never otherwise loads, so it must be passed explicitly
        // (an infra fact unrelated to this translator fix).
        AssertCompiles(
            printed,
            typeof(System.ComponentModel.PropertyChangedEventArgs).Assembly.Location,
            typeof(object).Assembly.Location);
    }

    [Fact]
    public void NestedEnumAccessInAttributeArgument_FullyQualifiedNoUsing_SynthesizesImport()
    {
        // A NESTED BCL enum (`System.Environment.SpecialFolder`) referenced
        // fully-qualified as an attribute argument, with no `using` for its
        // namespace. Exercises the nested-type branch of
        // `CSharpTypeMapper.QualifiedTypeName` (distinct from the top-level
        // `EditorBrowsableState` in the first test).
        string printed = TranslateUnit(@"
namespace Demo
{
    public class TagAttribute : global::System.Attribute
    {
        public TagAttribute(global::System.Environment.SpecialFolder folder) { }
    }

    [Tag(global::System.Environment.SpecialFolder.ApplicationData)]
    public class Marker
    {
    }
}");

        Assert.Contains("SpecialFolder.ApplicationData", printed);
        Assert.Contains(printed.Split('\n').Select(l => l.Trim()), l => l == "import System");

        // ponytail: skip a second real-gsc compile here — the first test
        // already proves the mechanism compiles end-to-end; running gsc as a
        // subprocess for every generality case here multiplies process load
        // for no extra coverage (GSharpRoundTrip.Validate inside TranslateUnit
        // already proves the printed text re-parses).
    }

    [Fact]
    public void LocalVariableType_FullyQualifiedNoUsing_SynthesizesImport()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Length()
        {
            global::System.Text.StringBuilder builder = new global::System.Text.StringBuilder(""hi"");
            return builder.Length;
        }
    }
}");

        Assert.Contains("import System.Text", printed);
        Assert.Contains("StringBuilder", printed);
    }

    [Fact]
    public void GenericTypeArgument_FullyQualifiedNoUsing_SynthesizesImport()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public global::System.Collections.Generic.List<global::System.Text.StringBuilder> Items()
        {
            return new global::System.Collections.Generic.List<global::System.Text.StringBuilder>();
        }
    }
}");

        Assert.Contains("import System.Collections.Generic", printed);
        Assert.Contains("import System.Text", printed);
    }

    [Fact]
    public void NamespaceAlreadyCoveredByUsing_NoDuplicateImportSynthesized()
    {
        // Control: when a `using` already exists for the shortened
        // namespace, no synthesized duplicate is added.
        string printed = TranslateUnit(@"
using System.ComponentModel;

namespace Demo
{
    public class C
    {
        public PropertyChangedEventArgs Field = new PropertyChangedEventArgs(""X"");
    }
}");

        Assert.Equal(1, CountOccurrences(printed, "import System.ComponentModel"));
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
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
    /// zero errors — proving every shortened reference actually resolves, not
    /// just that the text happens to look right.
    /// </summary>
    private static void AssertCompiles(string printed, params string[] extraReferences)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2211-e2e", Guid.NewGuid().ToString("N"));
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

        // Read stdout/stderr concurrently to avoid a classic pipe deadlock:
        // reading one stream fully before starting the other can hang forever
        // if the child fills the OS pipe buffer on the stream not yet read.
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        Task.WaitAll(stdoutTask, stderrTask);
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
