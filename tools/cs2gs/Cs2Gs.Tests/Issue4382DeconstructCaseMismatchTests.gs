// <copyright file="Issue4382DeconstructCaseMismatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

/// Issue #4382: a positional subpattern whose `Deconstruct` out-parameter
/// differs in case from the member it reads (`out Inner? p` for property
/// `P`) lowered to a bare type test (`o is Outer`). The only signal
/// was an unsupported diagnostic, which a test that never inspects diagnostics
/// does not see. The out-parameter now maps to its member the way the C#
/// convention does (`out T x` to `X`): case-insensitively, when
/// exactly one property or field matches and its type is the parameter's.
/// Anything else is still reported loudly, with the reason.
class Issue4382DeconstructCaseMismatchTests {
    /// The issue's repro: a nullable slot read through `out Inner? p`.
    /// The lowering must keep the nil guard and read `P` once, in an
    /// `is` pattern, a switch expression arm and a switch statement arm.
    @Fact
    func CaseMismatchedNullableSlot_IsGuardedAndReadOnce() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public sealed class Inner
{
    public int X;
}

public class Node
{
}

public sealed class Outer : Node
{
    public int Reads;
    private readonly Inner? stored;

    public Outer(Inner? stored) => this.stored = stored;

    public Inner? P
    {
        get
        {
            Reads++;
            return Reads == 1 ? stored : null;
        }
    }

    public void Deconstruct(out Inner? p) => p = P;
}

public static class C
{
    public static bool Is(Node n) => n is Outer({ X: 0 });

    public static string Arm(Node n) => n switch
    {
        Outer({ X: 0 }) => "zero",
        _ => "other",
    };

    public static string Stmt(Node n)
    {
        switch (n)
        {
            case Outer({ X: 0 }):
                return "zero";
            default:
                return "other";
        }
    }

    public static string Check(Func<Node, string> f)
    {
        var zero = new Outer(new Inner());
        var one = new Outer(new Inner { X = 1 });
        var nil = new Outer(null);
        return f(zero) + "," + zero.Reads + " "
            + f(one) + "," + one.Reads + " "
            + f(nil) + "," + nil.Reads + " "
            + f(new Node());
    }

    public static void Run()
    {
        Console.WriteLine(
            Check(n => Is(n).ToString()) + ";" + Check(Arm) + ";" + Check(Stmt));
    }
}`)
        Assert.DoesNotContain(".p", printed, StringComparison.Ordinal)
        Assert.Contains("!= nil", printed, StringComparison.Ordinal)
        Assert.Equal(
            "True,1 False,1 False,1 False;zero,1 other,1 other,1 other;zero,1 other,1 other,1 other",
            CompileAndRun(printed, "C.Run()").Trim()
        )
    }

    /// A nested positional pattern where both levels map by case
    /// (`out Inner? value` to `Value`, `out int x` to
    /// `X`), binding through the nullable intermediate, in every
    /// pattern position.
    @Fact
    func NestedCaseMismatchedPositionalPattern_BindsThroughTheNullableSlot() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public class Node
{
}

public sealed class Inner
{
    public int X { get; set; }

    public int Y { get; set; }

    public void Deconstruct(out int x, out int y)
    {
        x = X;
        y = Y;
    }
}

public sealed class Outer : Node
{
    public Inner? Value { get; set; }

    public void Deconstruct(out Inner? value) => value = Value;
}

public static class C
{
    public static int Is(Node n)
    {
        if (n is Outer(Inner(var a, _)))
        {
            return a;
        }

        return -1;
    }

    public static int Arm(Node n) => n switch
    {
        Outer(Inner(var a, 5)) => a,
        Outer(Inner(_, var b)) => -b - 100,
        _ => -1,
    };

    public static int Stmt(Node n)
    {
        switch (n)
        {
            case Outer(Inner(var a, > 1)):
                return a * 10;
            default:
                return -1;
        }
    }

    public static string Check(Func<Node, int> f)
    {
        var first = new Outer { Value = new Inner { X = 3, Y = 5 } };
        var second = new Outer { Value = new Inner { X = 4, Y = 1 } };
        var nil = new Outer();
        return f(first) + " " + f(second) + " " + f(nil) + " " + f(new Node());
    }

    public static void Run()
    {
        Console.WriteLine(Check(Is) + ";" + Check(Arm) + ";" + Check(Stmt));
    }
}`)
        Assert.Equal("3 4 -1 -1;3 -101 -1 -1;30 -1 -1 -1", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// The mapping also reaches a field, an inherited property, an overridden
    /// property read through an inherited `Deconstruct`, and a
    /// `name:`-labelled subpattern (the label names the out-parameter,
    /// not the member, so it must not be emitted as a member access).
    @Fact
    func CaseMismatch_MapsToFieldsInheritedMembersAndLabelledSubpatterns() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public class Base
{
    public int Count { get; set; }
}

public sealed class Derived : Base
{
    public string Name = "";

    public void Deconstruct(out int count, out string name)
    {
        count = Count;
        name = Name;
    }
}

public class Shape
{
    public virtual int Sides => 0;

    public void Deconstruct(out int sides) => sides = Sides;
}

public sealed class Square : Shape
{
    public override int Sides => 4;
}

public static class C
{
    public static bool F(object o) => o is Derived(> 1, "a");

    public static bool S(Shape s) => s is Square(4);

    public static bool G(object o) => o is Derived(count: 2, name: _);

    public static void Run()
    {
        var hit = new Derived { Count = 2, Name = "a" };
        var low = new Derived { Count = 1, Name = "a" };
        var other = new Derived { Count = 3, Name = "b" };
        Console.WriteLine(
            F(hit) + " " + F(low) + " " + F(other) + " " + F("x") + ";"
            + G(hit) + " " + G(low) + " " + G(other) + " " + G("x") + ";"
            + S(new Square()) + " " + S(new Shape()));
    }
}`)
        Assert.DoesNotContain(".count", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(".name", printed, StringComparison.Ordinal)
        Assert.Equal(
            "True False False False;True False False False;True False",
            CompileAndRun(printed, "C.Run()").Trim()
        )
    }

    /// An interface's `Deconstruct` reached through a derived interface
    /// and through a type parameter constrained to it reads the declaring
    /// interface's slot (`out int p` to `IBase.P`).
    @Fact
    func CaseMismatch_ResolvesThroughDerivedInterfacesAndConstraints() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public interface IBase
{
    int P { get; }

    int R { get; }

    void Deconstruct(out int p, out int r);
}

public interface IDerived : IBase
{
    int Q { get; }
}

public sealed class Impl : IDerived
{
    public int P { get; set; }

    public int R { get; set; }

    public int Q => 0;

    public void Deconstruct(out int p, out int r)
    {
        p = P;
        r = R;
    }
}

public static class C
{
    public static bool Untyped(IDerived d) => d is (1, > 0);

    public static bool Typed(object o) => o is IDerived(1, _);

    public static bool Constrained<T>(T t)
        where T : class, IDerived => t is (1, > 0);

    public static void Run()
    {
        IDerived hit = new Impl { P = 1, R = 2 };
        IDerived miss = new Impl { P = 2, R = 2 };
        IDerived zero = new Impl { P = 1, R = 0 };
        Console.WriteLine(
            Untyped(hit) + " " + Untyped(miss) + " " + Untyped(zero) + ";"
            + Typed(hit) + " " + Typed(miss) + " " + Typed("x") + ";"
            + Constrained(hit) + " " + Constrained(miss) + " " + Constrained(zero));
    }
}`)
        Assert.Equal("True False False;True False False;True False False", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// Out-parameters that cannot be mapped faithfully stay loud, with the
    /// reason, on every lowering route: an ambiguous case-insensitive match,
    /// no matching member, a member of another type, a member a derived type
    /// or derived interface hides from an inherited `Deconstruct` (also
    /// through a constrained type parameter), an inaccessible member, a
    /// property whose getter is missing or inaccessible,
    /// and an extension `Deconstruct`.
    /// @param deconstruct The Deconstruct shape.
    /// @param usage A pattern use of `Target` over `object o`.
    /// @param reason The expected reason in the diagnostic.
    @Theory
    @InlineData(
        "ambiguous",
        "public static bool F(object o) => o is Target(1);",
        "matches several members case-insensitively"
    )
    @InlineData("missing", "public static bool F(object o) => o is Target(1);", "has no matching property or field")
    @InlineData("mismatch", "public static bool F(object o) => o is Target(1);", "is 'int' but member 'P' is 'long'")
    @InlineData(
        "exactMismatch",
        "public static bool F(object o) => o is Target(1);",
        "is 'int' but member 'P' is 'long'"
    )
    @InlineData("extension", "public static bool F(object o) => o is Target(1);", "is an extension Deconstruct")
    @InlineData(
        "hidden",
        "public static bool F(object o) => o is Target(1);",
        "reads 'TargetBase.P', which 'Target.P' hides"
    )
    @InlineData(
        "private",
        "public static bool F(object o) => o is Target(1);",
        "reads 'p', which is not accessible here"
    )
    @InlineData(
        "privateGetter",
        "public static bool F(object o) => o is Target(1);",
        "reads 'P', whose getter is not accessible here"
    )
    @InlineData(
        "setOnly",
        "public static bool F(object o) => o is Target(1);",
        "reads 'P', whose getter is not accessible here"
    )
    @InlineData(
        "protectedGetter",
        "public static bool F(object o) => o is Target(1);",
        "reads 'P', whose getter is not accessible here"
    )
    @InlineData(
        "protectedThroughBase",
        "public static bool F(object o) => Sub.G(o);",
        "reads 'P', whose getter is not accessible here"
    )
    @InlineData(
        "hiddenByMethod",
        "public static bool F(object o) => o is Target(1);",
        "reads 'TargetBase.P', which 'Target.P' hides"
    )
    @InlineData(
        "interfaceHidden",
        "public static bool F(object o) => o is IDerived(1);",
        "reads 'IBase.P', which 'IDerived.P' hides"
    )
    @InlineData(
        "interfaceHidden",
        "public static bool F(IDerived2 d) => d is (1, _);",
        "reads 'IBase.P', which 'IDerived.P' hides"
    )
    @InlineData(
        "interfaceHidden",
        "public static bool F<T>(T t) where T : class, IDerived => t is (1, _);",
        "reads 'IBase.P', which 'IDerived.P' hides"
    )
    @InlineData("missing", "public static bool F(object o) => o is not Target(1);", "has no matching property or field")
    @InlineData(
        "missing",
        "public static bool F(object o) => o is Target(1) or string;",
        "has no matching property or field"
    )
    @InlineData(
        "missing",
        "public static bool F(object o) => o is Box(Target(1));",
        "has no matching property or field"
    )
    @InlineData(
        "missing",
        "public static int F(object o) => o switch { Target(1) => 1, _ => 0 };",
        "has no matching property or field"
    )
    @InlineData(
        "missing",
        "public static int F(object o) { switch (o) { case Target(1): return 1; default: return 0; } }",
        "has no matching property or field"
    )
    @InlineData(
        "missing",
        "public static int F(object o) { if (o is Target(var v)) { return v; } return 0; }",
        "has no matching property or field"
    )
    @InlineData("missing", "public static bool F(object o) => o is Target(p: 1);", "has no matching property or field")
    func UnmappableOutParameter_IsReportedLoudly(deconstruct string, usage string, reason string) {
        let target = switch deconstruct {
            case "ambiguous": `public sealed class Target
{
    public int P { get; set; }
    public int p;
    public void Deconstruct(out int p) => p = this.p;
}`
            case "missing": `public sealed class Target
{
    public int Value { get; set; }
    public void Deconstruct(out int p) => p = Value;
}`
            case "mismatch": `public sealed class Target
{
    public long P { get; set; }
    public void Deconstruct(out int p) => p = (int)P;
}`
            case "exactMismatch": `public sealed class Target
{
    public long P { get; set; }
    public void Deconstruct(out int P) => P = unchecked((int)this.P);
}`
            case "hidden": `public class TargetBase
{
    public int P { get; set; }
    public void Deconstruct(out int p) => p = P;
}

public sealed class Target : TargetBase
{
    public new int P { get; set; }
}`
            case "private": `public sealed class Target
{
    private readonly int p;
    public Target(int value) => p = value;
    public void Deconstruct(out int P) => P = p;
}`
            case "privateGetter": `public sealed class Target
{
    public int P { private get; set; }
    public void Deconstruct(out int p) => p = P;
}`
            case "setOnly": `public sealed class Target
{
    private int stored;
    public int P { set => stored = value; }
    public void Deconstruct(out int p) => p = stored;
}`
            case "protectedGetter": `public class Target
{
    public int P { protected get; set; }
    public void Deconstruct(out int p) => p = P;
}`
            case "protectedThroughBase": (`public class Target
{
    public int P { protected get; set; }
    public void Deconstruct(out int p) => p = P;
}

public sealed class Sub : Target
{
    // Inside a derived class, but ` + "`" + `P` + "`" + `'s protected getter is
    // not readable through a ` + "`" + `Target` + "`" + `-typed receiver (CS1540).
    public static bool G(object o) => o is Target(1);
}`)
            case "interfaceHidden": `public interface IBase
{
    int P { get; }
    void Deconstruct(out int p);
    void Deconstruct(out int p, out int q);
}

public interface IDerived : IBase
{
    new int P { get; }
}

public interface IDerived2 : IDerived
{
}`
            case "hiddenByMethod": `public class TargetBase
{
    public int P { get; set; }
    public void Deconstruct(out int p) => p = P;
}

public sealed class Target : TargetBase
{
    public new int P() => 0;
}`
            default: `public sealed class Target
{
    public int P { get; set; }
}

public static class TargetExtensions
{
    public static void Deconstruct(this Target t, out int P) => P = t.P;
}`
        }
        let (printed, diagnostics) = TranslateWithDiagnostics(`#nullable enable
namespace Sample;

` + target + `
public sealed class Box
{
    public object? Item { get; set; }
    public void Deconstruct(out object? item) => item = Item;
}

public static class C
{` + "\n    " + usage + `
}
`)
        Assert.True(
            diagnostics.Any(
                (d TranslationDiagnostic) -> d.IsUnsupported && d.Message!!.Contains(
                    "positional subpattern has no canonical G# form",
                    StringComparison.Ordinal
                ) &&
                    d.Message!!.Contains(reason, StringComparison.Ordinal)
            ),
            "Expected a loud positional-subpattern diagnostic mentioning '" + reason + "'. Got:\n" + string.Join(
                Environment.NewLine,
                diagnostics.Select((d TranslationDiagnostic) -> d.Message)
            ) +
                `

` +
                printed
        )
    }

    shared {
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4382-e2e", Guid.NewGuid().ToString("N"))
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
            // UseShellExecute = false always starts a new process (or throws).
            using let process = Process.Start(psi)!!
            // Drain both streams concurrently so a full pipe cannot deadlock.
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

        private func TranslateWithDiagnostics(source string)(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (GSharpPrinter.Print(translated), context.Diagnostics)
        }

        // Unlike a helper that only checks the printed text, this fails on any
        // unsupported diagnostic: #4382's bare type test was reported only there.
        private func Translate(source string) string {
            let (printed, diagnostics) = TranslateWithDiagnostics(source)
            Assert.DoesNotContain(diagnostics, (diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
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
