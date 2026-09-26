// <copyright file="Issue4500ElementWriteAndAnnotationsNarrowingTests.cs" company="GSharp">
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
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4500, two cs2gs gaps from main nightly 36236554862.
/// <para>
/// 1. An element WRITE of a maybe-nil value (<c>names[i] = member?.Name</c>)
/// into a <c>new T[n]</c> array kept a non-null element type and bridged the
/// write with <c>!!</c>, which threw where C# stores the null. That is what failed
/// the migrated <c>Cs2Gs.Tests</c> (<c>TryGetPositionalMembers</c>). The element
/// now widens to <c>T?</c>, as #4482 does for out/ref elements.
/// </para>
/// <para>
/// 2. In a <c>&lt;Nullable&gt;annotations&lt;/Nullable&gt;</c> context Roslyn runs
/// no flow analysis, so a <c>var</c> local initialized from a <c>T?</c> API and
/// "narrowed" only by <c>Assert.NotNull</c> or an earlier <c>x!</c> was left bare
/// at a later dereference. G# narrows neither, so gsc reported GS0159
/// (<c>Runtime.Channels.Tests</c>). The receiver is now asserted, as C# throws on
/// a null there too.
/// </para>
/// </summary>
public class Issue4500ElementWriteAndAnnotationsNarrowingTests
{
    [Fact]
    public void ElementWriteOfMaybeNilValue_WidensTheElement_CompilesAndRuns()
    {
        string printed = Translate(@"
public class Holder
{
    public string Name;

    private static Holder Find(int i) => i > 0 ? new Holder { Name = ""h"" + i } : null;

    public static string Run()
    {
        var names = new string[2];
        var members = new Holder[2];
        for (int i = 0; i < 2; i++)
        {
            Holder member = Find(i);
            names[i] = member?.Name;
            members[i] = member;
        }

        return (names[0] ?? ""-"") + (names[1] ?? ""-"") + (members[0] == null ? ""N"" : ""Y"") + members[1].Name;
    }
}", NullableContextOptions.Disable);

        Assert.Contains("let names = [2]string?", printed);
        Assert.Contains("let members = [2]Holder?", printed);
        // The writes stay bare; a later dereference of a widened element is
        // asserted, as C# throws on a null there.
        Assert.DoesNotContain("member?.Name!!", printed);
        Assert.DoesNotContain("= member!!", printed);
        Assert.Contains("members[1]!!.Name", printed);
        Assert.Equal("-h1Nh1", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim());
    }

    [Fact]
    public void AnnotationsContextLocal_NarrowedOnlyInCSharp_IsAsserted_CompilesAndRuns()
    {
        string printed = Translate(@"
using System;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;

public static class Check
{
    public static void NotNull([NotNull] object value) { if (value == null) throw new Exception(); }
}

public class Holder
{
    private int field = 5;

    public static string Run()
    {
        var slot = typeof(Holder).GetField(""field"", BindingFlags.NonPublic | BindingFlags.Instance);
        Check.NotNull(slot);
        var h = new Holder();
        return slot.GetValue(h) == null ? ""null"" : ""set"";
    }
}", NullableContextOptions.Annotations);

        Assert.Contains("slot!!.GetValue(h)", printed);
        Assert.Equal("set", CompileAndRun(printed, "Holder.Run()").RunOutput.Trim());
    }

    private static string Translate(string source, NullableContextOptions options)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest), path: "Snippet.cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            "Snippet",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(options));
        Assert.Empty(compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error));
        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static (string CompileOutput, string RunOutput) CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");
        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-4500-e2e", Guid.NewGuid().ToString("N"));
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
