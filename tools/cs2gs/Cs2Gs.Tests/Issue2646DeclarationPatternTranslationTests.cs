// <copyright file="Issue2646DeclarationPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2646DeclarationPatternTranslationTests
{
    [Fact]
    public void OahuNullableIntPattern_PreservesCodeIdentity()
    {
        string printed = Translate("""
            namespace Oahu.Cli
            {
                public sealed class Program
                {
                    public int Run(int? rewriteResult)
                    {
                        try
                        {
                            var rewriteCode = rewriteResult;
                            if (rewriteCode is int code)
                            {
                                return code;
                            }
                        }
                        catch
                        {
                        }

                        return -1;
                    }
                }
            }
            """);

        Assert.Contains("let __spill0 = rewriteCode", printed, StringComparison.Ordinal);
        Assert.Contains("var code int32", printed, StringComparison.Ordinal);
        Assert.Contains("if __spill0 is int32", printed, StringComparison.Ordinal);
        Assert.Contains("code = int32(__spill0)", printed, StringComparison.Ordinal);
        Assert.Contains("return code", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("let code = rewriteCode", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("if rewriteCode is int32", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("return rewriteCode", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ValuePattern_NarrowsNamedBinderAcrossFollowingScope()
    {
        string printed = Translate("""
            namespace Demo
            {
                public sealed class C
                {
                    public int Read(object value)
                    {
                        if (value is int code)
                        {
                        }
                        else
                        {
                            return -1;
                        }

                        code = code + 1;
                        return code;
                    }
                }
            }
            """);

        Assert.Contains("var code int32", printed, StringComparison.Ordinal);
        Assert.Contains("code = int32(__spill0)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("return value", printed, StringComparison.Ordinal);
        Assert.Equal(
            "43\n-1",
            CompileAndRun(
                printed,
                "System.Console.WriteLine(C().Read(42))\nSystem.Console.WriteLine(C().Read(\"no\"))").Trim());
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }

    private static string CompileAndRun(string printed, string entryPoint)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue-2646",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string source = Path.Combine(directory, "Program.gs");
        string output = Path.Combine(directory, "Program.dll");
        File.WriteAllText(source, printed + Environment.NewLine + entryPoint + Environment.NewLine);

        (int compileExit, string compileOutput) = Run(
            $"\"{compiler}\" /target:exe /out:\"{output}\" \"{source}\"");
        Assert.True(compileExit == 0, compileOutput + Environment.NewLine + printed);

        (int runExit, string runOutput) = Run($"\"{output}\"");
        Assert.True(runExit == 0, runOutput);
        return runOutput;
    }

    private static (int ExitCode, string Output) Run(string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });
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
