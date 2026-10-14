// <copyright file="Issue4167SelfHostedEnumPatternRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Issue #4167 (historical root #4153, umbrella #3501): one of #4153's own
/// candidate call sites, confirmed live by gate run 34370082359 --
/// `CSharpToGSharpTranslator.Types.cs`'s
/// `RequiresEnumStatementFallback` used a property pattern combining an
/// ENUM-constant sub-pattern (`TypeKind: TypeKind.Enum`) with a
/// scrutinee whose static type is the imported interface
/// `Microsoft.CodeAnalysis.ITypeSymbol` (from `GetTypeInfo().Type`)
/// -- the exact shape #4155 already fixed at four other call sites for
/// `TypeKind.Delegate`. Under gsc self-hosting this pattern silently
/// mismatches, and the resulting null `enumType` binding NRE'd at the
/// method's first use of it (`enumType.GetMembers()`).
///
/// The fix mirrors #4155 exactly: decompose the nested pattern into a plain
/// designated `is` narrowing followed by a `!=` comparison --
/// semantically identical C#, proven below to survive translation + gsc
/// compilation. Like #4155, this is a source-level workaround for historical
/// gsc issue #4153; #4167 guards cs2gs's remaining self-migration surface.
class Issue4167SelfHostedEnumPatternRegressionTests {
    @Theory
    @InlineData("kind is not (SyntaxKind.GotoCaseStatement or SyntaxKind.GotoDefaultStatement)")
    @InlineData("kind is (not (SyntaxKind.GotoCaseStatement or SyntaxKind.GotoDefaultStatement))")
    func DirectPatternGuard_CatchesParenthesizedAndNestedNot(source string) -> Assert.Matches(
        RoslynEnumDirectPattern,
        source
    )

    @Theory
    @InlineData("symbol is IParameterSymbol { RefKind: (RefKind.Out or RefKind.Ref) }")
    @InlineData("symbol is ITypeSymbol { TypeKind: not (TypeKind.Enum or TypeKind.Delegate) }")
    @InlineData("symbol is IMethodSymbol { MethodKind: (not (MethodKind.LocalFunction)) }")
    @InlineData("symbol is ITypeSymbol { SpecialType: (Microsoft.CodeAnalysis.SpecialType.System_Object) }")
    func PropertyPatternGuard_CatchesParenthesizedAndNestedNot(source string) -> Assert.Matches(
        RoslynEnumPropertyPattern,
        source
    )

    /// Translates cs2gs's own `CSharpToGSharpTranslator.Types.cs` with
    /// the production translator (exactly what self-migration does) and
    /// asserts the emitted G# no longer contains the nested-pattern shape
    /// gsc mis-evaluates (issue #4153) at `RequiresEnumStatementFallback`.
    /// This is the cheap, syntactic guard: it does not require
    /// compiling/running the emitted G# (see
    /// (cref:SelfHostedEnumTypeKindCheck_DistinguishesEnumFromNonEnumTypes)
    /// for the functional proof that the decomposed shape itself survives
    /// self-hosting), so it stays fast and catches anyone reintroducing the
    /// collapsed shape at this site.
    @Fact
    async func TranslatedOwnSource_NoLongerEmitsTheNestedEnumPatternAtRequiresEnumStatementFallback() {
        var typesGs = await TranslateOwnFile("Cs2Gs.Translator", "CSharpToGSharpTranslator.Types.cs")
        // The buggy shape combines an enum sub-pattern with the type test in
        // ONE nested pattern: `INamedTypeSymbol { TypeKind: TypeKind.Enum`.
        // The fixed call site now spells this as a separate `.TypeKind !=`
        // comparison after a plain designated `is INamedTypeSymbol enumType`,
        // so this substring must not appear anywhere in the translated file.
        const buggyShape = "INamedTypeSymbol{TypeKind:TypeKind.Enum"
        typesGs = SelfMigratedCompilerSource.Compact(typesGs)
        Assert.DoesNotContain(buggyShape, typesGs, StringComparison.Ordinal)
        // And the decomposed replacement is actually present, so this guard
        // cannot pass merely because the whole feature was deleted.
        Assert.Contains("enumType.TypeKind!=TypeKind.Enum", typesGs, StringComparison.Ordinal)
    }

    @Fact
    async func TranslatedOwnSource_UsesEqualityForRoslynEnumConstants() {
        let translated = await TranslateOwnFiles("Cs2Gs.Translator")
        let analyzerGs = translated["ObliviousNullabilityAnalyzer.cs"]
        let compact = string.Concat(analyzerGs.Where((c char) -> !char.IsWhiteSpace(c)))
        Assert.DoesNotContain("parameter.RefKindisRefKind", compact, StringComparison.Ordinal)
        Assert.Matches("parameter\\.RefKind==(?:[A-Za-z_][A-Za-z0-9_]*\\.)*RefKind\\.Out", compact)
        for source in translated.Values {
            let code = StripComments(source)
            Assert.DoesNotMatch(RoslynEnumPropertyPattern, code)
            Assert.DoesNotMatch(RoslynEnumDirectPattern, code)
        }
        let cs2gsRoot string? = TestFixtureSource.Resolve("tools", "cs2gs")
        var scannedSources = 0
        for projectDirectory in Directory.EnumerateDirectories(cs2gsRoot!!, "Cs2Gs.*") {
            if projectDirectory.EndsWith(".Tests", StringComparison.Ordinal) {
                continue
            }
            for sourcePath in Directory.EnumerateFiles(
                projectDirectory,
                if SelfMigratedCompilerSource.IsGSharp {
                    "*.gs"
                } else {
                    "*.cs"
                },
                SearchOption.AllDirectories
            ) {
                // Build output (obj/**/GeneratedAssemblyInfo.cs, ...) is not a
                // committed source and must not satisfy the non-empty check.
                if CommittedCompilerSource.IsBuildOutput(projectDirectory, sourcePath) {
                    continue
                }
                let code = StripComments(File.ReadAllText(sourcePath))
                Assert.DoesNotMatch(RoslynEnumPropertyPattern, code)
                Assert.DoesNotMatch(RoslynEnumDirectPattern, code)
                scannedSources++
            }
        }
        // Issue #4656: a `*.cs` glob over a tree with no C# would check nothing.
        Assert.True(scannedSources > 0, "no committed cs2gs sources were scanned under " + cs2gsRoot)
        let invocationsGs = translated["CSharpToGSharpTranslator.Invocations.cs"]
        let compactInvocations = string.Concat(invocationsGs.Where((c char) -> !char.IsWhiteSpace(c)))
        Assert.Matches("local\\.RefKind!=(?:[A-Za-z_][A-Za-z0-9_]*\\.)*RefKind\\.None", compactInvocations)
        Assert.Matches("parameter\\.RefKind==(?:[A-Za-z_][A-Za-z0-9_]*\\.)*RefKind\\.In", compactInvocations)
        Assert.Matches(
            "valueType(?:!!)?\\.TypeKind==(?:[A-Za-z_][A-Za-z0-9_]*\\.)*TypeKind\\.Struct",
            compactInvocations
        )
        let statementsGs = translated["CSharpToGSharpTranslator.Statements.cs"]
        let compactStatements = string.Concat(statementsGs.Where((c char) -> !char.IsWhiteSpace(c)))
        Assert.Matches("localSymbol\\.RefKind==(?:[A-Za-z_][A-Za-z0-9_]*\\.)*RefKind\\.RefReadOnly", compactStatements)
    }

    /// The functional proof that the WORKAROUND SHAPE actually works under
    /// self-hosting, complementing
    /// (cref:TranslatedOwnSource_NoLongerEmitsTheNestedEnumPatternAtRequiresEnumStatementFallback)
    /// (which is the test that discriminates THIS PR's fix -- reverting the
    /// production hunk turns that one red; this one does not move, by
    /// design, see below).
    ///
    /// This is a DECOMPOSED port of just the pattern
    /// `RequiresEnumStatementFallback` uses to narrow
    /// `GetTypeInfo().Type` to an enum -- kept in sync BY HAND with the
    /// fixed shape in `CSharpToGSharpTranslator.Types.cs` (not
    /// dynamically translated: that file's `DeclarationVisitor` is a
    /// partial class split across several sibling files in the same
    /// project, so there is no cheap way to translate just this one method
    /// in isolation) -- compiled by the REAL `gsc.dll` and RUN against a
    /// REAL Roslyn compilation containing both an enum type and a
    /// non-enum type. With the buggy nested-pattern shape (restore it here
    /// to see) the enum-typed symbol is not recognized as an enum -- even
    /// though the same C# compiled natively with `csc` and run
    /// in-process gets it right (this bug only manifests under gsc
    /// self-hosting, so a native C# unit test of this file cannot see it).
    /// Because this source is a hand-kept mirror rather than a translation of
    /// `CSharpToGSharpTranslator.Types.cs`, reverting THIS PR's
    /// production hunk does NOT turn this test red by itself -- it always
    /// compiles and runs the already-decomposed mirror. Its value is proving
    /// the decomposed shape genuinely survives self-hosting (not merely
    /// "looks different"), which the shape-only guard above cannot show on
    /// its own.
    @Fact
    func SelfHostedEnumTypeKindCheck_DistinguishesEnumFromNonEnumTypes() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4167SelfHostedEnumPatternRegressionTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(workDir)
        try {
            let gsPath = Path.Combine(workDir, "Detect.gs")
            let dllPath = Path.Combine(workDir, "Detect.dll")
            File.WriteAllText(gsPath, DetectorSource)
            let references = TrustedPlatformAssemblies().ToList()
            let arguments = StringBuilder()
                .Append('"')
                .Append(compiler)
                .Append('"')
                .Append(" /target:exe /targetframework:net10.0 /nowarn:GS9100")
                .Append(" /out:\"")
                .Append(dllPath)
                .Append('"')
            for reference in references {
                arguments.Append(" /reference:\"").Append(reference).Append('"')
            }
            arguments.Append(" \"").Append(gsPath).Append('"')
            let (compileExit, compileOutput) = RunDotnet(arguments.ToString())
            Assert.True(compileExit == 0, "gsc must compile the self-hosted detector. Output:\n" + compileOutput)
            // `dotnet <dll>` probes the entry assembly's own directory, not
            // the TPA closure `gsc` compiled against, so the compiled program
            // cannot resolve Microsoft.CodeAnalysis(.CSharp) at run time
            // unless a copy sits next to it.
            for reference in references {
                let simpleName = Path.GetFileNameWithoutExtension(reference)
                if simpleName.StartsWith("Microsoft.CodeAnalysis", StringComparison.Ordinal) {
                    File.Copy(reference, Path.Combine(workDir, Path.GetFileName(reference)), overwrite: true)
                }
            }
            let (runExit, output) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "the self-hosted detector must run cleanly. Output:\n" + output)
            // The enum-typed symbol must be recognized as an enum, and the
            // non-enum (class) symbol must not be.
            Assert.Contains("SampleStatus=True", output, StringComparison.Ordinal)
            Assert.Contains("SampleNonEnum=False", output, StringComparison.Ordinal)
        } finally {
            TryDelete(workDir)
        }
    }

    shared {
        private const RoslynEnumTypePattern string = "(?:RefKind|TypeKind|SymbolKind|SpecialType|MethodKind|NullableAnnotation|TypeParameterKind|Accessibility|NullableFlowState|VarianceKind|SyntaxKind|DiagnosticSeverity)"
        private let RoslynEnumPropertyPattern Regex = Regex(
            ":\\s*(?:not\\s+|\\(\\s*)*(?:[A-Za-z_]\\w*\\.)*(?:RefKind|TypeKind|SymbolKind|SpecialType|MethodKind|NullableAnnotation|TypeParameterKind|Accessibility|NullableFlowState|VarianceKind)\\.\\w+",
            RegexOptions.CultureInvariant
        )
        private let RoslynEnumDirectPattern Regex = Regex(
            "\\bis\\s+(?:(?:not)\\s+|\\(\\s*)*(?:[A-Za-z_]\\w*\\.)*$RoslynEnumTypePattern\\.\\w+",
            RegexOptions.CultureInvariant
        )

        private async func TranslateOwnFile(projectDirName string, fileName string) string {
            let translated = await TranslateOwnFiles(projectDirName, fileName)
            return translated[fileName]
        }

        private func StripComments(source string) string -> Regex.Replace(
            source,
            "/\\*.*?\\*/|//[^\\r\\n]*|#[^\\r\\n]*",
            string.Empty,
            RegexOptions.CultureInvariant | RegexOptions.Singleline
        )

        // G# translated from the committed C# until the cut-over, and the committed
        // .gs after it (#4661). Empty fileNames means every file of the project.
        private async func TranslateOwnFiles(projectDirName string, fileNames ...string) IReadOnlyDictionary[
            string,
            string
        ] {
            let files = await SelfMigratedCompilerSource.LoadAsync(
                "tools/cs2gs/" + projectDirName,
                preservePartialParts: true,
                fileNames.Select(Path.GetFileNameWithoutExtension).ToArray()
            )
            return files.ToDictionary(
                func (pair KeyValuePair[string, SelfMigratedCompilerSource.MigratedFile]) string {
                    return (pair.Key + ".cs")
                },
                (pair KeyValuePair[string, SelfMigratedCompilerSource.MigratedFile]) -> pair.Value.Text,
                StringComparer.Ordinal
            )
        }

        /// A DECOMPOSED port of the fixed `RequiresEnumStatementFallback`
        /// type narrowing (issue #4153/#4167), targeting `exe` so it can
        /// build its own subject `Compilation` at runtime (with the real
        /// `Microsoft.CodeAnalysis.CSharp` referenced via the host's TPA
        /// closure -- see (cref:TrustedPlatformAssemblies)) rather than
        /// depending on a test harness to hand one in.
        private const DetectorSource string = (`package Probe

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp

class Detector {
    shared {
        // Issue #4153/#4167: decomposed -- not a nested
        // ` + "`" + `{ TypeKind: TypeKind.Enum }` + "`" + ` pattern -- because gsc's
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
            let source = ` + "`" + `using System;
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
                }` + "`" + `
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
}`)

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let startInfo = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            // The self-hosted program reads its own reference closure back out
            // through an env var rather than a compiled-in list, so the SAME
            // TrustedPlatformAssemblies() closure used to compile it is also
            // available to it at run time (a `dotnet exec`'d app does not
            // inherit the test host's TPA).
            startInfo.Environment["DOTNET_TPA"] = string.Join(Path.PathSeparator, TrustedPlatformAssemblies())
            using let process = Process.Start(startInfo) ?? throw InvalidOperationException("failed to start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
