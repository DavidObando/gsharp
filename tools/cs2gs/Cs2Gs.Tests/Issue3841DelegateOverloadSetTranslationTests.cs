// <copyright file="Issue3841DelegateOverloadSetTranslationTests.cs" company="GSharp">
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
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3841 — a legal C# overload set that discriminates on DELEGATE
/// IDENTITY (<c>Add(Predicate&lt;T&gt;)</c> / <c>Add(Func&lt;T, bool&gt;)</c>)
/// was translated into two members with the same G# signature, and gsc
/// correctly rejected the result with <c>GS0264</c>.
/// <para>
/// The issue was filed as a G# type-system gap wanting an ADR. It is not one:
/// gsc already declares and dispatches such an overload set when the delegate
/// types are spelled nominally. The duplicate is manufactured by cs2gs —
/// issue #2835's nominal-identity rule was scoped to SOURCE-declared
/// delegates, so imported ones (<c>Predicate</c>, <c>Func</c>) still erased to
/// the arrow form.
/// </para>
/// <para>
/// Preserving every imported delegate's nominal name would rewrite
/// <c>Func</c>/<c>Action</c> across the corpus for no benefit, so the rule is
/// scoped to the members that actually collide. The
/// <c>NonCollidingDelegates_StillRenderInArrowForm</c> test is the guard on
/// that scoping.
/// </para>
/// </summary>
public class Issue3841DelegateOverloadSetTranslationTests
{
    // Both the CLOSED shape (which gsc can also DISPATCH today) and the
    // GENERIC shape from the migrated fixture that reported the GS0264
    // (test/Interpreter.Tests/Issue2918InlineLambdaErasedReceiverEmittedOracleTests.cs).
    private const string Source = @"
using System;

namespace Overloads
{
    public sealed class ClosedDelegateOverloads
    {
        public string Add(Predicate<int> callback) => ""pred"";

        public string Add(Func<int, bool> callback) => ""func"";
    }

    public sealed class ClosedConstructorOverloads
    {
        public ClosedConstructorOverloads(Predicate<int> callback)
        {
            Kind = ""pred"";
        }

        public ClosedConstructorOverloads(Func<int, bool> callback)
        {
            Kind = ""func"";
        }

        public string Kind;
    }

    public sealed class Issue2948MethodDelegateOverloads<T>
    {
        public string Add(Predicate<T> callback) => ""pred"";

        public string Add(Func<T, bool> callback) => ""func"";
    }

    public sealed class Issue2948ConstructorDelegateOverloads<T>
    {
        public Issue2948ConstructorDelegateOverloads(Predicate<T> callback)
        {
            Kind = ""pred"";
        }

        public Issue2948ConstructorDelegateOverloads(Func<T, bool> callback)
        {
            Kind = ""func"";
        }

        public string Kind;
    }

    public sealed class NonCollidingDelegates
    {
        public int Length(Func<string, int> length)
        {
            return length(""x"");
        }

        public void Sink(Action<string> sink)
        {
            sink(""y"");
        }

        public bool Test(Predicate<string> test)
        {
            return test(""z"");
        }

        public string Both(Predicate<string> test, Func<string, int> length)
        {
            return test(""z"").ToString() + length(""x"").ToString();
        }
    }

    public static class Program
    {
        public static bool Always(int value)
        {
            return true;
        }

        public static void Main()
        {
            var methods = new ClosedDelegateOverloads();
            Predicate<int> predicate = Always;
            Func<int, bool> function = Always;
            Console.WriteLine(methods.Add(predicate));
            Console.WriteLine(methods.Add(function));
            Console.WriteLine(new ClosedConstructorOverloads(predicate).Kind);
            Console.WriteLine(new ClosedConstructorOverloads(function).Kind);
        }
    }
}
";

    /// <summary>
    /// The colliding method overload set keeps both nominal delegate names, so
    /// the two members no longer print the same signature.
    /// </summary>
    [Fact]
    public void CollidingMethodOverloadSet_KeepsNominalDelegateNames()
    {
        string rendered = Render();

        Assert.Contains("Add(callback Predicate[int32])", rendered, StringComparison.Ordinal);
        Assert.Contains("Add(callback Func[int32, bool])", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Add(callback (int32) -> bool)", rendered, StringComparison.Ordinal);
    }

    /// <summary>
    /// The same for the <c>.ctor</c> shape, which is the second of the two
    /// fingerprints this issue split out of #3837.
    /// </summary>
    [Fact]
    public void CollidingConstructorOverloadSet_KeepsNominalDelegateNames()
    {
        string rendered = Render();

        Assert.Contains("init(callback Predicate[int32])", rendered, StringComparison.Ordinal);
        Assert.Contains("init(callback Func[int32, bool])", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("init(callback (int32) -> bool)", rendered, StringComparison.Ordinal);
    }

    /// <summary>
    /// The generic shape from the migrated Interpreter.Tests fixture — the two
    /// members that actually reported the <c>GS0264</c>. Its type argument is
    /// an open <c>T</c>, so the collision rule must fire on the erased shapes
    /// rather than on any closed type.
    /// </summary>
    [Fact]
    public void GenericFixtureShape_KeepsNominalDelegateNames()
    {
        string rendered = Render();

        Assert.Contains("Add(callback Predicate[T])", rendered, StringComparison.Ordinal);
        Assert.Contains("Add(callback Func[T, bool])", rendered, StringComparison.Ordinal);
        Assert.Contains("init(callback Predicate[T])", rendered, StringComparison.Ordinal);
        Assert.Contains("init(callback Func[T, bool])", rendered, StringComparison.Ordinal);
    }

    /// <summary>
    /// The scoping guard. Delegate parameters that do NOT participate in a
    /// colliding overload set keep ADR-0115 §B.8's arrow form — including a
    /// <c>Predicate</c> and a <c>Func</c> on unrelated members and even side by
    /// side in one signature. Without this, the fix would be a corpus-wide
    /// readability regression rather than a targeted one.
    /// </summary>
    [Fact]
    public void NonCollidingDelegates_StillRenderInArrowForm()
    {
        string rendered = Render();

        Assert.Contains("Length(length (string) -> int32)", rendered, StringComparison.Ordinal);
        Assert.Contains("Sink(sink (string) -> void)", rendered, StringComparison.Ordinal);
        Assert.Contains("Test(test (string) -> bool)", rendered, StringComparison.Ordinal);
        Assert.Contains("Both(test (string) -> bool, length (string) -> int32)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Predicate[string]", rendered, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing proof. Binding alone would pass a fix that preserved the
    /// names but crossed the wires, so the translated program is compiled by
    /// the real gsc and RUN: each call must reach the overload C# would have
    /// reached.
    /// <para>
    /// Only the CLOSED shapes are exercised at run time. gsc cannot yet
    /// DISPATCH the generic shape — <c>Add(Predicate[T])</c> vs
    /// <c>Add(Func[T, bool])</c> on a substituted receiver reports
    /// <c>GS0266</c> — which is a separate, already-filed gsc defect (#3874)
    /// in applicability after generic substitution, not in the declaration
    /// model. The generic shapes are still COMPILED here (the classes are
    /// declared in the same program), which is what #3841 asked for.
    /// </para>
    /// </summary>
    [Fact]
    public void TranslatedProgram_DispatchesEachDelegateOverloadLikeCSharp()
    {
        string printed = Render();
        (int exitCode, string stdout) = CompileAndRun(printed);

        Assert.Equal(0, exitCode);
        string[] lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .ToArray();
        Assert.True(
            lines.SequenceEqual(new[] { "pred", "func", "pred", "func" }),
            "wrong overload reached: [" + string.Join(", ", lines) + "]\n\nTranslated G#:\n" + printed);
    }

    private static string Render() => GSharpPrinter.Print(Translate(Source));

    private static CompilationUnit Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Overloads.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return new CSharpToGSharpTranslator().TranslateDocument(document, context);
    }

    private static (int ExitCode, string Stdout) CompileAndRun(string printed)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-3841-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Program.gs");
            File.WriteAllText(gsPath, printed);

            string dllPath = Path.Combine(workDir, "Program.dll");
            (int compileExit, string compileOut) = RunDotnet(
                $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated program with zero errors. Output:\n" + compileOut
                    + "\n\nTranslated G#:\n" + printed);

            return RunDotnet($"\"{dllPath}\"");
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static (int ExitCode, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using Process process = Process.Start(psi)
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

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup; a locked file must not fail the test.
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }
}
