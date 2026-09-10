// <copyright file="Issue4177ForAssignmentIncrementTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4177: a C-style <c>for</c> loop whose increment clause is a
/// general assignment expression (not <c>++</c>/<c>--</c>) — e.g.
/// <c>for (var c = s; c != null; c = c.Next)</c> — translated to G# that
/// failed to parse (<c>Unexpected token &lt;CloseBraceToken&gt;, expected
/// &lt;IdentifierToken&gt;</c>).
/// <para>
/// Root cause (confirmed at the parser layer, not the translator): G#'s
/// <c>for</c>-clause post/increment parsing (<c>ParseForClauseStatement</c>,
/// <c>src/Core/CodeAnalysis/Syntax/Parser.Statements.cs</c>) already
/// suppressed the OBJECT-initializer wrap for a post expression ending in a
/// call/indexer (issue #1023), but not the sibling STRUCT-literal check
/// (<c>ParseNameOrCallExpression</c>'s <c>Identifier {</c> shape, gated by
/// the separate <c>suppressStructLiteral</c> counter). A post clause ending
/// in a bare identifier (any assignment RHS shaped as a member access or a
/// lone identifier — <c>c = c.Next</c>, <c>c = s</c>, <c>c += d</c>) directly
/// followed by an EMPTY loop body was therefore mis-parsed as that
/// identifier's (empty) struct-literal initializer, swallowing the body's
/// opening brace. See
/// <c>test/Core.Tests/CodeAnalysis/Syntax/Issue4177ForClauseAssignmentIncrementParserTests.cs</c>
/// for the parser-level regression coverage; this file proves the
/// TRANSLATOR's already-correct emission (nothing changed in
/// <c>CSharpToGSharpTranslator</c>/<c>GSharpPrinter</c> for this issue) now
/// round-trips end to end, including actual runtime behavior parity with the
/// original C#.
/// </para>
/// </summary>
public class Issue4177ForAssignmentIncrementTranslationTests
{
    /// <summary>
    /// The exact repro from the issue: translates, and the emitted G# now
    /// parses and binds without errors (it did not before the parser fix).
    /// </summary>
    [Fact]
    public void AssignmentIncrementForLoop_WithEmptyBody_TranslatesToValidGSharp()
    {
        string printed = TranslateUnit(@"
class C
{
    void M(C s)
    {
        for (var c = s; c != null; c = c.Next)
        {
        }
    }

    public C Next;
}
");

        // The translator's emission shape is unchanged by this fix — still an
        // inline assignment in the post/increment slot, not a lowered `while`.
        Assert.Contains("for var c", printed, StringComparison.Ordinal);
        Assert.Contains("c = c", printed, StringComparison.Ordinal);
        Assert.Contains(".Next", printed, StringComparison.Ordinal);

        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// A bare-identifier assignment RHS (<c>c = s</c>, no member access) hits
    /// the same <c>Identifier {</c> shape and must also translate cleanly.
    /// </summary>
    [Fact]
    public void AssignmentIncrementForLoop_BareIdentifierRhs_TranslatesToValidGSharp()
    {
        string printed = TranslateUnit(@"
class C
{
    void M(C a, C b)
    {
        for (var c = a; c != null; c = b)
        {
        }
    }
}
");

        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// A compound assignment (<c>+=</c>) whose RHS is a bare identifier hits
    /// the identical parser shape as simple assignment — confirms the fix
    /// (and this translation path) isn't scoped to <c>=</c> specifically.
    /// </summary>
    [Fact]
    public void CompoundAssignmentIncrementForLoop_IdentifierRhs_TranslatesToValidGSharp()
    {
        string printed = TranslateUnit(@"
class C
{
    void M(int limit, int step)
    {
        for (var i = 0; i < limit; i += step)
        {
        }
    }
}
");

        Assert.Contains("i += step", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// Multiple comma-separated incrementors already take the block+
    /// <c>while</c> lowering (issue #914's <c>LowerForToWhile</c>), which
    /// places every incrementor as a real trailing STATEMENT inside the
    /// lowered body rather than inline in a <c>for</c> header — so this
    /// shape was never exposed to the #4177 parser gap. Confirmed still
    /// green here as the "already handled" half of the increment-shape
    /// survey.
    /// </summary>
    [Fact]
    public void MultipleIncrementors_OneShapedAsAssignment_StillLowersAndBinds()
    {
        string printed = TranslateUnit(@"
class C
{
    void M()
    {
        for (int i = 0, j = 0; i < 10; i++, j = j + 1)
        {
        }
    }
}
");

        Assert.Contains("while", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    /// <summary>
    /// The functional proof: a 3-node singly-linked list walked with
    /// <c>for (var c = head; c != null; c = c.Next) { count++; }</c>,
    /// printing the resulting count. Compiled and RUN both as the original
    /// C# (via an in-memory Roslyn emit) and as the cs2gs-translated G#
    /// (via the real <c>gsc.dll</c>) — both must print <c>3</c>, proving the
    /// fix preserves runtime semantics, not merely that the output parses.
    /// </summary>
    [Fact]
    public void AssignmentIncrementForLoop_RuntimeBehaviorMatchesOriginalCSharp()
    {
        const string source = @"
using System;

public class Node
{
    public Node Next;
}

public class Program
{
    public static void Main()
    {
        Node third = new Node { Next = null };
        Node second = new Node { Next = third };
        Node first = new Node { Next = second };

        int count = 0;
        for (var c = first; c != null; c = c.Next)
        {
            count++;
        }

        Console.WriteLine(count);
    }
}
";

        string csharpOutput = CompileAndRunCSharp(source).Trim();
        Assert.Equal("3", csharpOutput);

        string printed = TranslateUnit(source, OutputKind.ConsoleApplication);
        TranslationTestValidation.AssertBinds(printed);

        string gsharpOutput = CompileAndRunGSharp(printed).Trim();
        Assert.Equal("3", gsharpOutput);
        Assert.Equal(csharpOutput, gsharpOutput);
    }

    private static string TranslateUnit(string source, OutputKind outputKind = OutputKind.DynamicallyLinkedLibrary)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            references: null,
            assemblyName: "Cs2Gs.InMemory",
            outputKind: outputKind);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        return GSharpPrinter.Print(unit);
    }

    private static string CompileAndRunCSharp(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        var tree = CSharpSyntaxTree.ParseText(source, parseOptions);
        var compilation = CSharpCompilation.Create(
            "Issue4177CSharpWitness",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.ConsoleApplication));

        using var peStream = new MemoryStream();
        EmitResult emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "C# witness must compile. Diagnostics:\n" +
                string.Join("\n", emitResult.Diagnostics.Select(d => d.ToString())));

        peStream.Position = 0;
        Assembly assembly = Assembly.Load(peStream.ToArray());
        MethodInfo entryPoint = assembly.EntryPoint;
        Assert.NotNull(entryPoint);

        TextWriter originalOut = Console.Out;
        var capturedOut = new StringWriter();
        Console.SetOut(capturedOut);
        try
        {
            object[] parameters = entryPoint.GetParameters().Length == 0
                ? Array.Empty<object>()
                : new object[] { Array.Empty<string>() };
            entryPoint.Invoke(null, parameters);
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        return capturedOut.ToString();
    }

    private static string CompileAndRunGSharp(string gsharpSource)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4177ForAssignmentIncrementTranslationTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Program.gs");
            string dllPath = Path.Combine(workDir, "Program.dll");
            File.WriteAllText(gsPath, gsharpSource);

            var references = TrustedPlatformAssemblies().ToList();
            var arguments = new StringBuilder()
                .Append('"').Append(compiler).Append('"')
                .Append(" /target:exe /targetframework:net10.0 /nowarn:GS9100")
                .Append(" /out:\"").Append(dllPath).Append('"');
            foreach (string reference in references)
            {
                arguments.Append(" /reference:\"").Append(reference).Append('"');
            }

            arguments.Append(" \"").Append(gsPath).Append('"');

            (int compileExit, string compileOutput) = RunDotnet(arguments.ToString());
            Assert.True(
                compileExit == 0,
                "gsc must compile the translated witness. Output:\n" + compileOutput + "\n\nSource:\n" + gsharpSource);

            (int runExit, string output) = RunDotnet($"\"{dllPath}\"");
            Assert.True(runExit == 0, "the translated witness must run cleanly. Output:\n" + output);

            return output;
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("failed to start dotnet");
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
                string candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static System.Collections.Generic.IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (string path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
