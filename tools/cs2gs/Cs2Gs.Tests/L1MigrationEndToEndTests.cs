// <copyright file="L1MigrationEndToEndTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// The canonicalization milestone for issue #914: the real L1-Console corpus
/// migrates end-to-end — translate (T1 tuples / T2 constructor ABI / T3
/// entry-point → top-level) → canonical G# that round-trips → compiles with the
/// real <c>gsc</c> → runs → stdout exactly matches the C# baseline golden.
/// </summary>
public class L1MigrationEndToEndTests
{
    /// <summary>
    /// Translating L1 produces canonical G# that round-trips and exhibits the
    /// three transforms: T1 native positional tuples, T2 explicit constructor
    /// and private field preservation, and T3 top-level funcs and statements
    /// (no <c>shared { }</c> wrapper, no leftover <c>Main</c> method). No
    /// <see cref="TranslationSeverity.Unsupported"/> diagnostic survives.
    /// </summary>
    [Fact]
    public async Task L1Corpus_CanonicalizesWithAllThreeTransforms()
    {
        (CompilationUnit unit, TranslationContext context, string printed) = await TranslateL1Async();

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Canonical L1 must round-trip-parse. Errors:\n" +
                string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);

        // T1: the named C# tuple type maps to a native G# positional tuple, and
        // named element access lowered to positional `.ItemN`.
        Assert.Contains("List[(string, int32, int32)]", printed);
        Assert.Contains("item.Item2 * item.Item3", printed);

        // T2: the explicit constructor keeps its source parameter name and both
        // readonly fields remain private instead of becoming primary fields.
        Assert.Contains("class Cart {", printed);
        Assert.Contains("private let _customer string", printed);
        Assert.Contains("private let _items List[(string, int32, int32)]", printed);
        Assert.Contains("init(customer string)", printed);
        Assert.Contains("_items = List[(string, int32, int32)]()", printed);

        // T3: the entry class became top-level — a top-level func and the entry
        // body as top-level statements — with no `shared { }` block and no `Main`.
        Assert.Contains("private func PrintFizzBuzz(upTo int32) {", printed);
        Assert.Contains("\nlet cart = Cart(\"Ada\")", printed);
        Assert.DoesNotContain("shared {", printed);
        Assert.DoesNotContain("func Main", printed);

        // No construct is left as an Unsupported placeholder.
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        Assert.DoesNotContain("// unsupported", printed);
    }

    /// <summary>
    /// The full migration proof: the translated L1 compiles with the real
    /// <c>gsc</c> (zero errors) and the produced program's stdout exactly matches
    /// <c>baseline.stdout.golden</c>. The compile/run steps are gated on the
    /// compiler artifact being present (it is when the solution is built, e.g. the
    /// <c>GSharp.sln</c> gate or <c>scripts/migrate-l1.sh</c>); when only the cs2gs
    /// test project is built the assertions above still run.
    /// </summary>
    [Fact]
    public async Task L1Corpus_CompilesWithGscAndMatchesBaseline()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            // gsc.dll is not built in this run; the translate + round-trip proof in
            // L1Corpus_CanonicalizesWithAllThreeTransforms still applies and
            // scripts/migrate-l1.sh exercises the full gsc path.
            return;
        }

        (_, _, string printed) = await TranslateL1Async();

        string workDir = Path.Combine(AppContext.BaseDirectory, "l1-e2e");
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "L1.gs");
        string dllPath = Path.Combine(workDir, "L1.dll");
        File.WriteAllText(gsPath, printed);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated L1 with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated L1 must run successfully. Output:\n" + stdout);

        string baseline = File.ReadAllText(ResolveCorpusFile("L1-Console", "baseline.stdout.golden"));
        Assert.Equal(Normalize(baseline), Normalize(stdout));
    }

    private static async Task<(CompilationUnit Unit, TranslationContext Context, string Printed)> TranslateL1Async()
    {
        string projectPath = ResolveCorpusFile("L1-Console", "L1-Console.csproj");
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);

        Assert.True(
            project.BoundWithoutErrors,
            "L1-Console should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = project.Documents.Single(
            d => d.FilePath.EndsWith("Program.cs", StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context, GSharpPrinter.Print(unit));
    }

    private static string Normalize(string text) => text.Replace("\r\n", "\n").TrimEnd('\n') + "\n";

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
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

    private static string ResolveCorpusFile(string projectFolder, string fileName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            string candidate = Path.Combine(dir.FullName, "tools", "cs2gs", "corpus", projectFolder, fileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        throw new FileNotFoundException(
            $"Could not locate corpus file '{projectFolder}/{fileName}' above {AppContext.BaseDirectory}.");
    }
}
