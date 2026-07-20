// <copyright file="Issue2552NestedBreakTargetTests.cs" company="GSharp">
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

public class Issue2552NestedBreakTargetTests
{
    private const string Source = @"
using System;

namespace Demo
{
    public sealed class C
    {
        public static string SwitchInsideLoop(int value)
        {
            string trace = """";
            int i = 0;
            while (i < 2)
            {
                i++;
                switch (value)
                {
                    case 0:
                        trace += ""S"";
                        if (i == 1)
                        {
                            break;
                        }

                        trace += ""x"";
                        break;
                    default:
                        trace += ""D"";
                        break;
                }

                trace += ""L"";
                if (i == 1)
                {
                    continue;
                }

                break;
            }

            return trace;
        }

        public static string LoopInsideSwitch(int value)
        {
            string trace = """";
            switch (value)
            {
                case 0:
                    while (true)
                    {
                        trace += ""L"";
                        break;
                    }

                    if (trace.Length == 1)
                    {
                        break;
                    }

                    trace += ""bad"";
                    break;
                default:
                    trace += ""D"";
                    break;
            }

            return trace + ""S"";
        }
    }
}";

    [Fact]
    public void Translator_PreservesLoopBreaksAndLowersSwitchBreaks()
    {
        string printed = TranslateAndValidate(Source);

        Assert.Equal(2, CountOccurrences(printed, "break"));
        Assert.Equal(2, CountOccurrences(printed, "goto __switchExit"));
    }

    [Fact]
    public void Compiler_AcceptsBothNestedShapesWithoutGS0120()
    {
        string output = Compile(TranslateAndValidate(Source), out _);

        Assert.DoesNotContain("GS0120", output, StringComparison.Ordinal);
    }

    [Fact]
    public void Runtime_PreservesBothNestedBreakTargets()
    {
        string printed = TranslateAndValidate(Source);
        string output = CompileAndRun(
            printed,
            "Console.WriteLine(C.SwitchInsideLoop(0))" + Environment.NewLine +
                "Console.WriteLine(C.LoopInsideSwitch(0))");

        Assert.Equal("SLSxL" + Environment.NewLine + "LS", output.Trim());
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
    }

    private static string TranslateAndValidate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Errors) + Environment.NewLine + printed);
        return printed;
    }

    private static string CompileAndRun(string printed, string entryPoint)
    {
        _ = Compile(printed + Environment.NewLine + entryPoint + Environment.NewLine, out string dllPath);
        (int exit, string output) = RunDotnet($"\"{dllPath}\"");
        Assert.Equal(0, exit);
        return output;
    }

    private static string Compile(string printed, out string dllPath)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2552-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed);

        (int exit, string output) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(exit == 0, output + Environment.NewLine + printed);
        return output;
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
