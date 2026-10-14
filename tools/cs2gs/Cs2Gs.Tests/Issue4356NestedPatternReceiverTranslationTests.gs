// <copyright file="Issue4356NestedPatternReceiverTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Threading.Tasks
import Xunit

/// Issue #4356: a property subpattern that tests members of a nullable member
/// (`{ DeclaringType: { IsInterface: true } }`, or the extended
/// `{ DeclaringType.IsInterface: true }`) used to be guard-lowered to
/// `c.DeclaringType != nil && c.DeclaringType.IsInterface`. That
/// read the member twice, unlike C#, and gsc does not narrow the second read
/// (only a chain of stable links narrows), so it bound only because gsc's
/// member lookup let any chained imported read through regardless of its
/// stated nullability. Found by the hot-core self-migration guard on
/// `src/Core/CodeAnalysis/Binding/MemberLookup.cs`. Such patterns now take
/// G#'s native property pattern, which reads each member once.
class Issue4356NestedPatternReceiverTranslationTests {
    @Fact
    func NestedSubpatternOverImportedNullableMember_TakesTheNativePattern() {
        // `MethodInfo.DeclaringType` is an imported, annotated `Type?`. The
        // guard-lowered form (`c.DeclaringType != nil && c.DeclaringType.IsInterface`)
        // read it twice and bound only through gsc's old member-lookup
        // carve-out; G#'s native pattern reads it once, like C#, and binds
        // without it.
        let printed = Translate(`#nullable enable
using System.Reflection;

namespace Sample;

public static class Probe
{
    public static bool IsWidening(MethodInfo candidate)
        => candidate is { IsAbstract: true, DeclaringType: { IsInterface: true, IsGenericType: false } };
}`)
        Assert.Contains(
            "candidate is { IsAbstract: true, DeclaringType: { IsInterface: true, IsGenericType: false } }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("candidate.DeclaringType", printed, StringComparison.Ordinal)
    }

    @Fact
    func ExtendedPropertySubpatternOverImportedNullableMember_TakesTheNativePattern() {
        // The flattened spelling of the case above lowers to the same nested
        // native field (#1891).
        let printed = Translate(`#nullable enable
using System.Reflection;

namespace Sample;

public static class Probe
{
    public static bool IsWidening(MethodInfo candidate)
        => candidate is { IsAbstract: true, DeclaringType.IsInterface: true };
}`)
        Assert.Contains(
            "candidate is { IsAbstract: true, DeclaringType: { IsInterface: true } }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("candidate.DeclaringType", printed, StringComparison.Ordinal)
    }

    @Fact
    func LocalSubject_IsNarrowedByTheGuard_AndNotAsserted() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public static class Probe
{
    public static bool IsInterface(Type? type) => type is { IsInterface: true };
}`)
        Assert.Contains("type != nil && type.IsInterface", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("type!!", printed, StringComparison.Ordinal)
    }

    /// C# reads a property subpattern's member ONCE and tests every nested
    /// subpattern against that one value. A getter that returns non-nil and
    /// then nil pins it: lowering to `o.P != nil && o.P!!.X == 0`
    /// read `P` twice and threw on the second read. Every shape that
    /// reads a nested member more than once must read it exactly once and
    /// match, as C# does — whether it takes G#'s native property pattern or
    /// the boolean lowering (a positional or negated nested pattern, a
    /// reassigned nested binder), plus a nil member under both forms.
    @Fact
    func NestedMemberSubpatterns_ReadTheMemberOnce() {
        let printed = Translate(`#nullable enable
using System;
namespace Sample;

public sealed class Inner
{
    public int X;
    public int Y;

    public void Deconstruct(out int x, out int y)
    {
        x = X;
        y = Y;
    }
}

public sealed class Outer
{
    public int Reads;

    public Inner? P
    {
        get
        {
            Reads++;
            return Reads == 1 ? new Inner() : null;
        }
    }
}

public sealed class NilOuter
{
    public Inner? P => null;
}

public static class C
{
    public static void Run()
    {
        bool nilNegated = new NilOuter() is { P: not { X: 1 } };
        bool nilNested = new NilOuter() is { P: { X: 0 } };
        var a = new Outer();
        bool nested = a is { P: { X: 0 } };
        var b = new Outer();
        bool extended = b is { P.X: 0 };
        var c = new Outer();
        bool positional = c is { P: (0, 0) };
        var d = new Outer();
        bool negated = d is { P: not { X: 1 } };
        var g = new Outer();
        bool bound = false;
        if (g is { P: { X: 0 } p })
        {
            bound = true;
            p = new Inner();
        }

        Console.WriteLine(
            nested + "," + a.Reads + ";" + extended + "," + b.Reads + ";" +
            positional + "," + c.Reads + ";" + negated + "," + d.Reads + ";" +
            bound + "," + g.Reads + ";" + nilNegated + "," + nilNested);
    }
}`)
        Assert.Equal("True,1;True,1;True,1;True,1;True,1;True,False", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// A typed switch arm lowers its property subpatterns through a separate
    /// path (`case r is Rec when …`). An extended subpattern there used
    /// to print a flat `r.Clause.Items.Count` chain: it threw on a nil
    /// `Clause` where C# falls through, and over an imported annotated
    /// member it bound only through gsc's old member-lookup carve-out. Found
    /// by the hot-core self-migration guard on this translator's own
    /// `PatternTestsMembersOfNullableMember`.
    @Fact
    func TypedSwitchArm_ExtendedSubpatternOverNullableLink_IsGuarded() {
        let printed = Translate((`#nullable enable
using System;
using System.Collections.Generic;

namespace Sample;

public sealed class Clause
{
    public List<int> Items = new List<int> { 1 };
}

public abstract class Node
{
}

public sealed class Rec : Node
{
    public Clause? Clause;
    public object? Other;
}

public static class C
{
    public static bool F(Node n) => n switch
    {
        Rec { Other: null, Clause.Items.Count: > 0 } => true,
        _ => false,
    };

    // A discard leaf adds no test, but C# still requires ` + "`" + `Clause` + "`" + `
    // to be non-nil for the arm to match.
    public static bool G(Node n) => n switch
    {
        Rec { Clause.Items: _ } => true,
        _ => false,
    };

    // A reassigned ` + "`" + `var` + "`" + ` leaf: same guard, and the binder is a
    // mutable capture of the value read once.
    public static int H(Node n)
    {
        switch (n)
        {
            case Rec { Clause.Items: var items }:
                object matched = items;
                items = new List<int>();
                return matched != null && items != null ? 10 : 0;
            default:
                return -1;
        }
    }

    public static void Run()
    {
        Console.WriteLine(
            F(new Rec()) + "," + F(new Rec { Clause = new Clause() }) + ";" +
            G(new Rec()) + "," + G(new Rec { Clause = new Clause() }) + ";" +
            H(new Rec()) + "," + H(new Rec { Clause = new Clause() }));
    }
}`))
        Assert.Equal("False,True;False,True;-1,10", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// A typed switch arm whose nested subpattern declares a designation the
    /// arm body REASSIGNS (`case Rec { P: { X: 0 } p }: p = …`). A
    /// reassigned binder needs a mutable capture of its matched value; the
    /// nested-subpattern path used to record it as an ordinary binding, and
    /// since a direct write does not go through the binding replacement, the
    /// emitted assignment named an undeclared `p`.
    @Fact
    func TypedSwitchArm_ReassignedNestedDesignation_IsMutableCapture() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public sealed class Inner
{
    public int X;
}

public abstract class Node
{
}

public sealed class Rec : Node
{
    public Inner? P;
}

public static class C
{
    public static int F(Node n)
    {
        switch (n)
        {
            case Rec { P: { X: 0 } p }:
                object matched = p;
                p = new Inner { X = 5 };
                return matched != null ? p.X : 0;
            default:
                return -1;
        }
    }

    // The switch-EXPRESSION arm form of the same shape.
    public static int G(Node n) => n switch
    {
        Rec { P: { X: 0 } p } => (p = new Inner { X = 7 }).X,
        _ => -1,
    };

    public static void Run()
    {
        Console.WriteLine(
            F(new Rec()) + "," + F(new Rec { P = new Inner() }) + ";" +
            G(new Rec()) + "," + G(new Rec { P = new Inner() }));
    }
}`)
        Assert.Equal("-1,5;-1,7", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// A `Nullable<T>` VALUE intermediate (`P` is `Point?`)
    /// is nullable too: C# does not match `{ P.X: 0 }`, `{ P.X: _ }` or
    /// `{ P.X: var x }` when `P` has no value. The extended path used
    /// to treat it as non-nullable and dereference it unguarded, and the typed
    /// arm's discard form dropped the subpattern and matched a nil `P`.
    /// Run in both the `is`-expression and the typed-switch-arm lowering.
    @Fact
    func NullableValueIntermediate_IsGuarded_InEveryLeafForm() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public struct Point
{
    public int X;
}

public abstract class Node
{
}

public sealed class Rec : Node
{
    public Point? P;
}

public static class C
{
    public static bool IsTest(Rec r) => r is { P.X: 0 };

    public static bool IsDiscard(Rec r) => r is { P.X: _ };

    public static int IsVar(Rec r)
    {
        if (r is { P.X: var x })
        {
            x = x + 1;
            return x;
        }

        return -1;
    }

    public static string Arm(Node n) => n switch
    {
        Rec { P.X: 0 } => "test",
        _ => "other",
    };

    public static string ArmDiscard(Node n) => n switch
    {
        Rec { P.X: _ } => "discard",
        _ => "other",
    };

    public static int ArmVar(Node n)
    {
        switch (n)
        {
            case Rec { P.X: var x }:
                x = x + 2;
                return x;
            default:
                return -1;
        }
    }

    public static void Run()
    {
        var nil = new Rec();
        var zero = new Rec { P = new Point() };
        Console.WriteLine(
            IsTest(nil) + "," + IsTest(zero) + ";" +
            IsDiscard(nil) + "," + IsDiscard(zero) + ";" +
            IsVar(nil) + "," + IsVar(zero) + ";" +
            Arm(nil) + "," + Arm(zero) + ";" +
            ArmDiscard(nil) + "," + ArmDiscard(zero) + ";" +
            ArmVar(nil) + "," + ArmVar(zero));
    }
}`)
        Assert.Equal(
            "False,True;False,True;-1,1;other,test;other,discard;-1,2",
            CompileAndRun(printed, "C.Run()").Trim()
        )
    }

    /// A nullable nested member tested with a LIST pattern
    /// (`{ P: [1] }`, `P` an `int[]?`): C# does not match a nil
    /// `P`. The member is read once into a local, which the list lowering
    /// now guards before its `.Length` and index reads.
    @Fact
    func NullableNestedMember_ListPattern_IsGuarded() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public sealed class Holder
{
    public int[]? P;
}

public static class C
{
    public static bool F(Holder o) => o is { P: [1] };

    public static bool G(Holder o) => o is { P: [1, ..] };

    public static void Run()
    {
        var nil = new Holder();
        var one = new Holder { P = new[] { 1 } };
        var two = new Holder { P = new[] { 1, 2 } };
        Console.WriteLine(
            F(nil) + "," + F(one) + "," + F(two) + ";" +
            G(nil) + "," + G(one) + "," + G(two));
    }
}`)
        Assert.Equal("False,True,False;False,True,True", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// A reassigned binder forces the fallback lowering, which stores the
    /// nullable member in a `var` capture and materializes the binder AFTER the
    /// test — outside the `!= nil` guard that narrowed the capture. Every read
    /// under that guard (member tests and descendant bindings alike) must go
    /// through a non-null read. Property, list and nested-property forms, each
    /// against a nil and a present member, compiled with gsc and run.
    @Fact
    func ReassignedDescendantBinder_UnderNullableCapture_ReadsNonNull() {
        let printed = Translate(`#nullable enable
using System;

namespace Sample;

public sealed class Inner
{
    public int X;
    public Inner? Q;
}

public sealed class Holder
{
    public Inner? P;
    public int[]? A;
}

public static class C
{
    public static int Property(Holder h)
    {
        if (h is { P: { X: var x } })
        {
            x = x + 1;
            return x;
        }

        return -1;
    }

    public static int List(Holder h)
    {
        if (h is { A: [var x] })
        {
            x = x + 2;
            return x;
        }

        return -1;
    }

    public static int Nested(Holder h)
    {
        if (h is { P: { Q: { X: var x } } })
        {
            x = x + 3;
            return x;
        }

        return -1;
    }

    public static void Run()
    {
        var empty = new Holder();
        var full = new Holder
        {
            P = new Inner { X = 10, Q = new Inner { X = 20 } },
            A = new[] { 30 },
        };
        var partial = new Holder { P = new Inner { X = 10 } };
        Console.WriteLine(
            Property(empty) + "," + Property(full) + ";" +
            List(empty) + "," + List(full) + ";" +
            Nested(empty) + "," + Nested(partial) + "," + Nested(full));
    }
}`)
        Assert.Equal("-1,11;-1,32;-1,-1,23", CompileAndRun(printed, "C.Run()").Trim())
    }

    /// A NULLABLE positional slot (`Deconstruct(out Inner? p)` matched to a
    /// nullable `P`) tested with a nested pattern: C# calls Deconstruct once
    /// and tests that one value. The lowering reads the matching property, so it
    /// must read it once and guard it — in the `is`-expression and in a
    /// typed switch arm — against a getter that counts reads.
    @Fact
    func NullablePositionalSlot_IsGuardedAndReadOnce() {
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

    public void Deconstruct(out Inner? P) => P = this.P;
}

public static class C
{
    public static string Arm(Node n) => n switch
    {
        Outer({ X: 0 }) => "zero",
        _ => "other",
    };

    public static void Run()
    {
        var a = new Outer(new Inner());
        bool isZero = a is Outer({ X: 0 });
        var b = new Outer(null);
        bool isNil = b is Outer({ X: 0 });
        var c = new Outer(new Inner());
        string arm = Arm(c);
        Console.WriteLine(
            isZero + "," + a.Reads + ";" + isNil + "," + b.Reads + ";" + arm + "," + c.Reads);
    }
}`)
        Assert.Equal("True,1;False,1;zero,1", CompileAndRun(printed, "C.Run()").Trim())
    }

    shared {
        private func CompileAndRun(printed string, callExpression string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-4356-e2e", Guid.NewGuid().ToString("N"))
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
