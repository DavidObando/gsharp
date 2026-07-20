// <copyright file="Issue2580EnumSwitchFallbackTranslationTests.cs" company="GSharp">
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

public sealed class Issue2580EnumSwitchFallbackTranslationTests
{
    [Fact]
    public void StatementFallback_IsAddedOnlyForIncompleteDefaultlessEnumSwitch()
    {
        string printed = TranslateAndValidate(
            """
            namespace Demo
            {
                public enum State { Zero, One }

                public static class C
                {
                    public static void Incomplete(State value)
                    {
                        switch (value)
                        {
                            case State.One:
                                value = State.Zero;
                                break;
                        }
                    }

                    public static void Complete(State value)
                    {
                        switch (value)
                        {
                            case State.Zero or State.One:
                                value = State.Zero;
                                break;
                        }
                    }

                    public static void Explicit(State value)
                    {
                        switch (value)
                        {
                            case State.One:
                                value = State.Zero;
                                break;
                            default:
                                value = State.One;
                                break;
                        }
                    }

                    public static void NonEnum(int value)
                    {
                        switch (value)
                        {
                            case 1:
                                value = 2;
                                break;
                        }
                    }

                    public static int Expression(State value) => value switch
                    {
                        State.One => 1,
                    };
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "default {"));
        Assert.Contains("default: throw", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedEnumFallback_CompilesAndPreservesUnmatchedRuntimePath()
    {
        string printed = TranslateAndValidate(
            """
            using System;

            namespace Demo
            {
                public static class C
                {
                    public static string Run(DayOfWeek value)
                    {
                        string trace = "before";
                        switch (value)
                        {
                            case DayOfWeek.Monday:
                                trace += "|monday";
                                break;
                            case DayOfWeek.Tuesday:
                                trace += "|tuesday";
                                break;
                        }

                        return trace + "|after";
                    }
                }
            }
            """);

        Assert.Contains("default {", printed, StringComparison.Ordinal);
        Assert.Equal(
            "before|after;before|monday|after",
            CompileAndRun(
                printed,
                "C.Run(DayOfWeek.Sunday) + \";\" + C.Run(DayOfWeek.Monday)").Trim());
    }

    [Fact]
    public void SourceEnumFallback_PreservesBreakAndExplicitDefault()
    {
        string printed = TranslateAndValidate(
            """
            namespace Demo
            {
                public enum State { A, B, C, D }

                public static class C
                {
                    public static string Run(State value)
                    {
                        string trace = "";
                        switch (value)
                        {
                            case State.A:
                                trace += "a";
                                break;
                            case State.B:
                                trace += "b";
                                break;
                            case State.C:
                                trace += "c";
                                break;
                        }

                        return trace + "|done";
                    }

                    public static string Explicit(State value)
                    {
                        switch (value)
                        {
                            case State.A:
                                return "a";
                            default:
                                return "explicit";
                        }
                    }
                }
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "default {"));
        Assert.Equal(
            "a|done;b|done;|done;explicit",
            CompileAndRun(
                printed,
                "C.Run(State.A) + \";\" + C.Run(State.B) + \";\" + " +
                "C.Run(State.D) + \";\" + C.Explicit(State.D)").Trim());
    }

    private static string TranslateAndValidate(string source)
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
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2580-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(
            gsPath,
            printed + Environment.NewLine +
                $"Console.WriteLine({callExpression})" + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout);
        return stdout;
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(startInfo);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string configuration in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    configuration,
                    "Compiler",
                    "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int index = 0;
             (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0;
             index += value.Length)
        {
            count++;
        }

        return count;
    }
}
