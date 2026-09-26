// <copyright file="Issue4382DeconstructCaseMismatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4382: a positional subpattern whose <c>Deconstruct</c> out-parameter
/// differs in case from the member it reads (<c>out Inner? p</c> for property
/// <c>P</c>) lowered to a bare type test (<c>o is Outer</c>). The only signal
/// was an unsupported diagnostic, which a test that never inspects diagnostics
/// does not see. The out-parameter now maps to its member the way the C#
/// convention does (<c>out T x</c> to <c>X</c>): case-insensitively, when
/// exactly one property or field matches and its type is the parameter's.
/// Anything else is still reported loudly, with the reason.
/// </summary>
public sealed class Issue4382DeconstructCaseMismatchTests
{
    /// <summary>
    /// The issue's repro: a nullable slot read through <c>out Inner? p</c>.
    /// The lowering must keep the nil guard and read <c>P</c> once, in an
    /// <c>is</c> pattern, a switch expression arm and a switch statement arm.
    /// </summary>
    [Fact]
    public void CaseMismatchedNullableSlot_IsGuardedAndReadOnce()
    {
        string printed = Translate("""
            #nullable enable
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
            }
            """);

        Assert.DoesNotContain(".p", printed, StringComparison.Ordinal);
        Assert.Contains("!= nil", printed, StringComparison.Ordinal);
        Assert.Equal(
            "True,1 False,1 False,1 False;zero,1 other,1 other,1 other;zero,1 other,1 other,1 other",
            CompileAndRun(printed, "C.Run()").Trim());
    }

    /// <summary>
    /// A nested positional pattern where both levels map by case
    /// (<c>out Inner? value</c> to <c>Value</c>, <c>out int x</c> to
    /// <c>X</c>), binding through the nullable intermediate, in every
    /// pattern position.
    /// </summary>
    [Fact]
    public void NestedCaseMismatchedPositionalPattern_BindsThroughTheNullableSlot()
    {
        string printed = Translate("""
            #nullable enable
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
            }
            """);

        Assert.Equal("3 4 -1 -1;3 -101 -1 -1;30 -1 -1 -1", CompileAndRun(printed, "C.Run()").Trim());
    }

    /// <summary>
    /// The mapping also reaches a field, an inherited property, an overridden
    /// property read through an inherited <c>Deconstruct</c>, and a
    /// <c>name:</c>-labelled subpattern (the label names the out-parameter,
    /// not the member, so it must not be emitted as a member access).
    /// </summary>
    [Fact]
    public void CaseMismatch_MapsToFieldsInheritedMembersAndLabelledSubpatterns()
    {
        string printed = Translate("""
            #nullable enable
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
            }
            """);

        Assert.DoesNotContain(".count", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".name", printed, StringComparison.Ordinal);
        Assert.Equal(
            "True False False False;True False False False;True False",
            CompileAndRun(printed, "C.Run()").Trim());
    }

    /// <summary>
    /// An interface's <c>Deconstruct</c> reached through a derived interface
    /// and through a type parameter constrained to it reads the declaring
    /// interface's slot (<c>out int p</c> to <c>IBase.P</c>).
    /// </summary>
    [Fact]
    public void CaseMismatch_ResolvesThroughDerivedInterfacesAndConstraints()
    {
        string printed = Translate("""
            #nullable enable
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
            }
            """);

        Assert.Equal(
            "True False False;True False False;True False False",
            CompileAndRun(printed, "C.Run()").Trim());
    }

    /// <summary>
    /// Out-parameters that cannot be mapped faithfully stay loud, with the
    /// reason, on every lowering route: an ambiguous case-insensitive match,
    /// no matching member, a member of another type, a member a derived type
    /// or derived interface hides from an inherited <c>Deconstruct</c> (also
    /// through a constrained type parameter), an inaccessible member, a
    /// property whose getter is missing or inaccessible,
    /// and an extension <c>Deconstruct</c>.
    /// </summary>
    /// <param name="deconstruct">The Deconstruct shape.</param>
    /// <param name="usage">A pattern use of <c>Target</c> over <c>object o</c>.</param>
    /// <param name="reason">The expected reason in the diagnostic.</param>
    [Theory]
    [InlineData("ambiguous", "public static bool F(object o) => o is Target(1);", "matches several members case-insensitively")]
    [InlineData("missing", "public static bool F(object o) => o is Target(1);", "has no matching property or field")]
    [InlineData("mismatch", "public static bool F(object o) => o is Target(1);", "is 'int' but member 'P' is 'long'")]
    [InlineData("exactMismatch", "public static bool F(object o) => o is Target(1);", "is 'int' but member 'P' is 'long'")]
    [InlineData("extension", "public static bool F(object o) => o is Target(1);", "is an extension Deconstruct")]
    [InlineData("hidden", "public static bool F(object o) => o is Target(1);", "reads 'TargetBase.P', which 'Target.P' hides")]
    [InlineData("private", "public static bool F(object o) => o is Target(1);", "reads 'p', which is not accessible here")]
    [InlineData("privateGetter", "public static bool F(object o) => o is Target(1);", "reads 'P', whose getter is not accessible here")]
    [InlineData("setOnly", "public static bool F(object o) => o is Target(1);", "reads 'P', whose getter is not accessible here")]
    [InlineData("protectedGetter", "public static bool F(object o) => o is Target(1);", "reads 'P', whose getter is not accessible here")]
    [InlineData("protectedThroughBase", "public static bool F(object o) => Sub.G(o);", "reads 'P', whose getter is not accessible here")]
    [InlineData("hiddenByMethod", "public static bool F(object o) => o is Target(1);", "reads 'TargetBase.P', which 'Target.P' hides")]
    [InlineData("interfaceHidden", "public static bool F(object o) => o is IDerived(1);", "reads 'IBase.P', which 'IDerived.P' hides")]
    [InlineData("interfaceHidden", "public static bool F(IDerived2 d) => d is (1, _);", "reads 'IBase.P', which 'IDerived.P' hides")]
    [InlineData("interfaceHidden", "public static bool F<T>(T t) where T : class, IDerived => t is (1, _);", "reads 'IBase.P', which 'IDerived.P' hides")]
    [InlineData("missing", "public static bool F(object o) => o is not Target(1);", "has no matching property or field")]
    [InlineData("missing", "public static bool F(object o) => o is Target(1) or string;", "has no matching property or field")]
    [InlineData("missing", "public static bool F(object o) => o is Box(Target(1));", "has no matching property or field")]
    [InlineData("missing", "public static int F(object o) => o switch { Target(1) => 1, _ => 0 };", "has no matching property or field")]
    [InlineData("missing", "public static int F(object o) { switch (o) { case Target(1): return 1; default: return 0; } }", "has no matching property or field")]
    [InlineData("missing", "public static int F(object o) { if (o is Target(var v)) { return v; } return 0; }", "has no matching property or field")]
    [InlineData("missing", "public static bool F(object o) => o is Target(p: 1);", "has no matching property or field")]
    public void UnmappableOutParameter_IsReportedLoudly(string deconstruct, string usage, string reason)
    {
        string target = deconstruct switch
        {
            "ambiguous" => """
                public sealed class Target
                {
                    public int P { get; set; }
                    public int p;
                    public void Deconstruct(out int p) => p = this.p;
                }
                """,
            "missing" => """
                public sealed class Target
                {
                    public int Value { get; set; }
                    public void Deconstruct(out int p) => p = Value;
                }
                """,
            "mismatch" => """
                public sealed class Target
                {
                    public long P { get; set; }
                    public void Deconstruct(out int p) => p = (int)P;
                }
                """,
            "exactMismatch" => """
                public sealed class Target
                {
                    public long P { get; set; }
                    public void Deconstruct(out int P) => P = unchecked((int)this.P);
                }
                """,
            "hidden" => """
                public class TargetBase
                {
                    public int P { get; set; }
                    public void Deconstruct(out int p) => p = P;
                }

                public sealed class Target : TargetBase
                {
                    public new int P { get; set; }
                }
                """,
            "private" => """
                public sealed class Target
                {
                    private readonly int p;
                    public Target(int value) => p = value;
                    public void Deconstruct(out int P) => P = p;
                }
                """,
            "privateGetter" => """
                public sealed class Target
                {
                    public int P { private get; set; }
                    public void Deconstruct(out int p) => p = P;
                }
                """,
            "setOnly" => """
                public sealed class Target
                {
                    private int stored;
                    public int P { set => stored = value; }
                    public void Deconstruct(out int p) => p = stored;
                }
                """,
            "protectedGetter" => """
                public class Target
                {
                    public int P { protected get; set; }
                    public void Deconstruct(out int p) => p = P;
                }
                """,
            "protectedThroughBase" => """
                public class Target
                {
                    public int P { protected get; set; }
                    public void Deconstruct(out int p) => p = P;
                }

                public sealed class Sub : Target
                {
                    // Inside a derived class, but `P`'s protected getter is
                    // not readable through a `Target`-typed receiver (CS1540).
                    public static bool G(object o) => o is Target(1);
                }
                """,
            "interfaceHidden" => """
                public interface IBase
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
                }
                """,
            "hiddenByMethod" => """
                public class TargetBase
                {
                    public int P { get; set; }
                    public void Deconstruct(out int p) => p = P;
                }

                public sealed class Target : TargetBase
                {
                    public new int P() => 0;
                }
                """,
            _ => """
                public sealed class Target
                {
                    public int P { get; set; }
                }

                public static class TargetExtensions
                {
                    public static void Deconstruct(this Target t, out int P) => P = t.P;
                }
                """,
        };

        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateWithDiagnostics(
            "#nullable enable\nnamespace Sample;\n\n" + target + """

            public sealed class Box
            {
                public object? Item { get; set; }
                public void Deconstruct(out object? item) => item = Item;
            }

            public static class C
            {
            """ + "\n    " + usage + "\n}\n");

        Assert.True(
            diagnostics.Any(d => d.IsUnsupported
                && d.Message.Contains("positional subpattern has no canonical G# form", StringComparison.Ordinal)
                && d.Message.Contains(reason, StringComparison.Ordinal)),
            "Expected a loud positional-subpattern diagnostic mentioning '" + reason + "'. Got:\n"
                + string.Join(Environment.NewLine, diagnostics.Select(d => d.Message))
                + "\n\n" + printed);
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string? compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = System.IO.Path.Combine(AppContext.BaseDirectory, "issue-4382-e2e", Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = System.IO.Path.Combine(workDir, "Snippet.gs");
            string dllPath = System.IO.Path.Combine(workDir, "Snippet.dll");
            System.IO.File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

            (int compileExit, string compileOut) = RunDotnet($"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet. Output:\n" + compileOut + "\n\nTranslated G#:\n" + printed);

            (int runExit, string stdout) = RunDotnet($"\"{dllPath}\"");
            Assert.True(runExit == 0, "Translated snippet must run. Output:\n" + stdout + "\n\nTranslated G#:\n" + printed);
            return stdout;
        }
        finally
        {
            try
            {
                System.IO.Directory.Delete(workDir, recursive: true);
            }
            catch (System.IO.IOException)
            {
                // Best-effort cleanup: a process still releasing the output must not fail the test.
            }
            catch (UnauthorizedAccessException)
            {
                // Same as above.
            }
        }
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        // UseShellExecute = false always starts a new process (or throws).
        using var process = System.Diagnostics.Process.Start(psi)!;

        // Drain both streams concurrently so a full pipe cannot deadlock.
        System.Threading.Tasks.Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        System.Threading.Tasks.Task<string> stderr = process.StandardError.ReadToEndAsync();
        System.Threading.Tasks.Task.WaitAll(stdout, stderr);
        process.WaitForExit();
        return (process.ExitCode, stdout.Result + stderr.Result);
    }

    private static string? FindCompiler()
    {
        var dir = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = System.IO.Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (System.IO.File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics) TranslateWithDiagnostics(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (GSharpPrinter.Print(translated), context.Diagnostics);
    }

    // Unlike a helper that only checks the printed text, this fails on any
    // unsupported diagnostic: #4382's bare type test was reported only there.
    private static string Translate(string source)
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateWithDiagnostics(source);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsUnsupported);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip:\n" +
                string.Join(Environment.NewLine, roundTrip.Errors) +
                "\n\n" + printed);
        return printed;
    }
}
