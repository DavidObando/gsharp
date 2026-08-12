// <copyright file="Issue3352WhileLetTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3352: C# positive pattern bindings in <c>while</c> conditions use
/// native G# <c>while let</c> when that form preserves the source semantics.
/// </summary>
public sealed class Issue3352WhileLetTranslationTests
{
    [Fact]
    public void ReferenceTypePatternEmitsNativeWhileLetAndRuns()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    private static int calls;

                    private static object? Next()
                    {
                        calls++;
                        return calls <= 2 ? calls.ToString() : null;
                    }

                    public static string Run()
                    {
                        string result = "";
                        while (Next() is string text)
                        {
                            result += text;
                        }

                        return result + "|" + calls;
                    }
                }
            }
            """);

        Assert.Contains("while let text =", printed, StringComparison.Ordinal);
        Assert.Contains("as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("while true", printed, StringComparison.Ordinal);
        Assert.Equal("12|3", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void BareNonNullPatternUsesReceiverDirectly()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    private static int calls;

                    private static string? Next()
                    {
                        calls++;
                        return calls == 1 ? "value" : null;
                    }

                    public static string Run()
                    {
                        string result = "";
                        while (Next() is { } text)
                        {
                            result += text;
                        }

                        return result + "|" + calls;
                    }
                }
            }
            """);

        Assert.Contains("while let text =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("while let text = C.Next() as", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal);
        Assert.Equal("value|2", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ConjoinedGuardRunsInsideBindingScope()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    private static int calls;

                    private static object? Next()
                    {
                        calls++;
                        if (calls == 1) return "a";
                        if (calls == 2) return "";
                        return "unreached";
                    }

                    public static string Run()
                    {
                        string result = "";
                        while (Next() is string text && text.Length > 0)
                        {
                            result += text;
                        }

                        return result + "|" + calls;
                    }
                }
            }
            """);

        Assert.Contains("while let text =", printed, StringComparison.Ordinal);
        Assert.Contains("text.Length > 0", printed, StringComparison.Ordinal);
        Assert.Contains("break", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal);
        Assert.Equal("a|2", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ValueTypePatternUsesNullableAsTargetAndRuns()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    private static int calls;

                    private static object? Next()
                    {
                        calls++;
                        return calls <= 2 ? calls : null;
                    }

                    public static string Run()
                    {
                        int sum = 0;
                        while (Next() is int value)
                        {
                            sum += value;
                        }

                        return sum + "|" + calls;
                    }
                }
            }
            """);

        Assert.Contains("while let value =", printed, StringComparison.Ordinal);
        Assert.Contains("as int32?", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal);
        Assert.Equal("3|3", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void NativeWhileLetPreservesContinueAndBreak()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    private static int calls;

                    private static object? Next()
                    {
                        calls++;
                        if (calls == 1) return "skip";
                        if (calls == 2) return "keep";
                        if (calls == 3) return "stop";
                        return "unreached";
                    }

                    public static string Run()
                    {
                        string result = "";
                        while (Next() is string text)
                        {
                            if (text == "skip") continue;
                            result += text;
                            if (text == "stop") break;
                        }

                        return result + "|" + calls;
                    }
                }
            }
            """);

        Assert.Contains("while let text =", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__scrutinee", printed, StringComparison.Ordinal);
        Assert.Equal("keepstop|3", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void OuterHoistDoesNotRewriteContinueInsideNestedWhileLet()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    private static int outer;
                    private static int bodyCalls;
                    private static int nextCalls;

                    private static object? Next()
                    {
                        nextCalls++;
                        return nextCalls == 1 ? "value" : null;
                    }

                    public static string Run()
                    {
                        while ((outer = outer + 1) < 2)
                        {
                            while (Next() is string text)
                            {
                                bodyCalls++;
                                continue;
                            }
                        }

                        return outer + "|" + bodyCalls + "|" + nextCalls;
                    }
                }
            }
            """);

        Assert.Contains("while let text =", printed, StringComparison.Ordinal);
        Assert.Equal("2|1|2", CompileAndRun(printed, "C.Run()").Trim());
    }

    [Fact]
    public void ReassignedPatternLocalKeepsMutableHoistFallback()
    {
        var printed = Translate("""
            #nullable enable
            using System;

            namespace Demo
            {
                public static class C
                {
                    public static string Run(object? value)
                    {
                        while (value is string text)
                        {
                            text = "";
                            break;
                        }

                        return "ok";
                    }
                }
            }
            """);

        Assert.DoesNotContain("while let text =", printed, StringComparison.Ordinal);
        Assert.Contains("var text", printed, StringComparison.Ordinal);
        Assert.Equal("ok", CompileAndRun(printed, "C.Run(\"value\")").Trim());
    }

    private static string Translate(string source)
    {
        var project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        var printed = GSharpPrinter.Print(unit);
        var roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        var compiler = FindCompiler();
        Assert.NotNull(compiler);

        var workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-3352-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            var sourcePath = Path.Combine(workDir, "Snippet.gs");
            var outputPath = Path.Combine(workDir, "Snippet.dll");
            File.WriteAllText(
                sourcePath,
                printed + Environment.NewLine +
                    $"Console.WriteLine({callExpression})" + Environment.NewLine);

            var (compileExit, compileOutput) = RunDotnet(
                compiler!,
                "/target:exe",
                $"/out:{outputPath}",
                sourcePath);
            Assert.True(
                compileExit == 0 &&
                    !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile translated G# with zero errors. Output:\n" +
                    compileOutput + "\n\nTranslated G#:\n" + printed);

            var (runExit, runOutput) = RunDotnet(outputPath);
            Assert.True(
                runExit == 0,
                "Translated G# must run successfully. Output:\n" + runOutput);
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
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var output = new StringBuilder();
        output.Append(process!.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var sameConfiguration = Path.Combine(directory.FullName, "Compiler", "gsc.dll");
            if (File.Exists(sameConfiguration))
            {
                return sameConfiguration;
            }

            foreach (var configuration in new[] { "Release", "Debug" })
            {
                var candidate = Path.Combine(
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
}
