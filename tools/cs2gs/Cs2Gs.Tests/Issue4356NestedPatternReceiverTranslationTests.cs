// <copyright file="Issue4356NestedPatternReceiverTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable
using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4356: a property subpattern that tests members of a nullable member
/// (<c>{ DeclaringType: { IsInterface: true } }</c>, or the extended
/// <c>{ DeclaringType.IsInterface: true }</c>) used to be guard-lowered to
/// <c>c.DeclaringType != nil &amp;&amp; c.DeclaringType.IsInterface</c>. That
/// read the member twice, unlike C#, and gsc does not narrow the second read
/// (only a chain of stable links narrows), so it bound only because gsc's
/// member lookup let any chained imported read through regardless of its
/// stated nullability. Found by the hot-core self-migration guard on
/// <c>src/Core/CodeAnalysis/Binding/MemberLookup.cs</c>. Such patterns now take
/// G#'s native property pattern, which reads each member once.
/// </summary>
public sealed class Issue4356NestedPatternReceiverTranslationTests
{
    [Fact]
    public void NestedSubpatternOverImportedNullableMember_TakesTheNativePattern()
    {
        // `MethodInfo.DeclaringType` is an imported, annotated `Type?`. The
        // guard-lowered form (`c.DeclaringType != nil && c.DeclaringType.IsInterface`)
        // read it twice and bound only through gsc's old member-lookup
        // carve-out; G#'s native pattern reads it once, like C#, and binds
        // without it.
        string printed = Translate("""
            #nullable enable
            using System.Reflection;

            namespace Sample;

            public static class Probe
            {
                public static bool IsWidening(MethodInfo candidate)
                    => candidate is { IsAbstract: true, DeclaringType: { IsInterface: true, IsGenericType: false } };
            }
            """);

        Assert.Contains(
            "candidate is { IsAbstract: true, DeclaringType: { IsInterface: true, IsGenericType: false } }",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("candidate.DeclaringType", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExtendedPropertySubpatternOverImportedNullableMember_TakesTheNativePattern()
    {
        // The flattened spelling of the case above lowers to the same nested
        // native field (#1891).
        string printed = Translate("""
            #nullable enable
            using System.Reflection;

            namespace Sample;

            public static class Probe
            {
                public static bool IsWidening(MethodInfo candidate)
                    => candidate is { IsAbstract: true, DeclaringType.IsInterface: true };
            }
            """);

        Assert.Contains(
            "candidate is { IsAbstract: true, DeclaringType: { IsInterface: true } }",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("candidate.DeclaringType", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void LocalSubject_IsNarrowedByTheGuard_AndNotAsserted()
    {
        string printed = Translate("""
            #nullable enable
            using System;

            namespace Sample;

            public static class Probe
            {
                public static bool IsInterface(Type? type) => type is { IsInterface: true };
            }
            """);

        Assert.Contains("type != nil && type.IsInterface", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("type!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// C# reads a property subpattern's member ONCE and tests every nested
    /// subpattern against that one value. A getter that returns non-nil and
    /// then nil pins it: lowering to <c>o.P != nil &amp;&amp; o.P!!.X == 0</c>
    /// read <c>P</c> twice and threw on the second read. Every shape that
    /// reads a nested member more than once must read it exactly once and
    /// match, as C# does — whether it takes G#'s native property pattern or
    /// the boolean lowering (a positional or negated nested pattern, a
    /// reassigned nested binder), plus a nil member under both forms.
    /// </summary>
    [Fact]
    public void NestedMemberSubpatterns_ReadTheMemberOnce()
    {
        string printed = Translate("""
            #nullable enable
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
            }
            """);

        Assert.Equal(
            "True,1;True,1;True,1;True,1;True,1;True,False",
            CompileAndRun(printed, "C.Run()").Trim());
    }

    /// <summary>
    /// A typed switch arm lowers its property subpatterns through a separate
    /// path (<c>case r is Rec when …</c>). An extended subpattern there used
    /// to print a flat <c>r.Clause.Items.Count</c> chain: it threw on a nil
    /// <c>Clause</c> where C# falls through, and over an imported annotated
    /// member it bound only through gsc's old member-lookup carve-out. Found
    /// by the hot-core self-migration guard on this translator's own
    /// <c>PatternTestsMembersOfNullableMember</c>.
    /// </summary>
    [Fact]
    public void TypedSwitchArm_ExtendedSubpatternOverNullableLink_IsGuarded()
    {
        string printed = Translate("""
            #nullable enable
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

                public static void Run()
                {
                    Console.WriteLine(F(new Rec()) + "," + F(new Rec { Clause = new Clause() }));
                }
            }
            """);

        Assert.Equal("False,True", CompileAndRun(printed, "C.Run()").Trim());
    }

    private static string CompileAndRun(string printed, string callExpression)
    {
        string? compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = System.IO.Path.Combine(AppContext.BaseDirectory, "issue-4356-e2e", Guid.NewGuid().ToString("N"));
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

        // Process.Start(ProcessStartInfo) returns null only when UseShellExecute
        // reuses an existing process; psi sets UseShellExecute = false above, so
        // a process is always started (or Start throws).
        using var process = System.Diagnostics.Process.Start(psi)!;
        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, output);
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

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(translated);
        RoundTripResult roundTrip = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip:\n" +
                string.Join(Environment.NewLine, roundTrip.Errors) +
                "\n\n" + printed);
        return printed;
    }
}
