// <copyright file="Adr0151IfLetExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
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
    public void Issue2819_SameVersionPackedToolAndSdk_CompileTranslatedIfLet()
    {
        string repoRoot = GsharpTestProjectRunner.FindRepoRoot();
        (string NupkgPath, string Version)? cs2gs = ResolveLocalCs2GsPackage(repoRoot);
        Assert.NotNull(cs2gs);

        string sdkPackage = Path.Combine(
            Path.GetDirectoryName(cs2gs.Value.NupkgPath),
            "Gsharp.NET.Sdk." + cs2gs.Value.Version + ".nupkg");
        Assert.True(
            File.Exists(sdkPackage),
            "Building the cs2gs tool package must produce the same-version Gsharp.NET.Sdk package: " +
                cs2gs.Value.Version);

        string workDir = Path.Combine(
            repoRoot,
            "issue-2819-package-smoke",
            Guid.NewGuid().ToString("N"));
        string feedDir = Path.Combine(workDir, "out", "bin", "Release", "nupkgs");
        string packagesDir = Path.Combine(workDir, "packages");
        string toolDir = Path.Combine(workDir, "tool");
        Directory.CreateDirectory(feedDir);
        Directory.CreateDirectory(packagesDir);
        Directory.CreateDirectory(toolDir);
        GsharpTestProjectRunner.WriteIsolationBoundary(workDir);
        File.WriteAllText(Path.Combine(workDir, "GSharp.sln"), string.Empty);

        string packedTool = Path.Combine(feedDir, Path.GetFileName(cs2gs.Value.NupkgPath));
        string packedSdk = Path.Combine(feedDir, Path.GetFileName(sdkPackage));
        File.Copy(cs2gs.Value.NupkgPath, packedTool);
        File.Copy(sdkPackage, packedSdk);

        string nugetConfig = Path.Combine(workDir, "nuget.config");
        File.WriteAllText(
            nugetConfig,
            $"""
             <?xml version="1.0" encoding="utf-8"?>
             <configuration>
               <packageSources>
                 <clear />
                 <add key="issue-2819-packages" value="{System.Security.SecurityElement.Escape(feedDir)}" />
               </packageSources>
               <config>
                 <add key="globalPackagesFolder" value="{System.Security.SecurityElement.Escape(packagesDir)}" />
               </config>
             </configuration>
             """);

        string sdkExtractDir = Path.Combine(workDir, "sdk");
        ZipFile.ExtractToDirectory(packedSdk, sdkExtractDir);
        string packedGsc = Path.Combine(sdkExtractDir, "tools", "compiler", "gsc.dll");
        Assert.True(File.Exists(packedGsc), "Packed SDK must contain tools/compiler/gsc.dll.");

        string sourceDir = Path.Combine(workDir, "source");
        string translatedDir = Path.Combine(workDir, "translated");
        string artifactsDir = Path.Combine(workDir, "artifacts");
        Directory.CreateDirectory(sourceDir);
        File.WriteAllText(Path.Combine(sourceDir, "Repro.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(sourceDir, "Repro.cs"), @"
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

        var environment = new Dictionary<string, string>
        {
            ["DOTNET_CLI_HOME"] = Path.Combine(workDir, ".dotnet"),
            ["GSHARP_SKIP_ILVERIFY"] = "1",
            ["NUGET_PACKAGES"] = packagesDir,
        };
        Directory.CreateDirectory(environment["DOTNET_CLI_HOME"]);

        (int Exit, string Output) install = RunProcess(
            "dotnet",
            new[]
            {
                "tool",
                "install",
                "Gsharp.Cs2Gs",
                "--tool-path",
                toolDir,
                "--version",
                cs2gs.Value.Version,
                "--configfile",
                nugetConfig,
            },
            workDir,
            environment);
        Assert.True(install.Exit == 0, "Installing exact cs2gs nupkg failed:\n" + install.Output);

        string cs2gsCommand = Path.Combine(toolDir, OperatingSystem.IsWindows() ? "cs2gs.exe" : "cs2gs");
        Assert.True(File.Exists(cs2gsCommand), "Installed cs2gs command was not found: " + cs2gsCommand);
        (int Exit, string Output) migration = RunProcess(
            cs2gsCommand,
            new[]
            {
                "migrate",
                "--corpus",
                sourceDir,
                "--out",
                translatedDir,
                "--artifacts",
                artifactsDir,
                "--config",
                "Release",
                "--no-via-sdk",
                "--gsc",
                packedGsc,
            },
            workDir,
            environment);
        Assert.True(migration.Exit == 0, "Packed cs2gs migration failed:\n" + migration.Output);

        string translatedSource = Path.Combine(translatedDir, "Repro.gs");
        Assert.True(File.Exists(translatedSource), "Packed cs2gs did not emit Repro.gs.");
        Assert.Contains(
            "if let values = ",
            File.ReadAllText(translatedSource),
            StringComparison.Ordinal);

        string translatedProject = Path.Combine(translatedDir, "Repro.gsproj");
        Assert.True(File.Exists(translatedProject), "Packed cs2gs did not emit Repro.gsproj.");
        Assert.Contains(
            "Gsharp.NET.Sdk/" + cs2gs.Value.Version,
            File.ReadAllText(translatedProject),
            StringComparison.Ordinal);

        (int Exit, string Output) build = RunProcess(
            "dotnet",
            new[]
            {
                "build",
                translatedProject,
                "-c",
                "Release",
                "--nologo",
                "-p:RestoreConfigFile=" + nugetConfig,
                "-p:RestorePackagesPath=" + packagesDir,
                "-p:RestoreNoCache=true",
            },
            translatedDir,
            environment);
        Assert.True(
            build.Exit == 0,
            "Exact same-version packed SDK must compile packed cs2gs output:\n" + build.Output);
        Directory.Delete(workDir, recursive: true);
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
}",
            "Reassigned pattern binders currently keep a spill fallback that cannot declare the mutable designator in G#.");

        Assert.DoesNotContain("if let n =", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TypedDeclarationPattern_UsesTestingIfLet()
    {
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

        Assert.Contains("if let s = Find() as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void PropertySubpattern_UsesIfLetGuard()
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

        Assert.Contains("if let s = Find()", printed, StringComparison.Ordinal);
        Assert.Contains("s is { Length: > 0 }", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NonNullableReceiver_UsesScopedAuthorBinding()
    {
        // gsc rejects a non-nullable `if let` initializer with GS0296, so the
        // translator uses a scoped local carrying the author's binder name.
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
        Assert.Contains("let n = Find()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
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
        RoundTripResult result = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Printer-only expression fixtures deliberately use undefined placeholder identifiers.");
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

    private static string TranslateUnit(string source, string roundTripOnlyReason = null)
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
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static (string NupkgPath, string Version)? ResolveLocalCs2GsPackage(string repoRoot)
    {
        string nupkgDir = Path.Combine(repoRoot, "out", "bin", "Release", "nupkgs");
        if (!Directory.Exists(nupkgDir))
        {
            return null;
        }

        const string Prefix = "Gsharp.Cs2Gs.";
        const string Suffix = ".nupkg";
        (string NupkgPath, string Version)? best = null;
        foreach (string file in Directory.EnumerateFiles(nupkgDir, Prefix + "*" + Suffix))
        {
            string name = Path.GetFileName(file);
            string version = name.Substring(Prefix.Length, name.Length - Prefix.Length - Suffix.Length);
            if (best is null ||
                GsharpTestProjectRunner.CompareVersions(version, best.Value.Version) > 0)
            {
                best = (file, version);
            }
        }

        return best;
    }

    private static (int Exit, string Output) RunProcess(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        IReadOnlyDictionary<string, string> environment)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            psi.ArgumentList.Add(argument);
        }

        foreach ((string name, string value) in environment)
        {
            psi.Environment[name] = value;
        }

        using var process = Process.Start(psi);
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        bool exited = process.WaitForExit((int)TimeSpan.FromMinutes(10).TotalMilliseconds);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
        }

        process.WaitForExit();
        Task.WaitAll(stdout, stderr);
        string output = stdout.Result + stderr.Result;
        Assert.True(exited, fileName + " timed out. Output:\n" + output);
        return (process.ExitCode, output);
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
