// <copyright file="BranchArmEffectiveTargetForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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

/// <summary>
/// A conditional or switch-expression arm flows into the target of the WHOLE
/// expression, so whether the arm needs <c>!!</c> depends on that target
/// rather than on the arm itself. cs2gs asserted a nullable arm unconditionally.
/// That turned <c>string emittedName = constructorIndex &gt;= 0 ? null :
/// argument.Name;</c> into <c>… else { argument.Name!! }</c> inside a
/// <c>string?</c> local, and the migrated translator threw
/// <c>NullReferenceException</c> on every positional attribute argument
/// (<c>Name</c> is null). That was the nightly self-migration's
/// <c>Cs2Gs.Tests</c> test-parity failure in
/// <c>CSharpToGSharpTranslator.LibraryImport</c>. An arm whose target is
/// non-null keeps its <c>!!</c>.
/// </summary>
public class BranchArmEffectiveTargetForgivenessTests
{
    private const string Model = @"
namespace Model
{
    public sealed class Arg
    {
        public Arg(string value, string name = null) { Value = value; Name = name; }
        public string Name { get; }
        public string Value { get; }
    }

    public static class Printer
    {
        public static string Print(Arg a) => a.Name == null ? a.Value : a.Name + "": "" + a.Value;
    }
}";

    /// <summary>
    /// The exact LibraryImport shape, across projects as in the migration
    /// (the translator reads <c>AttributeArgument.Name</c> from
    /// <c>Cs2Gs.CodeModel</c>), compiled and run: a positional argument (null
    /// <c>Name</c>) takes the conditional's non-null arm, which must not
    /// assert.
    /// </summary>
    [Fact]
    public void LibraryImportShape_PositionalArgument_CompilesAndRuns()
    {
        const string app = @"
using System.Collections.Generic;
using System.Text;
using Model;

namespace App
{
    public static class Emitter
    {
        private static int ConstructorParameterIndex(string name) => name == null ? -1 : name == ""libraryName"" ? 0 : -1;

        public static string Emit(List<Arg> arguments)
        {
            var builder = new StringBuilder();
            foreach (Arg argument in arguments)
            {
                int constructorIndex = ConstructorParameterIndex(argument.Name);
                string emittedName = constructorIndex >= 0 ? null : argument.Name;
                builder.Append(emittedName == null ? argument.Value : emittedName + ""="" + argument.Value).Append(';');
            }

            return builder.ToString();
        }

        public static string Run() => Emit(new List<Arg>
        {
            new Arg(""libc""),
            new Arg(""Lib"", ""libraryName""),
            new Arg(""Utf8"", ""StringMarshalling""),
        });
    }
}";
        (string library, string consumer) = TranslateBothProjects(app);

        Assert.Contains("prop Name string?", library);
        Assert.DoesNotContain("argument.Name!!", consumer);
        Assert.Equal(
            "libc;Lib;StringMarshalling=Utf8;",
            CompileAndRun(new[] { library, consumer }, "App.Emitter.Run()").Trim());
    }

    /// <summary>
    /// Every branching form whose whole-expression target accepts nil leaves
    /// the arm bare when the member is declared in another project of the run:
    /// a conditional or switch into a widened local, a return from a widened
    /// method, an expression-bodied member, an assignment, the left operand of
    /// <c>??</c>, a <c>?.</c> receiver, a <c>== null</c> / <c>is null</c> test,
    /// and an inferred generic parameter, which G# re-infers from the argument.
    /// </summary>
    [Fact]
    public void NullableEffectiveTarget_ArmsStayBare()
    {
        const string app = @"
namespace App
{
    public static class Use
    {
        public static string Local(Model.Arg argument, int i)
        {
            string emittedName = i >= 0 ? null : argument.Name;
            return emittedName;
        }

        public static string Switch(Model.Arg argument, int i)
        {
            string e = i switch { 0 => null, _ => argument.Name };
            return e;
        }

        public static string Arrow(Model.Arg argument, int i) => i >= 0 ? null : argument.Name;

        public static string Returns(Model.Arg argument, int i)
        {
            if (i > 3) { return i >= 0 ? null : argument.Name; }
            return i switch { 0 => null, _ => argument.Name };
        }

        public static string Assigned(Model.Arg argument, int i)
        {
            string e;
            e = i >= 0 ? null : argument.Name;
            return e;
        }

        public static string Coalesced(Model.Arg argument, int i) => (i >= 0 ? null : argument.Name) ?? ""fallback"";

        public static string SwitchCoalesced(Model.Arg argument, int i) => (i switch { 0 => null, _ => argument.Name }) ?? ""fallback"";

        public static int? Accessed(Model.Arg argument, int i) => (i >= 0 ? null : argument.Name)?.Length;

        public static int? SwitchAccessed(Model.Arg argument, int i) => (i switch { 0 => argument.Value, _ => argument.Name })?.Length;

        public static bool Compared(Model.Arg argument, int i) => (i >= 0 ? argument.Value : argument.Name) == null;

        public static bool Tested(Model.Arg argument, int i) => (i switch { 0 => argument.Value, _ => argument.Name }) is null;

        public static T Id<T>(T value) => value;

        public static string Inferred(Model.Arg argument, int i) => Id(i > 0 ? argument.Value : argument.Name);
    }
}";
        string printed = TranslateCrossProject(app);

        Assert.DoesNotContain("argument.Name!!", printed);
    }

    /// <summary>
    /// Precision: an arm whose whole-expression target is a non-null
    /// parameter still asserts, for a conditional and for a switch, and so
    /// does an arm into a generic parameter whose type argument is explicit.
    /// </summary>
    [Fact]
    public void NonNullEffectiveTarget_ArmsKeepAssertion()
    {
        const string app = @"
namespace App
{
    public static class Use
    {
        public static int Index(string name) => name == ""x"" ? 0 : -1;

        public static int Conditional(Model.Arg argument, int i) => Index(i > 0 ? argument.Name : ""x"");

        public static int Switch(Model.Arg argument, int i) => Index(i switch { 0 => argument.Name, _ => ""y"" });

        public static T Id<T>(T value) => value;

        public static string Explicit(Model.Arg argument, int i) => Id<string>(i > 0 ? argument.Value : argument.Name);
    }
}";
        string printed = TranslateCrossProject(app);

        Assert.Contains("if i > 0 { argument.Name!! } else { \"x\" }", printed);
        Assert.Contains("case 0: argument.Name!!", printed);
        Assert.Contains("Id[string](if i > 0 {", printed);
        Assert.Contains("else { argument.Name!! })", printed);
    }

    private static string TranslateCrossProject(string app) => TranslateBothProjects(app).Consumer;

    private static (string Library, string Consumer) TranslateBothProjects(string app)
    {
        (CSharpCompilation library, MetadataReference image) = Compile(Model, "Model", Array.Empty<MetadataReference>());
        (CSharpCompilation consumer, _) = Compile(app, "App", new[] { image });
        var repository = new[] { library, consumer };
        return (Translate(library, repository), Translate(consumer, repository));
    }

    private static string Translate(CSharpCompilation compilation, IReadOnlyList<CSharpCompilation> repository)
    {
        SyntaxTree tree = Assert.Single(compilation.SyntaxTrees);
        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument(tree.FilePath, tree, model);
        var context = new TranslationContext(
            compilation,
            model,
            document.FilePath,
            siblingCompilations: repository,
            repositoryCompilations: repository);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static (CSharpCompilation Compilation, MetadataReference Image) Compile(
        string source,
        string assemblyName,
        IReadOnlyList<MetadataReference> references)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Concat(references),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var peStream = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = compilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        return (compilation, MetadataReference.CreateFromStream(peStream));
    }

    private static string CompileAndRun(IReadOnlyList<string> printedFiles, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "branch-arm-effective-target-e2e",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string dllPath = Path.Combine(workDir, "Snippet.dll");
            var arguments = new List<string> { compiler, "/target:exe", $"/out:{dllPath}" };
            for (int i = 0; i < printedFiles.Count; i++)
            {
                string gsPath = Path.Combine(workDir, $"Unit{i}.gs");
                File.WriteAllText(gsPath, printedFiles[i]);
                arguments.Add(gsPath);
            }

            string entryPath = Path.Combine(workDir, "Main.gs");
            File.WriteAllText(entryPath, $"import System{Environment.NewLine}{Environment.NewLine}Console.WriteLine({callExpression}){Environment.NewLine}");
            arguments.Add(entryPath);

            (int compileExit, string compileOutput) = RunDotnet(arguments.ToArray());
            Assert.True(
                compileExit == 0 && !compileOutput.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOutput
                    + "\n\nTranslated G#:\n" + string.Join(Environment.NewLine, printedFiles));

            (int runExit, string runOutput) = RunDotnet(dllPath);
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOutput);
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
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

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
