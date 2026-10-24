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

    /// Copilot finding on 9611e4f: a non-nullable getter is now read by the
    /// null guard and by each member test, so it must be bound once, as C#
    /// reads it once. Also a bare array member must not take the dead
    /// `!= nil` guard (GS0523, an error under warnings-as-errors).
    @Fact
    func NestedMember_NonNullableGetterIsReadOnce_AndBareArrayTakesNoDeadGuard() {
        let printed = Translate(`#nullable enable
using System;
namespace Sample;
public class Inner { public int X; }
public class Outer { public int Reads; public Inner P { get { Reads++; return new Inner { X = Reads }; } } }
public class H { public int[] Items = new[] { 1 }; public int[] Empty = new int[0]; }
public static class C
{
    public static void Run()
    {
        var o = new Outer();
        bool a = o is { P: { X: 1 } };
        Console.WriteLine(a + "," + o.Reads);
        var o2 = new Outer();
        bool b = o2 is { P: { X: 1 } or { X: 2 } };
        Console.WriteLine(b + "," + o2.Reads);
        var h = new H();
        Console.WriteLine((h is { Items: { Length: > 0 } }) + "," + (h is { Empty: { Length: > 0 } }) + "," + (h is { Items: { } }));
    }
}`)
        Assert.DoesNotContain("h.Items != nil", printed, StringComparison.Ordinal)
        Assert.Equal("True,1,True,1,True,False,True", Normalize(CompileAndRun(printed, "C.Run()")))
    }

    /// Round 2 of the Copilot review: the guard's two receiver questions (is it a
    /// bare slice that needs no guard, is it safe to read twice) are decided from
    /// the receiver's TYPE and its whole emitted chain, so list elements,
    /// materialized slices and extended-path leaves behave like plain members. The
    /// `null!` array is the boundary: promoted to `T?`, it keeps its guard and
    /// yields false, not a NullReferenceException.
    @Fact
    func NestedMember_ReceiverClassificationFollowsTypeAndChain() {
        let printed = Translate(`#nullable enable
using System;
namespace Sample;
public class Child { public int X; }
public class Holder { public Child Child = new Child(); }
public class Outer { public int Reads; public Holder P { get { Reads++; return new Holder { Child = new Child { X = Reads } }; } } }
public class H { public int[][] Items = new[] { new[] { 1 } }; public int[] Flat = new[] { 1, 2 }; public int[] Arr = null!; }
public static class C
{
    public static void Run()
    {
        var o = new Outer();
        Console.WriteLine((o is { P.Child: { X: 1 } }) + "," + o.Reads);
        var o3 = new Outer();
        Console.WriteLine((o3 is { P: { Child: { X: 1 } } }) + "," + o3.Reads);
        var h = new H();
        Console.WriteLine(h is { Items: [{ Length: > 0 }] });
        Console.WriteLine(h is { Flat: [.. { Length: > 0 }] });
        Console.WriteLine(h is { Flat: { Length: 2 } });
        Console.WriteLine(h is { Arr: { Length: 2 } });
        Console.WriteLine(h is { Arr: { } });
    }
}`)
        // A range slice is never nil, so it takes no guard in either spelling.
        Assert.DoesNotContain("[..]", printed.Replace("h.Flat[..].Length", ""), StringComparison.Ordinal)
        Assert.Equal("True,1,True,1,True,True,True,False,False", Normalize(CompileAndRun(printed, "C.Run()")))
    }

    /// Round 3 of the Copilot review: one rule (NullGuardIsProvablyRedundant)
    /// decides when the guard may be omitted. Each branch has a boundary here:
    /// a promoted/top-level `null!` array local and a default-initialized jagged
    /// array element keep their guard (false, not true and not a
    /// NullReferenceException), while the `params` array, the value-type tuple
    /// slot, the range slice and the declared bare-slice member omit it.
    @Fact
    func NullGuardRule_BoundaryPerBranch_NullableEnabled() {
        let printed = Translate(`#nullable enable
using System;
namespace Sample;
public class H { public (int, int) T = (0, 0); public int[] Flat = new[] { 1, 2 }; }
public static class C
{
    public static bool Q(params int[] a) => a is { Length: > 0 };
    public static void Run()
    {
        int[] n = null!;
        Console.WriteLine(n is { });
        Console.WriteLine(n is { Length: > 0 });
        var j = new int[1][];
        Console.WriteLine(j is [{ }]);
        Console.WriteLine(j is [{ Length: > 0 }]);
        var j2 = new[] { new[] { 1 } };
        Console.WriteLine(j2 is [{ Length: > 0 }]);
        var h = new H();
        Console.WriteLine(h is { T: (0, 0) });
        Console.WriteLine(h is { Flat: [.. { Length: > 0 }] });
        Console.WriteLine(h is { Flat: { Length: 2 } });
        Console.WriteLine(Q(1, 2));
        Console.WriteLine(Q());
    }
}`)
        Assert.Equal(BoundaryExpected(), Normalize(CompileAndRun(printed, "C.Run()")))
    }

    @Fact
    func NullGuardRule_BoundaryPerBranch_NullableDisabled() {
        let printed = Translate(`#nullable disable
using System;
namespace Sample;
public class H { public (int, int) T = (0, 0); public int[] Flat = new[] { 1, 2 }; }
public static class C
{
    public static bool Q(params int[] a) => a is { Length: > 0 };
    public static void Run()
    {
        int[] n = null;
        Console.WriteLine(n is { });
        Console.WriteLine(n is { Length: > 0 });
        var j = new int[1][];
        Console.WriteLine(j is [{ }]);
        Console.WriteLine(j is [{ Length: > 0 }]);
        var j2 = new[] { new[] { 1 } };
        Console.WriteLine(j2 is [{ Length: > 0 }]);
        var h = new H();
        Console.WriteLine(h is { T: (0, 0) });
        Console.WriteLine(h is { Flat: [.. { Length: > 0 }] });
        Console.WriteLine(h is { Flat: { Length: 2 } });
        Console.WriteLine(Q(1, 2));
        Console.WriteLine(Q());
    }
}`)
        Assert.Equal(BoundaryExpected(), Normalize(CompileAndRun(printed, "C.Run()")))
    }

    private func BoundaryExpected() string {
        return "False,False,False,False,True,True,True,True,True,False"
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
                // GS0523 is the dead-nil-check warning a guard on a bare slice raises.
                Assert.False(compileOut.Contains("GS0523", StringComparison.Ordinal), compileOut + printed)
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
