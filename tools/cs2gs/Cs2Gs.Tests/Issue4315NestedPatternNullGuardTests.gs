// <copyright file="Issue4315NestedPatternNullGuardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Threading.Tasks
import Xunit

/// Issue #4315: a nested recursive pattern (`{ Address: { City: "Lima" } }`,
/// `{ Address: { } }`, `{ Start: (0, 0) }`, `is not`, switch arms) must test the
/// nested member for null exactly as C# does. The translator used to drop the
/// `member != nil` guard when the member's declared type was a non-nullable
/// reference, on the stale premise that gsc rejects `!= nil` there (GS0129).
/// It does not, and the drop was unsound: a declared-non-null member is null at
/// run time when never assigned (or `null!`-initialized), so the translated
/// program threw NullReferenceException (or matched `{ }`) where C# yields
/// false. Each test translates the C# below, compiles it with gsc (exit 0),
/// runs it, and pins the output captured from the C# original.
class Issue4315NestedPatternNullGuardTests {
    @Fact
    func NestedMember_NullableEnabled_NullBangInitialized_MatchesCSharp() {
        let printed = Translate(`#nullable enable
using System;
namespace Sample;
public class Addr { public string City = null!; public int Zip; }
public class Person { public string Name = "n"; public Addr Address = null!; }
public class Pt { public int X; public int Y; public Pt(int x, int y) { X = x; Y = y; } public void Deconstruct(out int x, out int y) { x = X; y = Y; } }
public class Line { public Pt Start = null!; public Pt End = null!; }
public class Box { public Line L = null!; }
public class Rec { public string? Tag; public Addr Addr { get; set; } = null!; }
public static class C {
    static string Sw(Person p) => p switch {
        { Address: { City: "Lima" } } => "lima",
        { Address: { } } => "some",
        _ => "other",
    };
    public static void Run() {
        var p = new Person();
        Console.WriteLine(p is { Address: { City: "Lima" } });
        Console.WriteLine(p is { Address: { } });
        Console.WriteLine(p is { Address: var a });
        Console.WriteLine(p is not { Address: { City: "Lima" } });
        Console.WriteLine(p is { Address: not { City: "Lima" } });
        Console.WriteLine(Sw(p));
        p.Address = new Addr { City = "Lima" };
        Console.WriteLine(p is { Address: { City: "Lima" } });
        Console.WriteLine(p is { Address: { } });
        Console.WriteLine(Sw(p));
        var l = new Line();
        Console.WriteLine(l is { Start: (0, 0) });
        Console.WriteLine(l is { Start: { X: 0 } });
        Console.WriteLine(l is { Start: { X: 0 }, End: { Y: 1 } });
        var b = new Box { L = new Line() };
        Console.WriteLine(b is { L: { Start: { X: 0 } } });
        Console.WriteLine(b is { L: { Start: { } } });
        Console.WriteLine(b is { L: { } });
        l.Start = new Pt(0, 0);
        Console.WriteLine(l is { Start: (0, 0) });
        Console.WriteLine(b is { L: { Start: { X: 0 } } });
        var r = new Rec();
        Console.WriteLine(r is { Addr: { Zip: 0 } });
        Console.WriteLine(r is { Tag: { Length: 1 } });
        Console.WriteLine(r is { Addr: null });
    }
}
`)
        AssertGuarded(printed)
        Assert.Equal(Expected(), Normalize(CompileAndRun(printed, "C.Run()")))
    }

    @Fact
    func NestedMember_NullableDisabled_Unassigned_MatchesCSharp() {
        let printed = Translate(`#nullable disable
using System;
namespace Sample;
public class Addr { public string City; public int Zip; }
public class Person { public string Name = "n"; public Addr Address; }
public class Pt { public int X; public int Y; public Pt(int x, int y) { X = x; Y = y; } public void Deconstruct(out int x, out int y) { x = X; y = Y; } }
public class Line { public Pt Start; public Pt End; }
public class Box { public Line L; }
public class Rec { public string Tag; public Addr Addr { get; set; } }
public static class C {
    static string Sw(Person p) => p switch {
        { Address: { City: "Lima" } } => "lima",
        { Address: { } } => "some",
        _ => "other",
    };
    public static void Run() {
        var p = new Person();
        Console.WriteLine(p is { Address: { City: "Lima" } });
        Console.WriteLine(p is { Address: { } });
        Console.WriteLine(p is { Address: var a });
        Console.WriteLine(p is not { Address: { City: "Lima" } });
        Console.WriteLine(p is { Address: not { City: "Lima" } });
        Console.WriteLine(Sw(p));
        p.Address = new Addr { City = "Lima" };
        Console.WriteLine(p is { Address: { City: "Lima" } });
        Console.WriteLine(p is { Address: { } });
        Console.WriteLine(Sw(p));
        var l = new Line();
        Console.WriteLine(l is { Start: (0, 0) });
        Console.WriteLine(l is { Start: { X: 0 } });
        Console.WriteLine(l is { Start: { X: 0 }, End: { Y: 1 } });
        var b = new Box { L = new Line() };
        Console.WriteLine(b is { L: { Start: { X: 0 } } });
        Console.WriteLine(b is { L: { Start: { } } });
        Console.WriteLine(b is { L: { } });
        l.Start = new Pt(0, 0);
        Console.WriteLine(l is { Start: (0, 0) });
        Console.WriteLine(b is { L: { Start: { X: 0 } } });
        var r = new Rec();
        Console.WriteLine(r is { Addr: { Zip: 0 } });
        Console.WriteLine(r is { Tag: { Length: 1 } });
        Console.WriteLine(r is { Addr: null });
    }
}
`)
        AssertGuarded(printed)
        Assert.Equal(Expected(), Normalize(CompileAndRun(printed, "C.Run()")))
    }

    @Fact
    func NestedMember_NonNullableReference_KeepsGuard() {
        let printed = Translate(`#nullable enable
namespace Sample;
public class Addr { public int Zip; }
public class Person { public Addr Address = null!; }
public static class C
{
    public static bool Is(Person p) => p is { Address: { Zip: 0 } };
    public static bool Any(Person p) => p is { Address: { } };
}`)
        Assert.Contains("p.Address != nil", printed, StringComparison.Ordinal)
    }

    private func Expected() string {
        return "False,False,True,True,True,other,True,True,lima,False,False,False,False,False,True,True,False,False,False,True"
    }

    private func AssertGuarded(printed string) {
        Assert.Contains("p.Address != nil", printed, StringComparison.Ordinal)
        Assert.Contains("l.Start != nil", printed, StringComparison.Ordinal)
    }

    private func Normalize(output string) string {
        return string.Join(
            ",",
            output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        )
    }

    shared {
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4315-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Snippet.gs")
                let dllPath = Path.Combine(workDir, "Snippet.dll")
                File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
                let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
                Assert.True(
                    compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated snippet. Output:\n" + compileOut + `

Translated G#:
` + printed
                )
                let (runExit, stdout) = RunDotnet("\"$dllPath\"")
                Assert.True(runExit == 0, "Translated snippet must run. Output:\n" + stdout + `

Translated G#:
` + printed)
                return stdout
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch (IOException) {
                    // Best-effort cleanup: a process still releasing the output must not fail the test.

                } catch (UnauthorizedAccessException) {
                    // Same as above.

                }
            }
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            // Process.Start(ProcessStartInfo) returns null only when UseShellExecute
            // reuses an existing process; psi sets UseShellExecute = false above, so
            // a process is always started (or Start throws).
            using let process = Process.Start(psi)!!
            // Drain stdout and stderr concurrently: reading one to EOF first can
            // deadlock once the child fills the other stream's pipe buffer.
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            Task.WaitAll(stdout, stderr)
            process.WaitForExit()
            return (process.ExitCode, stdout.Result + stderr.Result)
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(translated)
            let roundTrip = TranslationTestValidation.AssertBinds(printed)!!
            Assert.True(
                roundTrip.Success,
                "Translated G# must round-trip:\n" + string.Join(Environment.NewLine, roundTrip.Errors) + `

` + printed
            )
            return printed
        }
    }
}
