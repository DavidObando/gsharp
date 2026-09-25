// <copyright file="Issue4400ImplicitInArgumentTranslationTests.cs" company="GSharp">
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
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4400: C# callers normally omit <c>in</c> at the call site. gsc now
/// matches C# for such an argument — the address of an lvalue, or of a spilled
/// temp for an rvalue — so the translation of an omitted-<c>in</c> call must
/// compile, pass ilverify and print C#'s output. Before the fix an rvalue
/// argument to a source-declared <c>in</c> parameter was translated to
/// <c>&amp;(x + 1)</c> (GS9001, not an lvalue), and a member call that gsc
/// accepted without a modifier pushed the value where the callee expected an
/// address (ilverify <c>StackUnexpected</c>).
/// </summary>
[Collection(IlVerifyPipelineCollection.Name)]
public class Issue4400ImplicitInArgumentTranslationTests
{
    private const string Source = """
        using System;

        namespace Repro;

        public struct Pair
        {
            public int A;
            public int B;

            public Pair(int a, int b)
            {
                A = a;
                B = b;
            }
        }

        public class Box
        {
            public int Value;

            public Box(in int seed)
            {
                Value = seed;
            }

            public const int K = 2;

            public int Prop { get; set; } = 5;

            public int Add(in int x) => Value + x;

            // Bare property / constant / field names: only the field is storage.
            public int ViaMembers() => Calc.Scale(Prop) + Calc.Scale(K) + Calc.Scale(Value);
        }

        public static class Calc
        {
            public static int Scale(in int factor) => factor * 2;

            public static long Widen(in long value) => value + 1;

            public static int Sum(in Pair p) => p.A + p.B;

            public static void Main()
            {
                int x = 3;
                var box = new Box(x + 1);
                Console.WriteLine(Scale(x));
                Console.WriteLine(Scale(x + 1));
                Console.WriteLine(Widen(x));
                Console.WriteLine(Sum(new Pair(2, 5)));
                Console.WriteLine(box.Add(10));
                Console.WriteLine(box.Add(box.Value));
                Func<int, int> f = v => Scale(v * 3);
                Console.WriteLine(f(2));
                Console.WriteLine(box.ViaMembers());
                const int c = 4;
                Console.WriteLine(Scale(c));
            }
        }
        """;

    /// <summary>
    /// Every call omits <c>in</c> in C#; the translated program must compile,
    /// verify and print what the C# program prints.
    /// </summary>
    [Fact]
    public void OmittedInArguments_CompileVerifyAndRunLikeCSharp()
    {
        string printed = Translate(Source);

        // An rvalue is never translated to the non-lvalue `&(...)` form.
        Assert.DoesNotContain("&(x + 1)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("&x + 1", printed, StringComparison.Ordinal);

        string workDir = Path.Combine(
            AppContext.BaseDirectory, nameof(Issue4400ImplicitInArgumentTranslationTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            (string dllPath, string stdout, int exit) = CompileAndRun(workDir, printed);
            Assert.True(exit == 0, "Translated program must run. Output:\n" + stdout + "\n\nTranslated G#:\n" + printed);
            Assert.Equal(
                new[] { "6", "8", "4", "7", "14", "8", "12", "22", "8" },
                stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).ToArray());

            IlVerifyResult result = new IlVerifyRunner().Verify(dllPath);
            Assert.True(
                result.Errors.Count == 0,
                "ilverify reported findings:\n" + string.Join(Environment.NewLine, result.Errors.Select(e => e.RawLine)));
        }
        finally
        {
            Directory.Delete(workDir, recursive: true);
        }
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Repro.cs", source) }, references: null, outputKind: OutputKind.ConsoleApplication);
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static (string DllPath, string Stdout, int Exit) CompileAndRun(string workDir, string printed)
    {
        string compiler = LocalFunctionHoistTranslationTests.FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string gsPath = Path.Combine(workDir, "Program.gs");
        File.WriteAllText(gsPath, printed);
        string dllPath = Path.Combine(workDir, "Program.dll");

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /targetframework:net10.0 /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0,
            "gsc must compile the translated program. Output:\n" + compileOut + "\n\nTranslated G#:\n" + printed);

        File.WriteAllText(
            Path.Combine(workDir, "Program.runtimeconfig.json"),
            "{\n  \"runtimeOptions\": {\n    \"tfm\": \"net10.0\",\n"
                + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \""
                + Environment.Version.Major + ".0.0\" }\n  }\n}\n");

        (int exit, string output) = RunDotnet($"\"{dllPath}\"");
        return (dllPath, output, exit);
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
}
