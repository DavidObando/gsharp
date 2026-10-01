// <copyright file="Issue4611BranchValueSequenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4611: #4550's <c>CreateControlFlowGraph</c> appended the possibly-null
/// <c>BasicBlock.BranchValue</c> to a block's operations and filtered the null
/// afterwards. cs2gs bridges a maybe-null value entering generic storage with a
/// fail-fast <c>!!</c> (the settled policy pinned by
/// <c>ManagedReferenceArrayNilCannotSilentlyEnterFixedGenericStorage</c>), so the
/// migrated translator threw on the first block without a branch value. The
/// translator source now yields the branch value only when present.
/// </summary>
public class Issue4611BranchValueSequenceTests
{
    private const string MaybeNullHelper = """
        #nullable enable
            private static string? Branch(string value) => value.Length > 1 ? value : null;
        #nullable restore
        """;

    /// <summary>
    /// Pins today's behavior, deliberately: an oblivious maybe-null value
    /// appended to a sequence keeps its fail-fast <c>!!</c>, so C# that stores
    /// a null and filters it later throws once migrated. Whether cs2gs should
    /// instead diagnose that bridge is the open policy follow-up to #4611; until
    /// it is decided, translator source must not store nulls in sequences.
    /// </summary>
    [Fact]
    public void MaybeNullAppendedToSequence_KeepsFailFastBridge()
    {
        string printed = TranslateUnit("""
            using System.Linq;

            public static class C
            {
                public static int Appended(string[] items) =>
                    items.Append(Branch("x")).Where(s => s != null).Count();

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains(".Append(Branch(\"x\")!!)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shape the translator now uses: a branch value that is absent is
    /// never yielded, so the migrated iterator carries no assertion that can
    /// throw, and a block without one contributes only its operations.
    /// </summary>
    [Fact]
    public void BranchValueYieldedOnlyWhenPresent_CompileAndRun()
    {
        string printed = TranslateUnit("""
            using System.Collections.Generic;
            using System.Linq;

            public static class Probe
            {
                public static string Run() =>
                    new[] { "a", "bc" }.SelectMany(OperationsAndBranch).Count().ToString();

                private static IEnumerable<string> OperationsAndBranch(string block)
                {
                    foreach (string operation in new[] { block })
                    {
                        yield return operation;
                    }

                    if (Branch(block) is { } branchValue)
                    {
                        yield return branchValue;
                    }
                }

            """ + MaybeNullHelper + """

            }
            """);

        Assert.DoesNotContain("Branch(block)!!", printed, StringComparison.Ordinal);

        // "a" has no branch value and contributes [a]; "bc" contributes [bc, bc].
        Assert.Equal("3", CompileAndRun(printed, "Probe.Run()").Trim());
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

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue4611-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string dllPath = Path.Combine(workDir, "Snippet.dll");
            string unitPath = Path.Combine(workDir, "Unit.gs");
            File.WriteAllText(unitPath, printed);
            string entryPath = Path.Combine(workDir, "Main.gs");
            File.WriteAllText(entryPath, $"import System{Environment.NewLine}{Environment.NewLine}Console.WriteLine({callExpression}){Environment.NewLine}");

            (int compileExit, string compileOutput) = RunDotnet(compiler, "/target:exe", $"/out:{dllPath}", unitPath, entryPath);
            Assert.True(
                compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput
                    + "\n\nTranslated G#:\n" + printed);

            (int runExit, string runOutput) = RunDotnet(dllPath);
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput + "\n\nTranslated G#:\n" + printed);
            return runOutput;
        }
        finally
        {
            Directory.Delete(workDir, recursive: true);
        }
    }

    private static (int Exit, string Output) RunDotnet(params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo);
        Assert.NotNull(process);

        System.Threading.Tasks.Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        System.Threading.Tasks.Task<string> stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(TimeSpan.FromMinutes(5)))
        {
            process.Kill(entireProcessTree: true);
            Assert.Fail("dotnet " + string.Join(' ', arguments) + " did not exit within 5 minutes.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }
}
