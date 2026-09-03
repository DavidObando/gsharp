// <copyright file="Issue3837EntryTypeExportedSurfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #3837: T3 (ADR-0115 §B.1/§B.11) flattens the
/// C# entry class to top-level G#, which erases the class from the migrated
/// assembly. Issue #3645 added a pipeline opt-in that keeps the class for an
/// executable a sibling project declares a literal <c>ProjectReference</c> to,
/// but the self-migration corpus reaches <c>src/Repl</c> through
/// <c>&lt;ProjectReference Include="@(GsharpRepl)" /&gt;</c> — an MSBuild item
/// include the declared-reference scan cannot resolve — so the flag never fired
/// and every <c>GSharp.Repl.Program.*</c> use site in
/// <c>test/Interpreter.Tests</c> failed with GS0157 (plus a GS0154 cascade
/// wherever the use site sat in a lambda whose return type then inferred as
/// <c>?</c>).
/// <para>
/// The fix makes the decision local and total: an entry class that declares any
/// non-entry member visible outside itself is preserved regardless of what the
/// pipeline can see. A <c>private</c>-only entry class exports nothing, so it
/// keeps hoisting to the canonical top-level form.
/// </para>
/// </summary>
public sealed class Issue3837EntryTypeExportedSurfaceTests
{
    /// <summary>The `src/Repl` shape: a static entry class with consumable helpers.</summary>
    private const string ExportingEntrySource = """
        using System;

        namespace Demo.Cli;

        public static class DemoProgram
        {
            public static int Main(string[] args) => Run(args.Length);

            public static int Run(int count)
            {
                Console.WriteLine("run:" + count);
                return count;
            }

            public static string Describe() => "demo";
        }
        """;

    /// <summary>The `internal`-helper shape: visible to an InternalsVisibleTo test project.</summary>
    private const string InternalHelperEntrySource = """
        using System;

        namespace Demo.Cli;

        public static class DemoProgram
        {
            public static int Main(string[] args) => 0;

            internal static bool IsValidEngineChoice(string? choice) => choice is null or "emit";
        }
        """;

    /// <summary>The unchanged shape: nothing but the entry point is visible.</summary>
    private const string PrivateOnlyEntrySource = """
        using System;

        namespace Demo.Cli;

        public static class DemoProgram
        {
            public static int Main(string[] args)
            {
                Report(args.Length);
                return 0;
            }

            private static void Report(int count) => Console.WriteLine("run:" + count);
        }
        """;

    /// <summary>
    /// The end-to-end regression: the migrated entry class survives as a real
    /// CLR type in its own assembly, and a SEPARATE consuming assembly binds it
    /// both fully qualified (<c>Demo.Cli.DemoProgram.Run</c>, the
    /// <c>GSharp.Repl.Program.Main</c> spelling) and through an import alias
    /// (the <c>ReplProgram</c> spelling). Fails on <c>origin/main</c>: the class
    /// is flattened away and both spellings raise GS0157.
    /// </summary>
    [Fact]
    public void ExportedEntryClass_IsConsumableFromAReferencingAssembly()
    {
        string printed = TranslateEntrySource(ExportingEntrySource);
        Assert.Contains("class DemoProgram", printed, StringComparison.Ordinal);

        const string consumer = """
            import System
            import DemoAlias = Demo.Cli.DemoProgram

            Console.WriteLine(Demo.Cli.DemoProgram.Run(2))
            Console.WriteLine(DemoAlias.Describe())
            """;

        (int exit, string stdout) = CompileLibraryAndRunConsumer(printed, consumer);

        Assert.Equal(0, exit);
        Assert.Equal(
            new[] { "run:2", "2", "demo" },
            stdout.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0).ToArray());
    }

    /// <summary>
    /// The preserved form is still a runnable program: gsc accepts a
    /// class-scoped static <c>Main</c> as the entry point (issue #1996), so
    /// preserving the class does not cost the executable its entry point.
    /// <para>
    /// This one also PASSES on <c>origin/main</c> — there it exercises the
    /// flattened form instead — so it is a guard rail on the new shape rather
    /// than a proof of the defect.
    /// </para>
    /// </summary>
    [Fact]
    public void PreservedEntryClass_StillRunsAsTheProgramEntryPoint()
    {
        string printed = TranslateEntrySource(ExportingEntrySource);

        (int exit, string stdout) = CompileAndRunExecutable(printed);

        Assert.Equal(0, exit);
        Assert.Contains("run:0", stdout, StringComparison.Ordinal);
    }

    /// <summary>
    /// An <c>internal</c> helper is assembly-visible surface too — it is exactly
    /// what <c>test/Interpreter.Tests</c> consumes from <c>src/Repl</c> through
    /// <c>InternalsVisibleTo</c> — so it also preserves the class. Fails on
    /// <c>origin/main</c>.
    /// </summary>
    [Fact]
    public void InternalNonEntryMember_PreservesTheEntryClass()
    {
        string printed = TranslateEntrySource(InternalHelperEntrySource);

        Assert.Contains("class DemoProgram", printed, StringComparison.Ordinal);
        Assert.Contains("IsValidEngineChoice", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Anti-vacuity guard rail: this one PASSES on <c>origin/main</c> and must
    /// keep passing. An entry class whose only non-entry member is
    /// <c>private</c> exports nothing, so the canonical T3 top-level form is
    /// unchanged — the fix must not preserve every entry class.
    /// </summary>
    [Fact]
    public void PrivateOnlyEntryClass_StillFlattensToTopLevel()
    {
        string printed = TranslateEntrySource(PrivateOnlyEntrySource);

        Assert.DoesNotContain("class DemoProgram", printed, StringComparison.Ordinal);
        Assert.Contains("func Report", printed, StringComparison.Ordinal);

        (int exit, string stdout) = CompileAndRunExecutable(printed);
        Assert.Equal(0, exit);
        Assert.Contains("run:0", stdout, StringComparison.Ordinal);
    }

    private static string TranslateEntrySource(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("DemoProgram.cs", source) },
            outputKind: OutputKind.ConsoleApplication);
        Assert.True(
            project.BoundWithoutErrors,
            "Entry source should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);

        // No `preserveEntryType` opt-in: this is the defaulted path the
        // self-migration corpus takes for `src/Repl` (issue #3837).
        var translator = new CSharpToGSharpTranslator();
        return GSharpPrinter.Print(translator.TranslateDocument(document, context));
    }

    private static (int Exit, string Stdout) CompileAndRunExecutable(string printedProgram)
    {
        string workDir = CreateWorkDirectory();
        string sourcePath = Path.Combine(workDir, "Program.gs");
        File.WriteAllText(sourcePath, printedProgram);
        string exePath = Path.Combine(workDir, "Program.dll");

        CompileOrFail(
            $"/target:exe /out:\"{exePath}\" \"{sourcePath}\"",
            printedProgram);

        return RunDotnet($"\"{exePath}\"");
    }

    private static (int Exit, string Stdout) CompileLibraryAndRunConsumer(
        string printedLibrary,
        string consumerProgram)
    {
        string workDir = CreateWorkDirectory();
        string libSourcePath = Path.Combine(workDir, "DemoProgram.gs");
        File.WriteAllText(libSourcePath, printedLibrary);
        // gsc names the emitted assembly after the package, so the output file
        // must be `Demo.Cli.dll` for the consumer to resolve it at run time.
        string libPath = Path.Combine(workDir, "Demo.Cli.dll");

        CompileOrFail(
            $"/target:library /out:\"{libPath}\" \"{libSourcePath}\"",
            printedLibrary);

        string consumerSourcePath = Path.Combine(workDir, "Consumer.gs");
        File.WriteAllText(consumerSourcePath, consumerProgram);
        string consumerPath = Path.Combine(workDir, "Consumer.dll");

        CompileOrFail(
            $"/target:exe /reference:\"{libPath}\" /out:\"{consumerPath}\" \"{consumerSourcePath}\"",
            printedLibrary + "\n---\n" + consumerProgram);

        // Both assemblies land in the same directory, so the consumer resolves
        // its dependency at run time without any probing configuration.
        return RunDotnet($"\"{consumerPath}\"");
    }

    private static void CompileOrFail(string arguments, string translated)
    {
        string compiler = FindCompiler();
        Assert.True(
            compiler != null,
            "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        (int exit, string log) = RunDotnet($"\"{compiler}\" {arguments}");
        Assert.True(
            exit == 0 && !log.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated source with zero errors. Output:\n" + log +
                "\n\nTranslated G#:\n" + translated);
    }

    private static string CreateWorkDirectory()
    {
        string workDir = Path.Combine(
            AppContext.BaseDirectory, "issue-3837-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        return workDir;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
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
