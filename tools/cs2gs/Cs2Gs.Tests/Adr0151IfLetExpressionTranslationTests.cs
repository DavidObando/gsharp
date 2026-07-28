// <copyright file="Adr0151IfLetExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0151 translation tests: a C# conditional whose condition is a bare
/// non-null declaration pattern (<c>receiver is { } name</c>), optionally
/// <c>&amp;&amp;</c>-joined with further predicates, now lowers to the
/// canonical G# value-position <c>if let</c> instead of the spill-based
/// <c>if</c>-expression. That removes the <c>let __spillN</c> prologue (so an
/// expression-bodied member folds back to the arrow form) and the repeated
/// <c>!!</c> non-null assertions at every binder reference.
///
/// The rewrite is deliberately conservative; the fallback tests at the bottom
/// pin down the shapes that must keep the old lowering.
/// </summary>
public class Adr0151IfLetExpressionTranslationTests
{
    // Golden printer coverage: the code model prints the canonical one-line
    // form, with the escape-hatch parenthesization for an initializer whose own
    // top-level operator is `&&` (which would otherwise be read as the guard
    // delimiter by gsc).
    [Fact]
    public void Printer_BindingOnly_RendersCanonicalForm()
    {
        var ifLet = new IfLetExpression(
            new List<IfLetBinding> { new IfLetBinding("v", new IdentifierExpression("maybe")) },
            guard: null,
            thenExpression: new IdentifierExpression("v"),
            elseExpression: LiteralExpression.String(string.Empty));

        Assert.Equal(
            "if let v = maybe { v } else { \"\" }",
            RenderExpressionForTest(ifLet));
    }

    [Fact]
    public void Printer_Guarded_RendersGuardAfterFinalBinding()
    {
        var ifLet = new IfLetExpression(
            new List<IfLetBinding>
            {
                new IfLetBinding("a", new IdentifierExpression("first")),
                new IfLetBinding("b", new IdentifierExpression("second")),
            },
            guard: new BinaryExpression(
                new MemberAccessExpression(new IdentifierExpression("a"), "Length"),
                ">",
                LiteralExpression.Int("0")),
            thenExpression: new IdentifierExpression("b"),
            elseExpression: LiteralExpression.String(string.Empty));

        Assert.Equal(
            "if let a = first, let b = second && a.Length > 0 { b } else { \"\" }",
            RenderExpressionForTest(ifLet));
    }

    [Fact]
    public void Printer_LogicalAndInitializer_IsParenthesized()
    {
        // Without the parentheses gsc would read the initializer's own `&&` as
        // the guard delimiter and bind `ok` to `a` alone.
        var ifLet = new IfLetExpression(
            new List<IfLetBinding>
            {
                new IfLetBinding(
                    "ok",
                    new BinaryExpression(new IdentifierExpression("a"), "&&", new IdentifierExpression("b"))),
            },
            guard: new IdentifierExpression("c"),
            thenExpression: new IdentifierExpression("ok"),
            elseExpression: LiteralExpression.Bool(false));

        Assert.Equal(
            "if let ok = (a && b) && c { ok } else { false }",
            RenderExpressionForTest(ifLet));
    }

    [Fact]
    public void Printer_ExplicitUnderlyingType_IsRendered()
    {
        var ifLet = new IfLetExpression(
            new List<IfLetBinding>
            {
                new IfLetBinding("v", new IdentifierExpression("maybe"), new NamedTypeReference("string")),
            },
            guard: null,
            thenExpression: new IdentifierExpression("v"),
            elseExpression: LiteralExpression.String(string.Empty));

        Assert.Equal(
            "if let v string = maybe { v } else { \"\" }",
            RenderExpressionForTest(ifLet));
    }

    // The reported repro: an expression-bodied property whose body is a
    // guarded pattern ternary. Before ADR-0151 this produced a block-bodied
    // accessor with a `__spill0` prologue and repeated `!!`.
    [Fact]
    public void ExpressionBodiedProperty_GuardedPatternTernary_FoldsToArrowIfLet()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class Package
    {
        public string[]? GetCopyrights() => null;

        public string? Copyright =>
            GetCopyrights() is { } copyright && copyright.Length > 0 ? copyright[0] : null;
    }
}");

        Assert.Contains("if let copyright = ", printed, StringComparison.Ordinal);
        Assert.Contains("GetCopyrights()", printed, StringComparison.Ordinal);
        Assert.Contains("&& copyright.Length > 0 {", printed, StringComparison.Ordinal);
        Assert.Contains("{ copyright[0] } else { default(string?) }", printed, StringComparison.Ordinal);

        // Folded back to the idiomatic expression-bodied arrow form ...
        Assert.Contains("prop Copyright string? ->", printed, StringComparison.Ordinal);

        // ... with no spill temp and no repeated non-null assertion on the
        // binder (the two symptoms of the old spill-based lowering).
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("copyright!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void BindingOnlyTernary_LowersToIfLet()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string Name => Find() is { } n ? n : ""anonymous"";
    }
}");

        Assert.Contains("if let n = ", printed, StringComparison.Ordinal);
        Assert.Contains("{ n } else { \"anonymous\" }", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("n!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void MultiplePredicates_AreFoldedIntoASingleGuard()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string Name =>
            Find() is { } n && n.Length > 0 && n[0] == 'a' ? n : ""anonymous"";
    }
}");

        Assert.Contains("if let n = ", printed, StringComparison.Ordinal);
        Assert.Contains("&& n.Length > 0 && n[0] == 'a' {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullableValueTypeReceiver_LowersToIfLet()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public int? Value { get; set; }

        public int Doubled => Value is { } v && v > 0 ? v * 2 : -1;
    }
}");

        Assert.Contains("if let v = ", printed, StringComparison.Ordinal);
        Assert.Contains("&& v > 0 { v * 2 } else { -1 }", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void SideEffectingReceiver_IsEmittedExactlyOnce()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public int Calls;

        public string? Next()
        {
            Calls++;
            return ""x"";
        }

        public string Read() => Next() is { } s ? s : ""none"";
    }
}");

        // `if let` evaluates its initializer exactly once by construction, so
        // the side-effecting receiver needs no spill temp to be single-evaluated.
        Assert.Contains("if let s = ", printed, StringComparison.Ordinal);
        Assert.Contains("Next() { s } else { \"none\" }", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedConditional_InElseArm_AlsoLowersToIfLet()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? A() => null;

        public string? B() => null;

        public string Pick() => A() is { } a ? a : (B() is { } b ? b : ""none"");
    }
}");

        Assert.Contains("if let a = ", printed, StringComparison.Ordinal);
        Assert.Contains("if let b = ", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NullArm_StaysAsDefaultOfTheNullableResultType()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string? First() => Find() is { } n && n.Length > 0 ? n : null;
    }
}");

        Assert.Contains("if let n = ", printed, StringComparison.Ordinal);
        Assert.Contains("else { default(string?) }", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TranslatedIfLet_CompilesAndRunsUnderGsc()
    {
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class Package
    {
        public string[]? Copyrights;

        public string? Copyright() =>
            Copyrights is { } c && c.Length > 0 ? c[0] : null;
    }
}");

        Assert.Contains("if let c = ", printed, StringComparison.Ordinal);
        CompileAndRun(printed, "Package().Copyright()");
    }

    [Fact]
    public void Issue2819_SameVersionPackedSdk_CompilesTranslatedIfLet()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        public string[]? G() => null;

        public string? Value() =>
            G() is { } values && values.Length > 0 ? values[0] : null;
    }
}");

        Assert.Contains("if let values = ", printed, StringComparison.Ordinal);

        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        (string NupkgPath, string Version)? sdk =
            GsharpTestProjectRunner.ResolveLocalSdkPackage(repoRoot, "Release");
        Assert.NotNull(sdk);
        string cs2gsPackage = Path.Combine(
            Path.GetDirectoryName(sdk.Value.NupkgPath),
            "Gsharp.Cs2Gs." + sdk.Value.Version + ".nupkg");
        Assert.True(
            File.Exists(cs2gsPackage),
            "cs2gs and Gsharp.NET.Sdk must be packed at the same version: " + sdk.Value.Version);

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            "issue-2819-packed-sdk",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string sourcePath = Path.Combine(workDir, "Repro.gs");
        File.WriteAllText(sourcePath, printed);

        SdkCompileResult result = new SdkCompileRunner().Compile(
            workDir,
            "Issue2819",
            new[] { sourcePath },
            TargetKind.Library,
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            rootNamespace: null,
            config: "Release");

        Assert.True(result.IsAvailable, result.UnavailableReason);
        Assert.True(
            result.Succeeded,
            "Packed SDK must compile cs2gs value-position if-let output. Output:\n" + result.Output);
    }

    // ── Conservative fallbacks ───────────────────────────────────────────

    [Fact]
    public void ReassignedBinder_KeepsTheSpillBasedFallback()
    {
        // G# `let` is immutable, so a C# binder that is written to (here
        // through a `ref` argument) cannot become an `if let` binding.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        private static bool Reassign(ref string s)
        {
            s = s.Trim();
            return true;
        }

        public string Name() => Find() is { } n && Reassign(ref n) ? n : ""anonymous"";
    }
}");

        Assert.DoesNotContain("if let n =", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TypedDeclarationPattern_KeepsTheSpillBasedFallback()
    {
        // `is string s` is a TYPE TEST, not just a nullable strip — an
        // `if let` binding cannot express it.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public object? Find() => null;

        public string Name => Find() is string s ? s : ""anonymous"";
    }
}");

        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void PropertySubpattern_KeepsTheSpillBasedFallback()
    {
        // `is { Length: > 0 } s` adds a member test to the null check.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string Name => Find() is { Length: > 0 } s ? s : ""anonymous"";
    }
}");

        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NonNullableReceiver_KeepsTheSpillBasedFallback()
    {
        // gsc rejects a non-nullable `if let` initializer with GS0296, so a
        // receiver that is not nullable in G# must keep the old lowering.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string Find() => ""x"";

        public string Name => Find() is { } n ? n : ""anonymous"";
    }
}");

        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedPatternInTheTrueArm_KeepsTheSpillBasedFallback()
    {
        // The inner pattern hoists a spill `let` that would have to live
        // OUTSIDE the `if let`, where it would run unconditionally and could
        // not see the binding.
        string printed = TranslateUnit(@"
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public object? Other() => null;

        public string Name()
        {
            return Find() is { } n ? (Other() is { } o ? o.ToString() : n) : ""anonymous"";
        }
    }
}");

        Assert.DoesNotContain("if let n =", printed, StringComparison.Ordinal);
    }

    private static string RenderExpressionForTest(GExpression expression)
    {
        var unit = new CompilationUnit(
            "Demo",
            members: new List<GNode>
            {
                new MethodDeclaration(
                    "Run",
                    body: new BlockStatement(new List<GStatement>
                    {
                        new LocalDeclarationStatement(BindingKind.Let, "x", initializer: expression),
                    })),
            });

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Printed G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);

        int start = printed.IndexOf("let x = ", StringComparison.Ordinal);
        Assert.True(start >= 0, "expected a `let x = <expr>` line in:\n" + printed);
        start += "let x = ".Length;
        int end = printed.IndexOf('\n', start);
        return printed.Substring(start, end - start).TrimEnd();
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static void CompileAndRun(string printed, string callExpression)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "adr-0151-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string runOut) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
