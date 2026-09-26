// <copyright file="Issue4482ByRefStorageNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4482: cs2gs widens an oblivious <c>out</c>/<c>ref</c> parameter that
/// is assigned <c>null</c> to <c>T?</c>. Since #4461, gsc requires the storage
/// passed to a by-ref parameter to match its nullability exactly (GS0612), so the
/// caller's storage must widen with it. Two shapes did not: an array ELEMENT
/// passed by <c>out</c> (<c>out failures[i]</c>, from
/// <c>CSharpToGSharpTranslator.Patterns</c>, which broke the hot-core guard),
/// and a local passed by <c>ref</c>. Declared, inline and inferred <c>out</c>
/// locals and a field already widened.
/// </summary>
public class Issue4482ByRefStorageNullabilityTests
{
    private const string Source = @"
public class Holder
{
    public string Field;

    private static int Find(int x, out string failureReason)
    {
        failureReason = null;
        if (x > 0) { failureReason = ""positive""; return 1; }
        return 0;
    }

    private static void Swap(ref string s) { s = null; }

    public static string Run()
    {
        var failures = new string[2];
        int a = Find(0, out failures[0]);
        int b = Find(2, out string inline);
        int c = Find(0, out var inferred);
        string declared;
        int d = Find(3, out declared);
        var h = new Holder();
        int e = Find(4, out h.Field);
        string r = ""x"";
        Swap(ref r);
        return a + b + c + d + e + (failures[0] ?? ""-"") + (inline ?? ""-"") + (inferred ?? ""-"") + (declared ?? ""-"") + (h.Field ?? ""-"") + (r ?? ""-"");
    }
}";

    /// <summary>
    /// Every by-ref storage shape widens with its parameter: the translation
    /// compiles with no GS0612 and runs with C#'s result, the nils included.
    /// </summary>
    [Fact]
    public void ByRefStorage_WidensWithTheParameter_CompilesCleanAndRuns()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", Source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("let failures = [2]string?", printed);
        Assert.Contains("var r string? = \"x\"", printed);

        (string compileOutput, string runOutput) = CompileAndRun(printed, "Holder.Run()");
        Assert.DoesNotContain("GS0612", compileOutput);
        Assert.Equal("3-positive-positivepositive-", runOutput.Trim());
    }

    private static (string CompileOutput, string RunOutput) CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");
        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-4482-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Snippet.gs");
            string dllPath = Path.Combine(workDir, "Snippet.dll");
            File.WriteAllText(gsPath, printed + Environment.NewLine + $"Console.WriteLine({callExpression})" + Environment.NewLine);

            (int compileExit, string compileOutput) = RunDotnet(compiler, "/target:exe", $"/out:{dllPath}", gsPath);
            Assert.True(
                compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet. Output:\n" + compileOutput + "\n\nTranslated G#:\n" + printed);

            (int runExit, string runOutput) = RunDotnet(dllPath);
            Assert.True(runExit == 0, "Translated snippet must run. Output:\n" + runOutput);
            return (compileOutput, runOutput);
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
