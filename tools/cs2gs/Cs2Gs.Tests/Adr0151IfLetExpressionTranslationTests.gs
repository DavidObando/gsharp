// <copyright file="Adr0151IfLetExpressionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.IO.Compression
import System.Security
import System.Text
import System.Threading.Tasks
import Xunit

/// ADR-0151 translation tests: a C# conditional whose condition is a bare
/// non-null declaration pattern (`receiver is { } name`), optionally
/// `&&`-joined with further predicates, must not fall back to
/// the spill-based `if`-expression: no `let __spillN` prologue (so
/// an expression-bodied member keeps the arrow form) and no repeated
/// `!!` non-null assertion at every binder reference.
///
/// ADR-0166 / issue #3409: the translator now emits these ternaries as the
/// native G# if-expression over a pattern variable —
/// `if receiver is { } name && predicate { … } else { … }` — so the
/// tests below assert that form. The ADR-0151 value-position `if let`
/// remains a supported G# expression: its printer goldens stay in this file,
/// and it is still the translation target for shapes the native path
/// declines (a `var` designation, a reassigned binder, a binder read
/// outside a region G# scopes it to). The fallback tests at the bottom pin
/// down the shapes that must keep the older lowerings.
open class Adr0151IfLetExpressionTranslationTests {
    // Golden printer coverage: the code model prints the canonical one-line
    // form, with the escape-hatch parenthesization for an initializer whose own
    // top-level operator is `&&` (which would otherwise be read as the guard
    // delimiter by gsc).
    @Fact
    func Printer_BindingOnly_RendersCanonicalForm() {
        let ifLet = IfLetExpression(
            List[IfLetBinding]{IfLetBinding("v", IdentifierExpression("maybe"))},
            $guard: nil,
            thenExpression: IdentifierExpression("v"),
            elseExpression: LiteralExpression.String(string.Empty)
        )
        Assert.Equal("if let v = maybe { v } else { \"\" }", RenderExpressionForTest(ifLet))
    }

    @Fact
    func Printer_Guarded_RendersGuardAfterFinalBinding() {
        let ifLet = IfLetExpression(
            List[IfLetBinding]{
                IfLetBinding("a", IdentifierExpression("first")),
                IfLetBinding("b", IdentifierExpression("second"))
            },
            $guard: BinaryExpression(
                MemberAccessExpression(IdentifierExpression("a"), "Length"),
                ">",
                LiteralExpression.Int("0")
            ),
            thenExpression: IdentifierExpression("b"),
            elseExpression: LiteralExpression.String(string.Empty)
        )
        Assert.Equal(
            "if let a = first, let b = second && a.Length > 0 { b } else { \"\" }",
            RenderExpressionForTest(ifLet)
        )
    }

    @Fact
    func Printer_LogicalAndInitializer_IsParenthesized() {
        // Without the parentheses gsc would read the initializer's own `&&` as
        // the guard delimiter and bind `ok` to `a` alone.
        let ifLet = IfLetExpression(
            List[IfLetBinding]{
                IfLetBinding("ok", BinaryExpression(IdentifierExpression("a"), "&&", IdentifierExpression("b")))
            },
            $guard: IdentifierExpression("c"),
            thenExpression: IdentifierExpression("ok"),
            elseExpression: LiteralExpression.Bool(false)
        )
        Assert.Equal("if let ok = (a && b) && c { ok } else { false }", RenderExpressionForTest(ifLet))
    }

    @Fact
    func Printer_ExplicitUnderlyingType_IsRendered() {
        let ifLet = IfLetExpression(
            List[IfLetBinding]{IfLetBinding("v", IdentifierExpression("maybe"), NamedTypeReference("string"))},
            $guard: nil,
            thenExpression: IdentifierExpression("v"),
            elseExpression: LiteralExpression.String(string.Empty)
        )
        Assert.Equal("if let v string = maybe { v } else { \"\" }", RenderExpressionForTest(ifLet))
    }

    // The reported repro: an expression-bodied property whose body is a
    // guarded pattern ternary. Before ADR-0151 this produced a block-bodied
    // accessor with a `__spill0` prologue and repeated `!!`.
    // ADR-0166 / issue #3409: the pattern variable is now native, so the arrow
    // body is the G# if-expression `if recv is { } name && guard { a } else { b }`.
    @Fact
    func ExpressionBodiedProperty_GuardedPatternTernary_FoldsToArrowIfExpression() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains(
            "if GetCopyrights() is { } copyright && copyright.Length > 0 {",
            printed,
            StringComparison.Ordinal
        )
        Assert.Contains("{ copyright[0] } else { default(string?) }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        // Folded back to the idiomatic expression-bodied arrow form ...
        Assert.Contains("prop Copyright string? ->", printed, StringComparison.Ordinal)
        // ... with no spill temp and no repeated non-null assertion on the
        // binder (the two symptoms of the old spill-based lowering).
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("copyright!!", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: `recv is { } n ? n : fallback` is the native
    // if-expression over the pattern variable `n`.
    @Fact
    func BindingOnlyTernary_UsesNativePatternVariable() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string Name => Find() is { } n ? n : "anonymous";
    }
}`)
        Assert.Contains("if Find() is { } n { n } else { \"anonymous\" }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("n!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func MultiplePredicates_AreFoldedIntoASingleGuard() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string Name =>
            Find() is { } n && n.Length > 0 && n[0] == 'a' ? n : "anonymous";
    }
}`)
        // ADR-0166 / issue #3409: every predicate stays in the native `if`
        // header, where the pattern variable is in scope for the `&&` chain.
        Assert.Contains(
            "if Find() is { } n && n.Length > 0 && n[0] == 'a' { n } else { \"anonymous\" }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: `{ }` over a `Nullable<T>` receiver is the native
    // non-nil test that binds the unwrapped value.
    @Fact
    func NullableValueTypeReceiver_UsesNativePatternVariable() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public int? Value { get; set; }

        public int Doubled => Value is { } v && v > 0 ? v * 2 : -1;
    }
}`)
        Assert.Contains("if Value is { } v && v > 0 { v * 2 } else { -1 }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    @Fact
    func SideEffectingReceiver_IsEmittedExactlyOnce() {
        let printed = TranslateUnit(`
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
            return "x";
        }

        public string Read() => Next() is { } s ? s : "none";
    }
}`)
        // ADR-0166 / issue #3409: a native `is` pattern evaluates its receiver
        // exactly once by construction, so the side-effecting receiver needs no
        // spill temp to be single-evaluated — one declaration, one call site.
        Assert.Contains("if Next() is { } s { s } else { \"none\" }", printed, StringComparison.Ordinal)
        Assert.Equal(2, printed.Split("Next()").Length - 1)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: each conditional becomes its own native
    // if-expression; the inner one nests inside the outer else arm.
    @Fact
    func NestedConditional_InElseArm_AlsoUsesNativePatternVariable() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? A() => null;

        public string? B() => null;

        public string Pick() => A() is { } a ? a : (B() is { } b ? b : "none");
    }
}`)
        Assert.Contains("if A() is { } a { a } else {", printed, StringComparison.Ordinal)
        Assert.Contains("if B() is { } b { b } else { \"none\" }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    @Fact
    func NullArm_StaysAsDefaultOfTheNullableResultType() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string? First() => Find() is { } n && n.Length > 0 ? n : null;
    }
}`)
        // ADR-0166 / issue #3409: native pattern variable; the `null` arm is
        // still `default` of the nullable result type.
        Assert.Contains("if Find() is { } n && n.Length > 0 { n }", printed, StringComparison.Ordinal)
        Assert.Contains("else { default(string?) }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: the native if-expression must compile and run
    // under gsc end to end, exactly as the `if let` lowering did.
    @Fact
    func TranslatedNativePatternVariable_CompilesAndRunsUnderGsc() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains(
            "if Copyrights is { } c && c.Length > 0 { c[0] } else { default(string?) }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        CompileAndRun(printed, "Package().Copyright()")
    }

    // ADR-0166 / issue #3409: the packed tool emits the native pattern
    // variable, and the same-version packed SDK must compile it.
    @Fact
    func Issue2819_SameVersionPackedToolAndSdk_CompileTranslatedPatternVariable() {
        let repoRoot = GsharpTestProjectRunner.FindRepoRoot()!!
        let cs2gs = ResolveLocalCs2GsPackage(repoRoot)
        Assert.NotNull(cs2gs)
        let sdkPackage = Path.Combine(
            Path.GetDirectoryName(cs2gs!!.NupkgPath)!!,
            "Gsharp.NET.Sdk." + cs2gs!!.Version + ".nupkg"
        )
        Assert.True(
            File.Exists(sdkPackage),
            "Building the cs2gs tool package must produce the same-version Gsharp.NET.Sdk package: " + cs2gs!!.Version
        )
        let workDir = Path.Combine(repoRoot, "issue-2819-package-smoke", Guid.NewGuid().ToString("N"))
        let feedDir = Path.Combine(workDir, "out", "bin", "Release", "nupkgs")
        let packagesDir = Path.Combine(workDir, "packages")
        let toolDir = Path.Combine(workDir, "tool")
        Directory.CreateDirectory(feedDir)
        Directory.CreateDirectory(packagesDir)
        Directory.CreateDirectory(toolDir)
        GsharpTestProjectRunner.WriteIsolationBoundary(workDir)
        File.WriteAllText(Path.Combine(workDir, "GSharp.sln"), string.Empty)
        let packedTool = Path.Combine(feedDir, Path.GetFileName(cs2gs!!.NupkgPath))
        let packedSdk = Path.Combine(feedDir, Path.GetFileName(sdkPackage))
        File.Copy(cs2gs!!.NupkgPath, packedTool)
        File.Copy(sdkPackage, packedSdk)
        let nugetConfig = Path.Combine(workDir, "nuget.config")
        File.WriteAllText(nugetConfig, (`<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="issue-2819-packages" value="` + "${SecurityElement.Escape(feedDir)}" + `" />
  </packageSources>
  <config>
    <add key="globalPackagesFolder" value="` + "${SecurityElement.Escape(packagesDir)}" + `" />
  </config>
</configuration>`))
        let sdkExtractDir = Path.Combine(workDir, "sdk")
        ZipFile.ExtractToDirectory(packedSdk, sdkExtractDir)
        let packedGsc = Path.Combine(sdkExtractDir, "tools", "compiler", "gsc.dll")
        Assert.True(File.Exists(packedGsc), "Packed SDK must contain tools/compiler/gsc.dll.")
        let sourceDir = Path.Combine(workDir, "source")
        let translatedDir = Path.Combine(workDir, "translated")
        let artifactsDir = Path.Combine(workDir, "artifacts")
        Directory.CreateDirectory(sourceDir)
        File.WriteAllText(Path.Combine(sourceDir, "Repro.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(sourceDir, "Repro.cs"), `
#nullable enable
namespace Demo
{
    public class C
    {
        public string[]? G() => null;

        public string? Value() =>
            G() is { } values && values.Length > 0 ? values[0] : null;
    }
}`)
        let environment = Dictionary[string, string]{
            ["DOTNET_CLI_HOME"] = Path.Combine(workDir, ".dotnet"),
            ["GSHARP_SKIP_ILVERIFY"] = "1",
            ["NUGET_PACKAGES"] = packagesDir
        }
        Directory.CreateDirectory(environment["DOTNET_CLI_HOME"])
        let install = RunProcess(
            "dotnet",
            []string{
                "tool",
                "install",
                "Gsharp.Cs2Gs",
                "--tool-path",
                toolDir,
                "--version",
                cs2gs!!.Version,
                "--configfile",
                nugetConfig
            },
            workDir,
            environment
        )
        Assert.True(install.Exit == 0, "Installing exact cs2gs nupkg failed:\n" + install.Output)
        let cs2gsCommand = Path.Combine(
            toolDir,
            if OperatingSystem.IsWindows() {
                "cs2gs.exe"
            } else {
                "cs2gs"
            }
        )
        Assert.True(File.Exists(cs2gsCommand), "Installed cs2gs command was not found: " + cs2gsCommand)
        let migration = RunProcess(
            cs2gsCommand,
            []string{
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
                packedGsc
            },
            workDir,
            environment
        )
        Assert.True(migration.Exit == 0, "Packed cs2gs migration failed:\n" + migration.Output)
        let translatedSource = Path.Combine(translatedDir, "Repro.gs")
        Assert.True(File.Exists(translatedSource), "Packed cs2gs did not emit Repro.gs.")
        Assert.Contains(
            "if G() is {} values && values.Length > 0 {",
            File.ReadAllText(translatedSource),
            StringComparison.Ordinal
        )
        let translatedProject = Path.Combine(translatedDir, "Repro.gsproj")
        Assert.True(File.Exists(translatedProject), "Packed cs2gs did not emit Repro.gsproj.")
        Assert.Contains(
            "Gsharp.NET.Sdk/" + cs2gs!!.Version,
            File.ReadAllText(translatedProject),
            StringComparison.Ordinal
        )
        let build = RunProcess(
            "dotnet",
            []string{
                "build",
                translatedProject,
                "-c",
                "Release",
                "--nologo",
                "-p:RestoreConfigFile=" + nugetConfig,
                "-p:RestorePackagesPath=" + packagesDir,
                "-p:RestoreNoCache=true"
            },
            translatedDir,
            environment
        )
        Assert.True(build.Exit == 0, "Exact same-version packed SDK must compile packed cs2gs output:\n" + build.Output)
        Directory.Delete(workDir, recursive: true)
    }

    // ADR-0166 / issue #3409: `recv is T t` is a native declaration pattern —
    // no `as T` testing initializer, no `if let`.
    @Fact
    func TypedDeclarationPattern_UsesNativePatternVariable() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public object? Find() => null;

        public string Name => Find() is string s ? s : "anonymous";
    }
}`)
        Assert.Contains("if Find() is string s { s } else { \"anonymous\" }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("as string", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: a designated property pattern is emitted
    // verbatim — the member test rides in the pattern, not in a guard.
    @Fact
    func PropertySubpattern_TranslatesVerbatim() {
        // `is { Length: > 0 } s` adds a member test to the null check.
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string? Find() => null;

        public string Name => Find() is { Length: > 0 } s ? s : "anonymous";
    }
}`)
        Assert.Contains(
            "if Find() is { Length: > 0 } s { s } else { \"anonymous\" }",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    // ADR-0166 / issue #3409: gsc rejects a non-nullable `if let` initializer
    // (GS0296), which used to force a scoped `let n = Find()` local; the native
    // `{ }` pattern is a plain non-nil test accepted over any input type, so
    // the author's binder survives verbatim.
    @Fact
    func NonNullableReceiver_UsesNativePatternVariable() {
        let printed = TranslateUnit(`
#nullable enable
using System;
namespace Demo
{
    public class C
    {
        public string Find() => "x";

        public string Name => Find() is { } n ? n : "anonymous";
    }
}`)
        Assert.Contains("if Find() is { } n { n } else { \"anonymous\" }", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("let n = Find()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
    }

    // ── Conservative fallbacks ───────────────────────────────────────────
    @Fact
    func ReassignedBinder_KeepsTheSpillBasedFallback() {
        // G# `let` is immutable, so a C# binder that is written to (here
        // through a `ref` argument) cannot become an `if let` binding.
        let printed = TranslateUnit(`
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

        public string Name() => Find() is { } n && Reassign(ref n) ? n : "anonymous";
    }
}`, "Reassigned pattern binders currently keep a spill fallback that cannot declare the mutable designator in G#.")
        Assert.DoesNotContain("if let n =", printed, StringComparison.Ordinal)
    }

    @Fact
    func NestedPatternInTheTrueArm_KeepsTheSpillBasedFallback() {
        // The inner pattern hoists a spill `let` that would have to live
        // OUTSIDE the `if let`, where it would run unconditionally and could
        // not see the binding.
        let printed = TranslateUnit(`
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
            return Find() is { } n ? (Other() is { } o ? o.ToString() : n) : "anonymous";
        }
    }
}`)
        Assert.DoesNotContain("if let n =", printed, StringComparison.Ordinal)
    }

    shared {
        private func RenderExpressionForTest(expression GExpression) string {
            let unit = CompilationUnit(
                "Demo",
                members: List[GNode]{
                    MethodDeclaration(
                        "Run",
                        body: BlockStatement(
                            List[GStatement]{LocalDeclarationStatement(BindingKind.Let, "x", initializer: expression)}
                        )
                    )
                }
            )
            let printed = GSharpPrinter.Print(unit)
            let result = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Printer-only expression fixtures deliberately use undefined placeholder identifiers."
            )
            Assert.True(result.Success, "Printed G# must round-trip. Errors:\n" + string.Join("\n", result.Errors) + `

Printed:
` + printed)
            var start = printed.IndexOf("let x = ", StringComparison.Ordinal)
            Assert.True(start >= 0, "expected a `let x = <expr>` line in:\n" + printed)
            start += "let x = ".Length
            let end = printed.IndexOf('\n', start)
            return printed.Substring(start, end - start).TrimEnd()
        }

        private func TranslateUnit(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        private func ResolveLocalCs2GsPackage(repoRoot string)(NupkgPath string, Version string)? {
            let nupkgDir = Path.Combine(repoRoot, "out", "bin", "Release", "nupkgs")
            if !Directory.Exists(nupkgDir) {
                return nil
            }
            const Prefix = "Gsharp.Cs2Gs."
            const Suffix = ".nupkg"
            var best(NupkgPath string, Version string)? = nil
            for file in Directory.EnumerateFiles(nupkgDir, Prefix + "*" + Suffix) {
                let name = Path.GetFileName(file)
                let version = name.Substring(Prefix.Length, name.Length - Prefix.Length - Suffix.Length)
                if best == nil || GsharpTestProjectRunner.CompareVersions(version, best!!.Version) > 0 {
                    best = (file, version)
                }
            }
            return best
        }

        private func RunProcess(
            fileName string,
            arguments IReadOnlyList[string],
            workingDirectory string,
            environment IReadOnlyDictionary[string, string]
        )(Exit int32, Output string) {
            let psi = ProcessStartInfo(fileName){
                WorkingDirectory = workingDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                psi.ArgumentList.Add(argument)
            }
            for (name, value) in environment {
                psi.Environment[name] = value
            }
            using let process Process? = Process.Start(psi)
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(int32(TimeSpan.FromMinutes(10).TotalMilliseconds))
            if !exited {
                process!!.Kill(entireProcessTree: true)
            }
            process!!.WaitForExit()
            Task.WaitAll(stdout, stderr)
            let output = stdout.Result + stderr.Result
            Assert.True(exited, fileName + " timed out. Output:\n" + output)
            return (process!!.ExitCode, output)
        }

        private func CompileAndRun(printed string, callExpression string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "adr-0151-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, runOut) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut)
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
    }
}
