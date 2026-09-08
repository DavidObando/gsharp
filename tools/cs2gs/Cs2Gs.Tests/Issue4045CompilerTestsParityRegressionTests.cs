// <copyright file="Issue4045CompilerTestsParityRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4045: migrated Compiler.Tests must preserve explicitly declared CLR
/// delegate identity and must not turn intentionally nullable reflection
/// results into checked G# assertions.
/// </summary>
public sealed class Issue4045CompilerTestsParityRegressionTests
{
    private const string XunitReflectionSource = """
        #nullable disable
        using System.Reflection;
        using Xunit;

        public static class ReflectionProbe
        {
            public static void Run(MethodInfo method, object instance)
            {
                var ex = Record.Exception(() => method.Invoke(instance, null));
                Assert.Null(ex);
                Assert.Null(Record.Exception(() => method.Invoke(instance, null)));
            }
        }
        """;

    private const string Source = """
        #nullable enable
        using System;
        using System.Reflection;

        public sealed class Bell
        {
            public event EventHandler? Rang;

            public void Ring() => Rang?.Invoke(this, EventArgs.Empty);
        }

        public static class Probe
        {
            private static Exception? Capture(Func<object?> action)
            {
                try
                {
                    action();
                    return null;
                }
                catch (Exception ex)
                {
                    return ex;
                }
            }

            public static void Main()
            {
                var bell = new Bell();
                var hits = 0;
                EventHandler handler = (_, _) => hits++;
                typeof(Bell).GetEvent("Rang")!.AddEventHandler(bell, handler);
                bell.Ring();

                MethodInfo method = typeof(Bell).GetMethod("Ring")!;
                var ex = Capture(() => method.Invoke(bell, null));
                Console.WriteLine(hits.ToString() + "|" + (ex is null).ToString());
            }
        }
        """;

    [Fact]
    public void ExplicitDelegateAndIntentionalNullResults_PreserveSourceSemantics()
    {
        string printed = Translate(Source);

        Assert.Contains(
            "let handler EventHandler = (_ object?, _ EventArgs) -> hits++",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("method.Invoke(bell, nil)!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let ex = Capture(() -> method.Invoke(bell, nil))!!", printed, StringComparison.Ordinal);

        string compiler = FindCompiler();
        Assert.NotNull(compiler);

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4045CompilerTestsParityRegressionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Program.gs");
        string dllPath = Path.Combine(workDir, "Program.dll");
        File.WriteAllText(gsPath, printed);

        (int compileExit, string compileOutput) = RunDotnet(
            $"\"{compiler}\" /target:exe /targetframework:net10.0 /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0,
            "gsc must compile the translated program. Output:\n" + compileOutput
                + "\n\nTranslated G#:\n" + printed);

        if (IlVerifyRunner.IsEnabled)
        {
            var verifier = new IlVerifyRunner();
            Assert.True(verifier.EnsureToolAvailable(), "dotnet-ilverify must be available.");
            IlVerifyResult verify = verifier.Verify(dllPath);
            Assert.True(
                verify.Errors.Count == 0,
                "ilverify reported findings:\n"
                    + string.Join(Environment.NewLine, verify.Errors.Select(error => error.RawLine)));
        }

        File.WriteAllText(
            Path.Combine(workDir, "Program.runtimeconfig.json"),
            "{\n  \"runtimeOptions\": {\n    \"tfm\": \"net10.0\",\n"
                + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \""
                + Environment.Version.Major + ".0.0\" }\n  }\n}\n");
        (int runExit, string output) = RunDotnet($"\"{dllPath}\"");
        Assert.Equal(0, runExit);
        Assert.Equal("2|True", output.Trim());
    }

    [Fact]
    public void RecordExceptionAroundNullableReflectionResult_DoesNotAddRuntimeAssertions()
    {
        string printed = Translate(XunitReflectionSource);
        string[] lines = printed.Split('\n')
            .Where(candidate => candidate.Contains("Record.Exception", StringComparison.Ordinal))
            .ToArray();

        Assert.Equal(2, lines.Length);
        Assert.All(lines, line =>
        {
            Assert.Contains("method.Invoke(", line, StringComparison.Ordinal);
            Assert.DoesNotContain(")!!", line, StringComparison.Ordinal);
        });
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Issue4045.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using Process process = Process.Start(startInfo);
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
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    directory.FullName,
                    "out",
                    "bin",
                    config,
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
