// <copyright file="Issue1909PrimaryConstructorTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1909: a C# 12 primary constructor (<c>class NamedItem(string name)
/// { ... }</c>) had its parameter list silently dropped by
/// <c>CSharpToGSharpTranslator.MapPrimaryConstructor</c> — that method only
/// recognized <see cref="Microsoft.CodeAnalysis.CSharp.Syntax.RecordDeclarationSyntax"/>,
/// so a plain <c>class</c>/<c>struct</c> primary-ctor parameter list (which
/// hangs off the same <c>TypeDeclarationSyntax.ParameterList</c> property)
/// was ignored. The emitted G# then referenced the vanished parameter as a
/// free variable (GS0125) and constructed the type with zero arguments
/// (GS0144). A derived type's <c>: Base(arg)</c> forwarding call
/// (<see cref="Microsoft.CodeAnalysis.CSharp.Syntax.PrimaryConstructorBaseTypeSyntax"/>)
/// failed the same way — the base-call argument list was never read at all.
///
/// G# has native primary constructors, including an explicit base-call form
/// <c>class Derived(...) : Base(args) { ... }</c> (ADR-0065 §5,
/// <c>Parser.cs</c> <c>baseCtorOpenParen</c>/<c>BaseConstructorArguments</c>),
/// so both C# shapes map directly with no semantic loss.
/// </summary>
public class Issue1909PrimaryConstructorTranslationTests
{
    [Fact]
    public void PlainClass_PrimaryConstructor_KeepsParameterList()
    {
        string rendered = Render(@"
namespace Corpus.Issue1909
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }
}
");

        Assert.Contains("class NamedItem(name string) {", rendered, StringComparison.Ordinal);
        Assert.Contains("return name", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void DerivedClass_PrimaryConstructorBaseType_ForwardsBaseArguments()
    {
        string rendered = Render(@"
namespace Corpus.Issue1909
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }

    public class PricedItem(string name, int price) : NamedItem(name)
    {
        public int Price()
        {
            return price;
        }
    }
}
");

        Assert.Contains("open class NamedItem(name string) {", rendered, StringComparison.Ordinal);
        Assert.Contains("class PricedItem(name string, price int32) : NamedItem(name) {", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void Struct_PrimaryConstructor_KeepsParameterList()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1909
{
    public struct Point(int x, int y)
    {
        public int Sum()
        {
            return x + y;
        }
    }
}
") });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        // ignore the pre-existing "receiver-clause form" info diagnostic
        // (issue #938, unrelated to primary constructors) that every
        // struct instance-method translation emits.
        string rendered = GSharpPrinter.Print(unit);

        Assert.Contains("struct Point(x int32, y int32) {", rendered, StringComparison.Ordinal);
        Assert.Contains("return x + y", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void Record_PrimaryConstructorBaseType_StillForwardsBaseArguments()
    {
        // The record positional-parameter path already worked before this fix
        // (RecordDeclarationSyntax.ParameterList was special-cased), but the
        // `: Base(args)` forwarding call was never read at all — verify both
        // still hold together now that the class-primary-ctor gap is closed.
        string rendered = Render(@"
namespace Corpus.Issue1909
{
    public record Message(int Type, string Text);

    public record CustomMessage(int Type, string Text, string Extra) : Message(Type, Text);
}
");

        Assert.Contains("data class Message(Type int32, Text string) {", rendered, StringComparison.Ordinal);
        Assert.Contains(
            "data class CustomMessage(Type int32, Text string, Extra string) : Message(Type, Text) {",
            rendered,
            StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NullablePrimaryConstructorBaseArgument_IsForgiven()
    {
        string rendered = Render(@"
#nullable enable
namespace Corpus.Issue1909
{
    public record Message(string Text);
    public record CustomMessage(string? Text) : Message(Text);
}
");

        Assert.Contains(
            "data class CustomMessage(Text string?) : Message(Text!!) {",
            rendered,
            StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void TranslatedProgram_CompilesAndRunsWithGsc()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1909
{
    public class NamedItem(string name)
    {
        public string Name()
        {
            return name;
        }
    }

    public class PricedItem(string name, int price) : NamedItem(name)
    {
        public int Price()
        {
            return price;
        }
    }
}
");
        string stdout = CompileAndRun(
            rendered,
            "var item = NamedItem(\"widget\")\n" +
                "Console.WriteLine(\"name=\" + item.Name())\n" +
                "var priced = PricedItem(\"gadget\", 25)\n" +
                "Console.WriteLine(\"derived=\" + priced.Name() + \"/\" + priced.Price().ToString())");

        Assert.Equal(
            "name=widget" + Environment.NewLine + "derived=gadget/25" + Environment.NewLine,
            stdout);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="callExpression"/>
    /// appended as top-level entry statements) with the real <c>gsc</c> and runs
    /// it, returning stdout (mirrors <c>Issue1912ExplicitEnumValueTranslationTests.CompileAndRun</c>).
    /// </summary>
    private static string CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-1909-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

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
