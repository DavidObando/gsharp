// <copyright file="Issue4045SelfHostedPatternMatchRegressionTests.cs" company="GSharp">
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
import System.Threading.Tasks
import Xunit

/// Issue #4045 follow-up (tracked by #4127/#4129, umbrella #3501): PR #4110
/// preserved nominal delegate identity at declaration/expression sites, but
/// three of its own regression tests — `Issue3841DelegateOverloadSetTranslationTests`
/// and `Issue4045CompilerTestsParityRegressionTests` — still failed
/// under the self-migration gate (gate run 34300556173) even though they
/// pass when run natively as C#. The root cause is NOT a cs2gs translation
/// defect: cs2gs's own C# is a faithful, semantically correct rendering of
/// the underlying logic. It is a gsc compiler defect (filed as #4153): a
/// property pattern combining an ENUM-constant sub-pattern with a scrutinee
/// whose static type is an imported interface silently evaluates as
/// non-matching, even when the type test and every sub-property individually
/// hold. `CSharpTypeMapper.MapEventType` (issue #2835),
/// `AddIfDistinctDelegates` and `TypesEraseAlike` (issue #3841),
/// and `CSharpToGSharpTranslator.Constructors.MapParameter`'s
/// `explicitlyNamedDelegate` check all used exactly this shape
/// (`is [not] INamedTypeSymbol { TypeKind: TypeKind.Delegate, ... } name`)
/// against `Microsoft.CodeAnalysis.ITypeSymbol` — correct C#, but once
/// cs2gs translates its OWN source and gsc compiles the result (self-hosting,
/// #3501), the collision-detection set this logic builds comes back empty
/// and every explicit-delegate-identity site silently degrades to structural
/// erasure: the exact shape of all three symptoms (GS0264 overload collision,
/// a lost `Predicate<int32>` constructor parameter identity, a
/// lost `EventHandler` local identity).
///
/// The fix is a source-level rewrite of those four call sites to the
/// DECOMPOSED equivalent (a designated `is` narrowing followed by plain
/// `==`/`!=` comparisons) — semantically identical C#, proven by
/// the self-hosted regression test below to survive translation + gsc
/// compilation. It is a source-level workaround for historical gsc issue
/// #4153; follow-up #4167 guards cs2gs's remaining self-migration surface.
class Issue4045SelfHostedPatternMatchRegressionTests {
    /// Translates cs2gs's own `CSharpTypeMapper.cs` and
    /// `CSharpToGSharpTranslator.Constructors.cs` with the production
    /// translator (exactly what self-migration does) and asserts the emitted
    /// G# no longer contains the nested-pattern shape gsc mis-evaluates
    /// (issue #4153) at the four fixed call sites. This is the cheap,
    /// syntactic guard: it does not require compiling/running the emitted G#
    /// (see (cref:SelfHostedCollectIdentityCriticalDelegates_DetectsThePredicateFuncCollision)
    /// for the full functional proof), so it stays fast and catches anyone
    /// reintroducing the collapsed shape at these sites.
    @Fact
    async func TranslatedOwnSource_NoLongerEmitsTheNestedEnumPatternAtTheFixedSites() {
        let typeMapperGs = await TranslateOwnFile("Cs2Gs.Translator", "CSharpTypeMapper.cs")
        let constructorsGs = await TranslateOwnFile("Cs2Gs.Translator", "CSharpToGSharpTranslator.Constructors.cs")
        // The buggy shape combines an enum sub-pattern with the type test in
        // ONE nested pattern: `INamedTypeSymbol { TypeKind: TypeKind.Delegate`.
        // The fixed call sites now spell this as a separate `.TypeKind ==`/`!=`
        // comparison after a plain designated `is INamedTypeSymbol name`, so
        // this substring must not appear anywhere in either translated file.
        const buggyShape = "INamedTypeSymbol{TypeKind:TypeKind.Delegate"
        Assert.DoesNotContain(buggyShape, typeMapperGs, StringComparison.Ordinal)
        Assert.DoesNotContain(buggyShape, constructorsGs, StringComparison.Ordinal)
        // And the decomposed replacement is actually present, so this guard
        // cannot pass merely because the whole feature was deleted.
        Assert.Contains("leftDelegate.TypeKind!=TypeKind.Delegate", typeMapperGs, StringComparison.Ordinal)
        Assert.Contains("named.TypeKind==TypeKind.Delegate", typeMapperGs, StringComparison.Ordinal)
        Assert.Contains("namedParameterType.TypeKind==TypeKind.Delegate", constructorsGs, StringComparison.Ordinal)
    }

    /// The functional proof that the WORKAROUND SHAPE actually works under
    /// self-hosting, complementing
    /// (cref:TranslatedOwnSource_NoLongerEmitsTheNestedEnumPatternAtTheFixedSites)
    /// (which is the test that discriminates THIS PR's fix — reverting the
    /// production hunks turns that one red; this one does not move, by
    /// design, see below).
    ///
    /// This is a DECOMPOSED port of `CSharpTypeMapper`'s
    /// `CollectIdentityCriticalDelegates`/`AddIfDistinctDelegates`/
    /// `ParametersEraseAlike`/`TypesEraseAlike` (issue #3841) —
    /// kept in sync BY HAND with the fixed shape in `CSharpTypeMapper.cs`
    /// (not dynamically translated: compiling that file standalone needs its
    /// several sibling types in the same package, and there is no cheap way
    /// to translate just these four methods in isolation) — compiled by the
    /// REAL `gsc.dll` and RUN against a REAL Roslyn compilation
    /// containing the exact `Add(Predicate<int>)`/
    /// `Add(Func<int, bool>)` collision from issue #3841. With the
    /// buggy nested-pattern shape (restore it here to see) this comes back
    /// `criticalCount=0` — the collision goes undetected — even though
    /// the same C# compiled natively with `csc` and run in-process
    /// detects it correctly (see `Issue3841DelegateOverloadSetTranslationTests`,
    /// which never exercises gsc and therefore cannot see this bug). Because
    /// this source is a hand-kept mirror rather than a translation of
    /// `CSharpTypeMapper.cs`, reverting THIS PR's production hunks does
    /// NOT turn this test red by itself — it always compiles and runs the
    /// already-decomposed mirror. Its value is proving the decomposed shape
    /// genuinely survives self-hosting (not merely "looks different"), which
    /// the shape-only guard above cannot show on its own.
    @Fact
    func SelfHostedCollectIdentityCriticalDelegates_DetectsThePredicateFuncCollision() {
        let compiler string? = FindCompiler()
        Assert.True(compiler != nil, "gsc.dll must be built (build the repository solution) before running this test.")
        let workDir = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4045SelfHostedPatternMatchRegressionTests",
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
            // The collision must be detected (both distinct delegate types
            // recorded as identity-critical) and BOTH Add-overload parameter
            // types must be found to be members of that set.
            Assert.Contains("criticalCount=2", output, StringComparison.Ordinal)
            Assert.DoesNotContain("=False", output, StringComparison.Ordinal)
        } finally {
            TryDelete(workDir)
        }
    }

    shared {
        // G# translated from the committed C# until the cut-over, the committed .gs
        // after it (#4661); compacted so G# layout cannot decide the assertions.
        private async func TranslateOwnFile(projectDirName string, fileName string) string {
            let stem = Path.GetFileNameWithoutExtension(fileName)
            let files = await SelfMigratedCompilerSource.LoadAsync(
                "tools/cs2gs/" + projectDirName,
                preservePartialParts: true,
                stem
            )
            return SelfMigratedCompilerSource.Compact(files[stem].Text)
        }

        /// A DECOMPOSED port of the fixed `CSharpTypeMapper` methods (issue
        /// #3841/#4153), targeting `exe` so it can build its own subject
        /// `Compilation` at runtime (with the real
        /// `Microsoft.CodeAnalysis.CSharp` referenced via the host's TPA
        /// closure — see (cref:TrustedPlatformAssemblies)) rather than
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
        func CollectIdentityCriticalDelegates(compilation Compilation) HashSet[INamedTypeSymbol] {
            let critical = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            let pending = Stack[INamespaceOrTypeSymbol]()
            pending.Push(compilation.Assembly.GlobalNamespace)
            while pending.Count > 0 {
                let current = pending.Pop()
                for member in current.GetMembers() {
                    if (member is INamespaceOrTypeSymbol nested and (INamespaceSymbol or INamedTypeSymbol)) {
                        pending.Push(nested)
                    }
                }
                if current is INamedTypeSymbol type {
                    CollectForType(type, critical)
                }
            }
            return critical
        }

        func CollectForType(type INamedTypeSymbol, critical HashSet[INamedTypeSymbol]) {
            let byName = Dictionary[string, List[IMethodSymbol]](StringComparer.Ordinal)
            for member in type.GetMembers() {
                if member is IMethodSymbol method && method.Parameters.Length > 0 {
                    if !byName.TryGetValue(method.Name, out var bucket) {
                        bucket = List[IMethodSymbol]()
                        byName[method.Name] = bucket
                    }
                    bucket.Add(method)
                }
            }
            for overloads in byName.Values {
                if overloads.Count < 2 {
                    continue
                }
                for var i = 0; i < overloads.Count; i++ {
                    for var j = i + 1; j < overloads.Count; j++ {
                        let left = overloads[i]
                        let right = overloads[j]
                        if left.MethodKind != right.MethodKind ||
                            left.Arity != right.Arity ||
                            left.Parameters.Length != right.Parameters.Length ||
                            !ParametersEraseAlike(left, right) {
                            continue
                        }
                        for var k = 0; k < left.Parameters.Length; k++ {
                            AddIfDistinctDelegates(left.Parameters[k].Type, right.Parameters[k].Type, critical)
                        }
                    }
                }
            }
        }

        // Issue #4153: decomposed -- not a nested
        // ` + "`" + `{ TypeKind: TypeKind.Delegate }` + "`" + ` pattern -- because gsc's
        // pattern matcher does not reliably evaluate an enum
        // sub-pattern against an imported-interface-typed scrutinee.
        func AddIfDistinctDelegates(left ITypeSymbol, right ITypeSymbol, critical HashSet[INamedTypeSymbol]) {
            if SymbolEqualityComparer.Default.Equals(left, right) ||
                left is not INamedTypeSymbol leftDelegate ||
                leftDelegate.TypeKind != TypeKind.Delegate ||
                right is not INamedTypeSymbol rightDelegate ||
                rightDelegate.TypeKind != TypeKind.Delegate {
                return
            }
            critical.Add(leftDelegate)
            critical.Add(rightDelegate)
        }

        func ParametersEraseAlike(left IMethodSymbol, right IMethodSymbol) bool {
            var sawDelegateDifference = false
            for var i = 0; i < left.Parameters.Length; i++ {
                let a = left.Parameters[i]
                let b = right.Parameters[i]
                if a.RefKind != b.RefKind || a.IsParams != b.IsParams || !TypesEraseAlike(a.Type, b.Type) {
                    return false
                }
                sawDelegateDifference |= !SymbolEqualityComparer.Default.Equals(a.Type, b.Type)
            }
            return sawDelegateDifference
        }

        // Issue #4153: decomposed for the same reason as
        // AddIfDistinctDelegates above.
        func TypesEraseAlike(left ITypeSymbol, right ITypeSymbol) bool {
            if SymbolEqualityComparer.Default.Equals(left, right) {
                return true
            }
            if left is not INamedTypeSymbol leftDelegate ||
                leftDelegate.TypeKind != TypeKind.Delegate ||
                leftDelegate.DelegateInvokeMethod == nil ||
                right is not INamedTypeSymbol rightDelegate ||
                rightDelegate.TypeKind != TypeKind.Delegate ||
                rightDelegate.DelegateInvokeMethod == nil {
                return false
            }
            let leftInvoke IMethodSymbol? = leftDelegate.DelegateInvokeMethod
            let rightInvoke IMethodSymbol? = rightDelegate.DelegateInvokeMethod
            if leftInvoke!!.Parameters.Length != rightInvoke!!.Parameters.Length ||
                !TypesEraseAlike(leftInvoke!!.ReturnType, rightInvoke!!.ReturnType) {
                return false
            }
            for var i = 0; i < leftInvoke!!.Parameters.Length; i++ {
                if leftInvoke!!.Parameters[i].RefKind != rightInvoke!!.Parameters[i].RefKind ||
                    !TypesEraseAlike(leftInvoke!!.Parameters[i].Type, rightInvoke!!.Parameters[i].Type) {
                    return false
                }
            }
            return true
        }

        func Main() {
            // ADR-0012: G# raw strings are backtick-delimited, not
            // triple-double-quoted (that is C#'s form, not G#'s).
            let source = ` + "`" + `using System;
                namespace Overloads
                {
                    public sealed class ClosedDelegateOverloads
                    {
                        public string Add(Predicate<int> callback) => "pred";
                        public string Add(Func<int, bool> callback) => "func";
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
            let compilation = CSharpCompilation.Create("Overloads", trees, refs, options)
            let critical = CollectIdentityCriticalDelegates(compilation)

            for member in compilation.Assembly.GlobalNamespace.GetMembers() {
                if member is INamespaceSymbol ns {
                    for typeMember in ns.GetMembers() {
                        if typeMember is INamedTypeSymbol namedType && namedType.Name == "ClosedDelegateOverloads" {
                            var results = List[string]()
                            for m in namedType.GetMembers() {
                                if m is IMethodSymbol method && method.Name == "Add" && method.Parameters[0].Type is INamedTypeSymbol paramNamed {
                                    let inSet = critical.Contains(paramNamed)
                                    results.Add(paramNamed.ToString() + "=" + inSet.ToString())
                                }
                            }
                            Console.WriteLine("criticalCount=" + critical.Count.ToString() + " " + string.Join(",", results))
                            return
                        }
                    }
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
