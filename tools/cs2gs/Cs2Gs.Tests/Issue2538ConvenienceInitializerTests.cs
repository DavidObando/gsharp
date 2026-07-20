// <copyright file="Issue2538ConvenienceInitializerTests.cs" company="GSharp">
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

/// <summary>Issue #2538: C# this-constructor initializers lower canonically.</summary>
public sealed class Issue2538ConvenienceInitializerTests
{
    private const string Source = """
        using System;

        namespace Issue2538;

        public sealed class Routed
        {
            private int value;

            public Routed(int left, int right)
            {
                value = (left * 10) + right;
            }

            public Routed(int seed)
                : this(Trace(seed), Trace(seed + 1))
            {
                seed++;
                value += seed;
            }

            public Routed()
                : this(2)
            {
                value += 1000;
            }

            private static int Trace(int value)
            {
                Console.Write(value);
                return value;
            }

            public int Value() => value;
        }
        """;

    [Fact]
    public void Translator_OverloadedThisInitializers_KeepDelegationCanonicalAndFirst()
    {
        (CompilationUnit unit, string printed) = Translate();
        TypeDeclaration routed = Assert.Single(unit.Members.OfType<TypeDeclaration>());
        ConstructorDeclaration singleArgument = routed.Members
            .OfType<ConstructorDeclaration>()
            .Single(c => c.Parameters.Count == 1);

        Assert.NotNull(singleArgument.DelegatingArguments);
        Assert.Equal(2, singleArgument.DelegatingArguments.Count);
        Assert.DoesNotContain(
            singleArgument.Body.Statements,
            s => s is ExpressionStatement
                {
                    Expression: InvocationExpression
                    {
                        Target: IdentifierExpression { Name: "init" },
                    },
                });

        int delegation = printed.IndexOf(
            "init(Routed.Trace(seed), Routed.Trace(seed + 1))",
            StringComparison.Ordinal);
        int parameterShadow = printed.IndexOf("var seed = seed", StringComparison.Ordinal);
        Assert.True(delegation >= 0 && parameterShadow > delegation, printed);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
    }

    [Fact]
    public void Compiler_OverloadedThisInitializers_AcceptsCanonicalDelegation()
    {
        (_, string printed) = Translate();
        (int exit, string output, _) = Compile(printed);

        Assert.True(
            exit == 0 && !output.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must accept translated overloaded constructors. Output:\n" +
                output + "\n\nTranslated G#:\n" + printed);
    }

    [Fact]
    public void Runtime_OverloadedThisInitializers_PreserveArgumentAndBodyOrder()
    {
        (_, string printed) = Translate();
        (int compileExit, string compileOutput, string assembly) = Compile(printed);
        Assert.True(compileExit == 0, compileOutput);

        (int runExit, string stdout) = RunDotnet($"\"{assembly}\"");
        Assert.True(runExit == 0, stdout);
        Assert.Equal("231026" + Environment.NewLine, stdout);
    }

    private static (CompilationUnit Unit, string Printed) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", Source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        return (unit, GSharpPrinter.Print(unit));
    }

    private static (int Exit, string Output, string Assembly) Compile(string printed)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-2538-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string source = Path.Combine(workDir, "Repro.gs");
        string assembly = Path.Combine(workDir, "Repro.dll");
        File.WriteAllText(
            source,
            printed + Environment.NewLine +
                "Console.WriteLine(Routed().Value().ToString())" + Environment.NewLine);

        (int exit, string output) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{assembly}\" \"{source}\"");
        return (exit, output, assembly);
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
