// <copyright file="Issue4400ImplicitInArgumentTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4400: C# callers normally omit `in` at the call site. gsc now
/// matches C# for such an argument — the address of an lvalue, or of a spilled
/// temp for an rvalue — so the translation of an omitted-`in` call must
/// compile, pass ilverify and print C#'s output. Before the fix an rvalue
/// argument to a source-declared `in` parameter was translated to
/// `&(x + 1)` (GS9001, not an lvalue), and a member call that gsc
/// accepted without a modifier pushed the value where the callee expected an
/// address (ilverify `StackUnexpected`).
@Collection("IlVerifyPipeline")
open class Issue4400ImplicitInArgumentTranslationTests {
    /// Every call omits `in` in C#; the translated program must compile,
    /// verify and print what the C# program prints.
    @Fact
    func OmittedInArguments_CompileVerifyAndRunLikeCSharp() {
        let printed = Translate(Source)
        // An rvalue is never translated to the non-lvalue `&(...)` form.
        Assert.DoesNotContain("&(x + 1)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("&x + 1", printed, StringComparison.Ordinal)
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4400ImplicitInArgumentTranslationTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(workDir)
        try {
            let (dllPath, stdout, exit) = CompileAndRun(workDir, printed)
            Assert.True(exit == 0, "Translated program must run. Output:\n" + stdout + `

Translated G#:
` + printed)
            Assert.Equal(
                []string{"6", "8", "4", "7", "14", "8", "12", "22", "8", "3"},
                stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select((l string) -> l.Trim()).ToArray()
            )
            let result = IlVerifyRunner().Verify(dllPath)
            Assert.True(
                result.Errors.Count == 0,
                "ilverify reported findings:\n" + string.Join(
                    Environment.NewLine,
                    result.Errors.Select((e IlVerifyError) -> e.RawLine)
                )
            )
        } finally {
            Directory.Delete(workDir, recursive: true)
        }
    }

    shared {
        private const Source string = `#nullable enable
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

    public static int Len(in string? s) => s?.Length ?? -1;

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
        string t = "abc";
        Console.WriteLine(Len(t));
    }
}`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Repro.cs", source)},
                references: nil,
                outputKind: OutputKind.ConsoleApplication
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        private func CompileAndRun(workDir string, printed string)(DllPath string, Stdout string, Exit int32) {
            let compiler string? = LocalFunctionHoistTranslationTests.FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let gsPath = Path.Combine(workDir, "Program.gs")
            File.WriteAllText(gsPath, printed)
            let dllPath = Path.Combine(workDir, "Program.dll")
            let (compileExit, compileOut) = RunDotnet(
                "\"$compiler\" /target:exe /targetframework:net10.0 /out:\"$dllPath\" \"$gsPath\""
            )
            Assert.True(compileExit == 0, "gsc must compile the translated program. Output:\n" + compileOut + `

Translated G#:
` + printed)
            File.WriteAllText(Path.Combine(workDir, "Program.runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
` + "    \"framework\": { \"name\": \"Microsoft.NETCore.App\", \"version\": \"" + Environment.Version.Major.ToString() + `.0.0" }
  }
}
`)
            let (exit, output) = RunDotnet("\"$dllPath\"")
            return (dllPath, output, exit)
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }
    }
}
