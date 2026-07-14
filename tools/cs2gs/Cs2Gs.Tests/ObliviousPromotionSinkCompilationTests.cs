// <copyright file="ObliviousPromotionSinkCompilationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class ObliviousPromotionSinkCompilationTests
{
    [Fact]
    public void ObliviousPromotion_SinksCompileWithGsc()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    using System.Collections.Generic;

    public interface INode
    {
        string Name { get; }
    }

    public class Node : INode
    {
        public string Name { get; set; }

        public void Clear()
        {
            Name = null;
        }
    }

    public class Box
    {
        public string Text;
        public string[] Items;
    }

    public class Target
    {
        public string Field;
    }

    public class Cases
    {
        public string ViaConcrete(Node node)
        {
            if (node.Name == null) { return ""missing""; }
            return node.Name;
        }

        public string ViaInterface(INode node)
        {
            if (node.Name == null) { return ""missing""; }
            return node.Name;
        }

        public string VarNullCompare(string input)
        {
            var x = input;
            if (x == null) { return ""missing""; }
            return x;
        }

        public T Generic<T>(T value) where T : class
        {
            T local = value;
            if (value == null) { local = null; }
            return local;
        }

        public void Sinks(Box box, string[] array, Dictionary<string, string> dict)
        {
            array[0] = box?.Text;
            array[1] = box.Items?[0];
            dict[""k""] = box?.Text;
            var target = new Target { Field = box?.Text };
        }

        public string Pick(int i)
        {
            return i switch
            {
                0 => ""zero"",
                _ => null,
            };
        }
    }
}");

        Assert.Contains("Name string?", printed);
        Assert.Contains("if x == nil", printed);
        Assert.Contains("Generic[T class](value T?) T?", printed);
        Assert.Contains("array[0] = box?.Text!!", printed);
        Assert.Contains("array[1]", printed);
        Assert.Contains("dict[\"k\"] = box?.Text!!", printed);
        Assert.Contains("Field:", printed);
        Assert.Contains("default(string?)", printed);
        CompileWithGsc(printed);
    }

    [Fact]
    public void ObliviousPromotion_DisabledForNullableEnabledCompilation()
    {
        string printed = TranslateEnabled(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public string Keep(string input)
        {
            var x = input;
            return x;
        }
    }
}");

        Assert.DoesNotContain("string?", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));
        Assert.DoesNotContain(compilation.GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static void CompileWithGsc(string printed)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "oblivious-promotion", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed);

        (int exit, string output) = RunDotnet($"\"{compiler}\" /target:library /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            exit == 0 && !output.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile translated snippet with zero errors. Output:\n" + output +
                "\n\nTranslated G#:\n" + printed);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(psi);
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
