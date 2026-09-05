// <copyright file="Issue3935ForEachTypeNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3935: #3925 started emitting the DECLARED <c>foreach</c> type as a
/// typed range clause for every non-<c>var</c> loop. That type is mapped
/// straight from the loop's type SYNTAX, so it bypasses the oblivious
/// null-taint promotion every other declaration sink goes through — a tuple
/// element the analysis rendered <c>([]uint8)?</c> at the parameter came back
/// as a bare <c>[]uint8</c> on the loop variable alone, and the live
/// <c>temporary.Original == nil</c> guard folded into GS0523 ("comparison of
/// non-nullable with nil is always false"). This is the shape in
/// <c>Cs2Gs.Pipeline</c>'s <c>SdkCompileRunner.RestoreTemporaryBuildProps</c>
/// that took <c>Cs2Gs.Pipeline</c> and <c>Cs2Gs.Report</c> red.
///
/// <para>
/// When the element conversion is an IDENTITY conversion the annotation carries
/// no information — the loop variable's type IS the sequence's element type —
/// so it is omitted and G# infers the promoted element type. A genuine element
/// conversion still emits its typed range clause (that is what #3925 replaced
/// <c>__foreachN</c> synthesis with), now routed through the same declaration
/// promotion as any other local.
/// </para>
/// </summary>
public sealed class Issue3935ForEachTypeNullabilityTests
{
    /// <summary>
    /// A faithful reduction of <c>SdkCompileRunner</c>: a nullable-oblivious
    /// tuple element that genuinely holds <see langword="null"/>, flowed through
    /// a call so the taint analysis promotes the consumer's parameter, and read
    /// back behind a live <c>== null</c> guard inside an explicitly typed
    /// <c>foreach</c>. <c>Main</c> exercises BOTH guard branches.
    /// </summary>
    private const string TaintedTupleElementProgram = """
        using System;
        using System.Collections.Generic;

        namespace Repro;

        public static class Props
        {
            public static IReadOnlyList<(string Path, byte[] Original)> Prepare(IEnumerable<string> paths)
            {
                var prepared = new List<(string Path, byte[] Original)>();
                foreach (string path in paths)
                {
                    byte[] original = path.Length > 3 ? new byte[path.Length] : null;
                    prepared.Add((path, original));
                }

                return prepared;
            }

            public static void Restore(IEnumerable<(string Path, byte[] Original)> temporaryBuildProps)
            {
                foreach ((string Path, byte[] Original) temporary in temporaryBuildProps)
                {
                    if (temporary.Original == null)
                    {
                        Console.WriteLine("delete " + temporary.Path);
                    }
                    else
                    {
                        Console.WriteLine("restore " + temporary.Path + " " + temporary.Original.Length);
                    }
                }
            }

            public static void Main()
            {
                Restore(Prepare(new List<string> { "ab", "abcde" }));
            }
        }
        """;

    /// <summary>
    /// The regression test. On <c>origin/main</c> the loop variable is re-spelled
    /// <c>(Path string, Original []uint8)</c> and gsc reports GS0523 on the guard.
    /// </summary>
    [Fact]
    public void IdentityConvertedForEachOverPromotedTupleElement_KeepsGuardLiveAndExecutes()
    {
        string printed = Translate(TaintedTupleElementProgram, OutputKind.ConsoleApplication);

        // The taint analysis promotes the consumer's parameter element...
        Assert.Contains("Original []?uint8", printed, StringComparison.Ordinal);

        // ...and the loop variable must not re-spell it as a bare `[]uint8`.
        Assert.DoesNotContain("for temporary (Path string, Original []uint8) in", printed, StringComparison.Ordinal);
        Assert.Contains("for temporary in temporaryBuildProps", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__foreach", printed, StringComparison.Ordinal);

        // The `== null` guard is live in C#, so it must survive translation.
        Assert.Contains("temporary.Original == nil", printed, StringComparison.Ordinal);

        (string dllPath, string stdout, int exit) = CompileVerifyAndRun(printed, nameof(
            IdentityConvertedForEachOverPromotedTupleElement_KeepsGuardLiveAndExecutes));

        Assert.Equal(0, exit);

        // Both branches of the guard actually run — binding alone would not
        // prove the dead-comparison fold was avoided rather than hidden.
        Assert.Equal(
            new[] { "delete ab", "restore abcde 5" },
            stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray());

        AssertIlVerifies(dllPath);
    }

    /// <summary>
    /// An identity-converted loop over a plain (untainted) element type also
    /// drops the redundant annotation, and the loop still binds and runs.
    /// </summary>
    [Fact]
    public void IdentityConvertedForEachOverPlainElement_DropsRedundantType()
    {
        const string source = """
            using System;
            using System.Collections.Generic;

            namespace Repro;

            public static class Sum
            {
                public static int Total(IEnumerable<int> values)
                {
                    int total = 0;
                    foreach (int value in values)
                    {
                        total += value;
                    }

                    return total;
                }

                public static void Main()
                {
                    Console.WriteLine(Total(new List<int> { 1, 2, 3 }));
                }
            }
            """;

        string printed = Translate(source, OutputKind.ConsoleApplication);

        Assert.Contains("for value in values", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("for value int in", printed, StringComparison.Ordinal);

        (string dllPath, string stdout, int exit) = CompileVerifyAndRun(
            printed, nameof(IdentityConvertedForEachOverPlainElement_DropsRedundantType));
        Assert.Equal(0, exit);
        Assert.Equal("6", stdout.Trim());
        AssertIlVerifies(dllPath);
    }

    /// <summary>
    /// The anti-vacuity guard rail: a NON-identity element conversion still
    /// emits its typed range clause, so #3925's win is intact. This assertion
    /// (and <see cref="Issue2638TypedForEachTranslationTests"/>) passes on
    /// <c>origin/main</c> too.
    /// </summary>
    [Fact]
    public void NonIdentityElementConversion_StillEmitsTypedRangeClause()
    {
        const string source = """
            using System;
            using System.Collections;

            namespace Repro;

            public static class Widen
            {
                public static int Count(ArrayList items)
                {
                    int count = 0;
                    foreach (string item in items)
                    {
                        count += item.Length;
                    }

                    return count;
                }

                public static void Main()
                {
                    Console.WriteLine(Count(new ArrayList { "ab", "cde" }));
                }
            }
            """;

        string printed = Translate(source, OutputKind.ConsoleApplication);

        Assert.Contains("for item string in items", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__foreach", printed, StringComparison.Ordinal);

        (string dllPath, string stdout, int exit) = CompileVerifyAndRun(
            printed, nameof(NonIdentityElementConversion_StillEmitsTypedRangeClause));
        Assert.Equal(0, exit);
        Assert.Equal("5", stdout.Trim());
        AssertIlVerifies(dllPath);
    }

    // ---- harness -----------------------------------------------------------

    private static string Translate(string source, OutputKind outputKind)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Repro.cs", source) }, references: null, outputKind: outputKind);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static (string DllPath, string Stdout, int Exit) CompileVerifyAndRun(string printed, string caseName)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory, nameof(Issue3935ForEachTypeNullabilityTests), caseName);
        if (Directory.Exists(workDir))
        {
            Directory.Delete(workDir, recursive: true);
        }

        Directory.CreateDirectory(workDir);

        string gsPath = Path.Combine(workDir, "Program.gs");
        File.WriteAllText(gsPath, printed);
        string dllPath = Path.Combine(workDir, "Program.dll");

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /targetframework:net10.0 /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0,
            "gsc must compile the translated program. Output:\n" + compileOut + "\n\nTranslated G#:\n" + printed);
        Assert.DoesNotContain("GS0523", compileOut, StringComparison.Ordinal);

        File.WriteAllText(
            Path.Combine(workDir, "Program.runtimeconfig.json"),
            "{\n  \"runtimeOptions\": {\n    \"tfm\": \"net10.0\",\n"
                + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \""
                + Environment.Version.Major + ".0.0\" }\n  }\n}\n");

        (int exit, string output) = RunDotnet($"\"{dllPath}\"");
        return (dllPath, output, exit);
    }

    private static void AssertIlVerifies(string dllPath)
    {
        IlVerifyResult result = new IlVerifyRunner().Verify(dllPath);
        Assert.True(
            result.Errors.Count == 0,
            "ilverify reported findings:\n" + string.Join(Environment.NewLine, result.Errors.Select(e => e.RawLine)));
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
