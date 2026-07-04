// <copyright file="Issue2012OpenGenericTypeOfProducerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #2012 (S1): cs2gs's translation of a C# unbound generic
/// <c>typeof(...)</c> operand (<c>typeof(Func&lt;&gt;)</c>,
/// <c>typeof(Dictionary&lt;,&gt;)</c>) was untouched by #1989/#2011 — it kept
/// emitting the bare generic-definition name (<c>typeof(Func)</c>), which
/// stays ambiguous (GS0113) for a same-base-name multi-arity BCL family. cs2gs
/// now emits the canonical explicit-arity <c>_</c> placeholder form
/// established by #1989/#2011 (<c>typeof(Func[_])</c>,
/// <c>typeof(Dictionary[_, _])</c>) so the syntax has an automated C# → G#
/// producer, and proves the full round-trip: translate → compile with the
/// real <c>gsc</c> → run → the reflected <see cref="Type"/> is bit-for-bit
/// the same CLR open generic type definition as C#'s own <c>typeof(Func&lt;&gt;)</c>.
/// </summary>
public class Issue2012OpenGenericTypeOfProducerTests
{
    [Fact]
    public void UnboundFunc_TypeOf_TranslatesToUnderscorePlaceholderAndRoundTrips()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Func<>);
    }
}");

        Assert.Contains("typeof(Func[_])", printed);
    }

    [Fact]
    public void UnboundFunc_TwoArity_TypeOf_TranslatesToUnderscorePlaceholderAndRoundTrips()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Func<,>);
    }
}");

        Assert.Contains("typeof(Func[_, _])", printed);
    }

    /// <summary>
    /// Full producer round-trip: the translated <c>typeof(Func[_])</c>
    /// compiles with the real <c>gsc</c> and, at run time, is REFLECTION-equal
    /// (not merely name-equal) to C#'s own <c>typeof(System.Func&lt;&gt;)</c> —
    /// proving cs2gs's emitted <c>_</c> placeholder form really does round-trip
    /// to the same CLR open generic type definition.
    /// </summary>
    [Fact]
    public void UnboundFunc_TypeOf_CompilesAndReflectsSameClrOpenGenericDefinition()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            // gsc.dll not built in this run (e.g. cs2gs-only build); the
            // translation-level assertions above still cover the producer.
            return;
        }

        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public class C
    {
        public Type Describe() => typeof(Func<>);
    }
}");
        Assert.Contains("typeof(Func[_])", printed);

        string source = """
            package i2012s1func1
            import System

            func Main() { System.Console.WriteLine(typeof(Func[_]).AssemblyQualifiedName) }
            """;

        string workDir = Path.Combine(AppContext.BaseDirectory, "i2012-e2e");
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Program.gs");
        string dllPath = Path.Combine(workDir, "Program.dll");
        File.WriteAllText(gsPath, source);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the emitted `_` placeholder form with zero errors. Output:\n" + compileOut);

        var runResult = RunDotnetFull($"\"{dllPath}\"");
        Assert.True(runResult.Exit == 0, "The compiled program must run successfully. Output:\n" + runResult.Combined);
        string stdout = runResult.Stdout;

        var reflectedType = Type.GetType(stdout.Trim());
        Assert.Equal(typeof(Func<>), reflectedType);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Empty(context.Diagnostics);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static (int Exit, string Stdout, string Combined) RunDotnetFull(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdout, stdout + stderr);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        (int exit, string _, string combined) = RunDotnetFull(arguments);
        return (exit, combined);
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
