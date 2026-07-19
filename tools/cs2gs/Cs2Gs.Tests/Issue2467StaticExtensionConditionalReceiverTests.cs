// <copyright file="Issue2467StaticExtensionConditionalReceiverTests.cs" company="GSharp">
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

public class Issue2467StaticExtensionConditionalReceiverTests
{
    [Fact]
    public void QualifiedAndBareStaticCalls_ParenthesizeConditionalAccessReceiver()
    {
        string printed = TranslateAndValidate("""
            #nullable enable
            namespace Demo;

            public sealed class Box
            {
                public string? Value { get; set; }
            }

            public static class Ext
            {
                public static bool Matches(this string? value, string expected) => value == expected;

                public static bool Bare(Box? box, string expected) => Matches(box?.Value, expected);
            }

            public sealed class C
            {
                public bool Qualified(Box? box, string expected) => Ext.Matches(box?.Value, expected);
            }
            """);

        Assert.Equal(2, CountOccurrences(printed, "(box?.Value).Matches(expected)"));
        Assert.DoesNotContain("box?.Value.Matches(expected)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Ext.Matches", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ComplexFirstArguments_AreGroupedBeforeReceiverCall()
    {
        string printed = TranslateAndValidate("""
            #nullable enable
            using System.Threading.Tasks;
            namespace Demo;

            public static class Ext
            {
                public static int Size(this string? value) => value?.Length ?? -1;
            }

            public sealed class C
            {
                private Task<string?> GetAsync() => Task.FromResult<string?>(null);

                public int Coalesce(string? left, string right) => Ext.Size(left ?? right);
                public int Conditional(bool pickLeft, string? left, string? right) => Ext.Size(pickLeft ? left : right);
                public int Cast(object value) => Ext.Size((string?)value);
                public async Task<int> Awaited() => Ext.Size(await GetAsync());
            }
            """);

        Assert.Contains("(left ?? right).Size()", printed, StringComparison.Ordinal);
        Assert.Contains("(if pickLeft { left } else { right }).Size()", printed, StringComparison.Ordinal);
        Assert.Contains("(value as string).Size()", printed, StringComparison.Ordinal);
        Assert.Contains("(await GetAsync()).Size()", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GenericOverloadAndArgumentShapes_KeepResolvedCallIdentity()
    {
        string printed = TranslateAndValidate("""
            #nullable enable
            namespace Demo;

            public sealed class Box
            {
                public string? Value { get; set; }
            }

            public static class Ext
            {
                public static T Pick<T>(this T value, T fallback = default!) => value is null ? fallback : value;
                public static string Pick(this string? value, string fallback) => value ?? fallback;
                public static void Flow(this string? value, ref int x, out int y, in int z)
                {
                    x++;
                    y = z;
                }

                public static string Join(this string? value, string separator = ":", params string[] rest) =>
                    value + separator + string.Join(separator, rest);
            }

            public sealed class C
            {
                public string Generic(Box? box) => Ext.Pick<string?>(box?.Value, "fallback")!;
                public string Overload(Box? box) => Ext.Pick(box?.Value, "fallback");

                public void RefKinds(Box? box, ref int x, out int y, in int z) =>
                    Ext.Flow(box?.Value, ref x, out y, in z);

                public string Defaults(Box? box) => Ext.Join(box?.Value);
                public string Params(Box? box) => Ext.Join(box?.Value, "-", "a", "b");
            }
            """);

        Assert.Contains("(box?.Value).Pick[string?](\"fallback\")", printed, StringComparison.Ordinal);
        Assert.Contains("(box?.Value).Pick(\"fallback\")", printed, StringComparison.Ordinal);
        Assert.Contains("(box?.Value).Flow(&x, &y, z)", printed, StringComparison.Ordinal);
        Assert.Contains("(box?.Value).Join()", printed, StringComparison.Ordinal);
        Assert.Contains("(box?.Value).Join(\"-\", \"a\", \"b\")", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceReceiverSyntax_RemainsSourceReceiverSyntax()
    {
        string printed = TranslateAndValidate("""
            #nullable enable
            namespace Demo;

            public sealed class Box
            {
                public string? Value { get; set; }
            }

            public static class Ext
            {
                public static bool Matches(this string? value, string expected) => value == expected;
            }

            public static class Ordinary
            {
                public static bool Matches(string? value, string expected) => value == expected;
            }

            public sealed class C
            {
                public bool Direct(string value) => value.Matches("x");
                public bool? Conditional(Box? box) => box?.Value.Matches("x");
                public bool NonExtension(Box? box) => Ordinary.Matches(box?.Value, "x");
            }
            """);

        Assert.Contains("value.Matches(\"x\")", printed, StringComparison.Ordinal);
        Assert.Contains("box?.Value.Matches(\"x\")", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(box?.Value).Matches(\"x\")", printed, StringComparison.Ordinal);
        Assert.Contains("Ordinary.Matches(box?.Value, \"x\")", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullAndNonNullPaths_PreserveCallsResultsAndEvaluationOrderAtRuntime()
    {
        string printed = TranslateAndValidate("""
            #nullable enable
            using System;
            namespace Demo;

            public sealed class Box
            {
                public string? Value { get; set; }
            }

            public static class Ext
            {
                public static string Log = "";

                public static bool Matches(this string? value, string expected)
                {
                    Log += "M";
                    return value == expected;
                }

                public static int? LengthOrNull(this string? value)
                {
                    Log += "N";
                    return value?.Length;
                }

                public static void Touch(this string? value)
                {
                    Log += value is null ? "V0" : "V1";
                }

                public static string Combine(this string? value, string suffix)
                {
                    Log += "B";
                    return (value ?? "nil") + suffix;
                }

                public static bool Bare(Box? box, string expected) => Matches(box?.Value, expected);
            }

            public static class C
            {
                private static string? Receiver(Box? box)
                {
                    Ext.Log += "R";
                    return box?.Value;
                }

                private static string Argument()
                {
                    Ext.Log += "A";
                    return "!";
                }

                public static void Run()
                {
                    Box? absent = null;
                    var present = new Box { Value = "x" };

                    Console.WriteLine(Ext.Matches(absent?.Value, "x"));
                    Console.WriteLine(Ext.Matches(present?.Value, "x"));
                    Console.WriteLine(Ext.Bare(absent, "x"));
                    Console.WriteLine(Ext.LengthOrNull(absent?.Value) is null);
                    Ext.Touch(absent?.Value);
                    Ext.Touch(present?.Value);
                    Console.WriteLine(Ext.Combine(Receiver(absent), Argument()));
                    Console.WriteLine(Ext.Log);
                }
            }
            """);

        Assert.Contains("(absent?.Value).Matches(\"x\")", printed, StringComparison.Ordinal);
        Assert.Contains("(present?.Value).Matches(\"x\")", printed, StringComparison.Ordinal);
        Assert.Contains("(absent?.Value).LengthOrNull()", printed, StringComparison.Ordinal);
        Assert.Contains("(absent?.Value).Touch()", printed, StringComparison.Ordinal);

        string output = CompileAndRun(printed, "C.Run()");
        Assert.Equal(
            "False\nTrue\nFalse\nTrue\nnil!\nMMMNV0V1RAB\n",
            output.Replace("\r\n", "\n"));
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int start = 0;
        while ((start = text.IndexOf(value, start, StringComparison.Ordinal)) >= 0)
        {
            count++;
            start += value.Length;
        }

        return count;
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
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

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

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-2467-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        (int compileExit, string compileOutput) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet. Output:\n" + compileOutput +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string output) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + output);
        return output;
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
}
