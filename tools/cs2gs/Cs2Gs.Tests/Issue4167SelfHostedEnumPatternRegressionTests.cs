// <copyright file="Issue4167SelfHostedEnumPatternRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4167 (tracked by #4153, umbrella #3501): one of #4153's own
/// candidate call sites, confirmed live by gate run 34370082359 --
/// <c>CSharpToGSharpTranslator.Types.cs</c>'s
/// <c>RequiresEnumStatementFallback</c> used a property pattern combining an
/// ENUM-constant sub-pattern (<c>TypeKind: TypeKind.Enum</c>) with a
/// scrutinee whose static type is the imported interface
/// <c>Microsoft.CodeAnalysis.ITypeSymbol</c> (from <c>GetTypeInfo().Type</c>)
/// -- the exact shape #4155 already fixed at four other call sites for
/// <c>TypeKind.Delegate</c>. Under gsc self-hosting this pattern silently
/// mismatches, and the resulting null <c>enumType</c> binding NRE'd at the
/// method's first use of it (<c>enumType.GetMembers()</c>).
/// <para>
/// The fix mirrors #4155 exactly: decompose the nested pattern into a plain
/// designated <c>is</c> narrowing followed by a <c>!=</c> comparison --
/// semantically identical C#, proven below to survive translation + gsc
/// compilation. Like #4155, this is a workaround for cs2gs's own source, not
/// a fix for #4153 itself (which remains open and still tracks the ~8
/// remaining candidate call sites in this project using the same shape).
/// </para>
/// </summary>
public sealed class Issue4167SelfHostedEnumPatternRegressionTests
{
    /// <summary>
    /// Translates cs2gs's own <c>CSharpToGSharpTranslator.Types.cs</c> with
    /// the production translator (exactly what self-migration does) and
    /// asserts the emitted G# no longer contains the nested-pattern shape
    /// gsc mis-evaluates (issue #4153) at <c>RequiresEnumStatementFallback</c>.
    /// This is the cheap, syntactic guard: it does not require
    /// compiling/running the emitted G# (see
    /// <see cref="SelfHostedEnumTypeKindCheck_DistinguishesEnumFromNonEnumTypes"/>
    /// for the functional proof that the decomposed shape itself survives
    /// self-hosting), so it stays fast and catches anyone reintroducing the
    /// collapsed shape at this site.
    /// </summary>
    [Fact]
    public async Task TranslatedOwnSource_NoLongerEmitsTheNestedEnumPatternAtRequiresEnumStatementFallback()
    {
        string typesGs = await TranslateOwnFile(
            "Cs2Gs.Translator", "CSharpToGSharpTranslator.Types.cs");

        // The buggy shape combines an enum sub-pattern with the type test in
        // ONE nested pattern: `INamedTypeSymbol { TypeKind: TypeKind.Enum`.
        // The fixed call site now spells this as a separate `.TypeKind !=`
        // comparison after a plain designated `is INamedTypeSymbol enumType`,
        // so this substring must not appear anywhere in the translated file.
        const string buggyShape = "INamedTypeSymbol { TypeKind: TypeKind.Enum";
        Assert.DoesNotContain(buggyShape, typesGs, StringComparison.Ordinal);

        // And the decomposed replacement is actually present, so this guard
        // cannot pass merely because the whole feature was deleted.
        Assert.Contains("enumType.TypeKind != TypeKind.Enum", typesGs, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TranslatedOwnSource_UsesEqualityForRefKindConstants()
    {
        string analyzerGs = await TranslateOwnFile(
            "Cs2Gs.Translator", "ObliviousNullabilityAnalyzer.cs");

        string compact = string.Concat(analyzerGs.Where(c => !char.IsWhiteSpace(c)));
        Assert.DoesNotContain("parameter.RefKindisRefKind", compact, StringComparison.Ordinal);
        Assert.Matches(
            @"parameter\.RefKind==(?:[A-Za-z_][A-Za-z0-9_]*\.)*RefKind\.Out",
            compact);
    }

    private static async Task<string> TranslateOwnFile(string projectDirName, string fileName)
    {
        string projectPath = TestFixtureSource.Resolve(
            "tools", "cs2gs", projectDirName, projectDirName + ".csproj");
        LoadedCSharpProject project = await CSharpProjectLoader.LoadProjectAsync(projectPath);
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(
            project.Documents,
            d => d.FilePath.EndsWith(fileName, StringComparison.Ordinal));
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    /// <summary>
    /// The functional proof that the WORKAROUND SHAPE actually works under
    /// self-hosting, complementing
    /// <see cref="TranslatedOwnSource_NoLongerEmitsTheNestedEnumPatternAtRequiresEnumStatementFallback"/>
    /// (which is the test that discriminates THIS PR's fix -- reverting the
    /// production hunk turns that one red; this one does not move, by
    /// design, see below).
    /// <para>
    /// This is a DECOMPOSED port of just the pattern
    /// <c>RequiresEnumStatementFallback</c> uses to narrow
    /// <c>GetTypeInfo().Type</c> to an enum -- kept in sync BY HAND with the
    /// fixed shape in <c>CSharpToGSharpTranslator.Types.cs</c> (not
    /// dynamically translated: that file's <c>DeclarationVisitor</c> is a
    /// partial class split across several sibling files in the same
    /// project, so there is no cheap way to translate just this one method
    /// in isolation) -- compiled by the REAL <c>gsc.dll</c> and RUN against a
    /// REAL Roslyn compilation containing both an enum type and a
    /// non-enum type. With the buggy nested-pattern shape (restore it here
    /// to see) the enum-typed symbol is not recognized as an enum -- even
    /// though the same C# compiled natively with <c>csc</c> and run
    /// in-process gets it right (this bug only manifests under gsc
    /// self-hosting, so a native C# unit test of this file cannot see it).
    /// Because this source is a hand-kept mirror rather than a translation of
    /// <c>CSharpToGSharpTranslator.Types.cs</c>, reverting THIS PR's
    /// production hunk does NOT turn this test red by itself -- it always
    /// compiles and runs the already-decomposed mirror. Its value is proving
    /// the decomposed shape genuinely survives self-hosting (not merely
    /// "looks different"), which the shape-only guard above cannot show on
    /// its own.
    /// </para>
    /// </summary>
    [Fact]
    public void SelfHostedEnumTypeKindCheck_DistinguishesEnumFromNonEnumTypes()
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4167SelfHostedEnumPatternRegressionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Detect.gs");
            string dllPath = Path.Combine(workDir, "Detect.dll");
            File.WriteAllText(gsPath, DetectorSource);

            var references = TrustedPlatformAssemblies().ToList();
            var arguments = new StringBuilder()
                .Append('"').Append(compiler).Append('"')
                .Append(" /target:exe /targetframework:net10.0 /nowarn:GS9100")
                .Append(" /out:\"").Append(dllPath).Append('"');
            foreach (string reference in references)
            {
                arguments.Append(" /reference:\"").Append(reference).Append('"');
            }

            arguments.Append(" \"").Append(gsPath).Append('"');

            (int compileExit, string compileOutput) = RunDotnet(arguments.ToString());
            Assert.True(
                compileExit == 0,
                "gsc must compile the self-hosted detector. Output:\n" + compileOutput);

            // `dotnet <dll>` probes the entry assembly's own directory, not
            // the TPA closure `gsc` compiled against, so the compiled program
            // cannot resolve Microsoft.CodeAnalysis(.CSharp) at run time
            // unless a copy sits next to it.
            foreach (string reference in references)
            {
                string simpleName = Path.GetFileNameWithoutExtension(reference);
                if (simpleName.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal))
                {
                    File.Copy(reference, Path.Combine(workDir, Path.GetFileName(reference)), overwrite: true);
                }
            }

            (int runExit, string output) = RunDotnet($"\"{dllPath}\"");
            Assert.True(runExit == 0, "the self-hosted detector must run cleanly. Output:\n" + output);

            // The enum-typed symbol must be recognized as an enum, and the
            // non-enum (class) symbol must not be.
            Assert.Contains("SampleStatus=True", output, StringComparison.Ordinal);
            Assert.Contains("SampleNonEnum=False", output, StringComparison.Ordinal);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    /// <summary>
    /// A DECOMPOSED port of the fixed <c>RequiresEnumStatementFallback</c>
    /// type narrowing (issue #4153/#4167), targeting <c>exe</c> so it can
    /// build its own subject <c>Compilation</c> at runtime (with the real
    /// <c>Microsoft.CodeAnalysis.CSharp</c> referenced via the host's TPA
    /// closure -- see <see cref="TrustedPlatformAssemblies"/>) rather than
    /// depending on a test harness to hand one in.
    /// </summary>
    private const string DetectorSource = """
        package Probe

        import System
        import System.Collections.Generic
        import System.IO
        import System.Linq
        import Microsoft.CodeAnalysis
        import Microsoft.CodeAnalysis.CSharp

        class Detector {
            shared {
                // Issue #4153/#4167: decomposed -- not a nested
                // `{ TypeKind: TypeKind.Enum }` pattern -- because gsc's
                // pattern matcher does not reliably evaluate an enum
                // sub-pattern against an imported-interface-typed scrutinee.
                func IsEnumScrutinee(type ITypeSymbol) bool {
                    if type is not INamedTypeSymbol enumType || enumType.TypeKind != TypeKind.Enum {
                        return false
                    }
                    return true
                }

                func Main() {
                    // ADR-0012: G# raw strings are backtick-delimited, not
                    // triple-double-quoted (that is C#'s form, not G#'s).
                    let source = `using System;
                        namespace Sample
                        {
                            public enum SampleStatus
                            {
                                Ready,
                                Done,
                            }

                            public sealed class SampleNonEnum
                            {
                            }
                        }`
                    let tree = CSharpSyntaxTree.ParseText(source)
                    let refPaths = Environment.GetEnvironmentVariable("DOTNET_TPA")!!.Split(Path.PathSeparator)
                    let refs = List[MetadataReference]()
                    for p in refPaths {
                        if p.Length > 0 && File.Exists(p) {
                            refs.Add(MetadataReference.CreateFromFile(p))
                        }
                    }
                    let options = CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                    let trees = []SyntaxTree{tree}
                    let compilation = CSharpCompilation.Create("Sample", trees, refs, options)

                    for member in compilation.Assembly.GlobalNamespace.GetMembers() {
                        if member is INamespaceSymbol ns {
                            var results = List[string]()
                            for typeMember in ns.GetMembers() {
                                if typeMember is INamedTypeSymbol namedType {
                                    results.Add(namedType.Name + "=" + IsEnumScrutinee(namedType).ToString())
                                }
                            }
                            Console.WriteLine(string.Join(" ", results))
                            return
                        }
                    }
                    Console.WriteLine("not-found")
                }
            }
        }
        """;

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        // The self-hosted program reads its own reference closure back out
        // through an env var rather than a compiled-in list, so the SAME
        // TrustedPlatformAssemblies() closure used to compile it is also
        // available to it at run time (a `dotnet exec`'d app does not
        // inherit the test host's TPA).
        startInfo.Environment["DOTNET_TPA"] = string.Join(
            Path.PathSeparator, TrustedPlatformAssemblies());

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("failed to start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (string path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
