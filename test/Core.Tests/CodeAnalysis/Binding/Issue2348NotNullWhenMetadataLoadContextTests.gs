// <copyright file="Issue2348NotNullWhenMetadataLoadContextTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Issue #2348: an imported CLR method's `[NotNullWhen]`/`[MaybeNullWhen]`
/// narrowing was silently dropped whenever the compilation's
/// (cref:ReferenceResolver) was backed by a
/// (cref:System.Reflection.MetadataLoadContext) — the exact resolver kind
/// `gsc`'s real compile paths use ((cref:ReferenceResolver.WithReferences)
/// via `CompileStage.FrameworkReferencePaths()`), as opposed to the
/// (cref:ReferenceResolver.Default) real-reflection resolver the rest of
/// this test suite's plain `Evaluate(string)` helper relies on.
///
/// Root cause: well-known primitive (cref:TypeSymbol) singletons
/// ((cref:TypeSymbol.String), (cref:TypeSymbol.Object), …) always
/// wrap the CURRENT PROCESS's real `typeof(T)` — see
/// `TypeSymbol.String = new TypeSymbol("string", typeof(string))` — while an
/// imported method's `ParameterInfo.ParameterType` reflected through a
/// `MetadataLoadContext`-backed resolver is a distinct (cref:System.Type)
/// instance denoting the identical logical type.
/// (cref:GSharp.Core.CodeAnalysis.Binding.ConversionClassifier)'s
/// `NeedsBindClrParameterConversion` compared these two (cref:System.Type)
/// values with raw reference (in)equality, so it spuriously decided a conversion
/// was required for every argument whose static type resolves to one of these
/// singletons. That spurious conversion wraps the argument in a
/// `BoundConversionExpression`, which defeats the narrowing classifiers'
/// bare-`BoundVariableExpression` match and silently drops flow narrowing —
/// for EVERY imported-CLR-method boolean guard compiled this way, not merely
/// "after a prior conditional assignment join" as the issue title suggests.
///
/// The fix reuses the codebase's existing cross-(cref:ReferenceResolver)
/// type-identity helper (`ClrTypeUtilities.AreSame`/`IsSameAs`, already
/// relied on by `ClrOverloadResolution.ClassifyImplicit` for issue #835) instead
/// of the raw (cref:System.Type) reference comparison.
open class Issue2348NotNullWhenMetadataLoadContextTests {
    @Fact
    func MetadataLoadContext_SimpleGuard_NarrowsThenArm() {
        // The simplest possible repro: no preceding conditional assignment at
        // all. Confirms the defect (and fix) are NOT specific to "after a
        // prior conditional assignment join" — a bare top-level guard was
        // equally broken under a MetadataLoadContext-backed resolver.
        let result = EvaluateBindOnlyWithMlc(`
var asin string? = "abc"

if !String.IsNullOrWhiteSpace(asin) {
    var len = asin.Length
}
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_SimpleGuard_TruePolarity_NarrowsElseArm() {
        // Opposite polarity: a bare (non-negated) [NotNullWhen(false)] call
        // narrows the ELSE arm.
        let result = EvaluateBindOnlyWithMlc(`
var asin string? = "abc"

if String.IsNullOrWhiteSpace(asin) {
} else {
    var len = asin.Length
}
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_GuardedArgumentPassedToNonNullableParameter() {
        // Matches the exact Oahu.Diagnostics DatabaseKeyLookup.LookupKey(asin,
        // dbPath) shape: a narrowed nullable local is passed by value to a
        // same-compilation function whose parameter is declared non-nullable.
        let result = EvaluateBindOnlyWithMlc(`
func lookup(a string) int32 {
    return a.Length
}

var asin string? = "abc"

if !String.IsNullOrWhiteSpace(asin) {
    var r = lookup(asin)
}
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_ParameterShadowedByLocal_TopLevelFunctions() {
        // Matches cs2gs's actual translation shape for a reassigned C#
        // parameter: G# parameters are read-only, so cs2gs shadows a
        // reassigned parameter with `var asin = asin` before narrowing it.
        let result = EvaluateBindOnlyWithMlc(`
func extractAsin(filePath string) string? {
    return nil
}

func lookupKey(asin string, dbPath string?) int32 {
    return asin.Length
}

func run(filePath string, key string?, iv string?, asin string?, dbPath string?) int32 {
    var key = key
    var iv = iv
    var asin = asin

    if String.IsNullOrWhiteSpace(key) || String.IsNullOrWhiteSpace(iv) {
        if String.IsNullOrWhiteSpace(asin) {
            asin = extractAsin(filePath)
        }

        if !String.IsNullOrWhiteSpace(asin) {
            var r = lookupKey(asin, dbPath)
        } else {
            return -1
        }
    }

    return 0
}

run("x", nil, nil, nil, nil)
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_ExactDiagnosticRunnerShape_ClassMethodCrossClassStaticCall() {
        // Reproduces the exact cs2gs-translated Oahu.Diagnostics shape from
        // issue #2348: a class instance method shadows a reassigned
        // parameter with a same-named local, then guards it with a negated
        // imported `[NotNullWhen(false)]` call before passing it to another
        // class's `shared` (static) method — the real
        // DiagnosticRunner.RunExport -> DatabaseKeyLookup.LookupKey call
        // chain that produced GS0156 ("Cannot convert type 'string?' to
        // 'string'") at the real translated call site.
        let result = EvaluateBindOnlyWithMlc(`
data class Check(Id string) {
}

class Helper {
    shared {
        func LookupKey(asin string, dbPath string?) (Check, string?, string?) {
            return (Check("x"), nil, nil)
        }
    }
}

class Runner {
    func RunExport(filePath string, key string?, iv string?, asin string?, dbPath string?) int32 {
        var key = key
        var iv = iv
        var asin = asin

        if String.IsNullOrWhiteSpace(key) || String.IsNullOrWhiteSpace(iv) {
            if String.IsNullOrWhiteSpace(asin) {
                asin = Runner.ExtractAsinFromFilename(filePath)
            }

            if !String.IsNullOrWhiteSpace(asin) {
                let (dbCheck, dbKey, dbIv) = Helper.LookupKey(asin, dbPath)
                key ??= dbKey
                iv ??= dbIv
            } else {
                return -1
            }
        }

        return 0
    }

    shared {
        private func ExtractAsinFromFilename(filePath string) string? {
            return nil
        }
    }
}

var r = Runner()
r.RunExport("x", nil, nil, nil, nil)
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_LoopReassignment_NarrowsAfterGuard() {
        // Generalization across loops: the narrowed variable is reassigned
        // inside a while-loop body prior to the guard, exercising the
        // flow-join across the loop back-edge under a MetadataLoadContext
        // resolver.
        let result = EvaluateBindOnlyWithMlc(`
func next() string? {
    return nil
}

var asin string? = nil
var i int32 = 0
while i < 3 {
    asin = next()
    i = i + 1
}

if !String.IsNullOrWhiteSpace(asin) {
    var len = asin.Length
}
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_MaybeNullWhenFalse_WidensElseArm() {
        // [MaybeNullWhen(false)] imported contract: Dictionary<K,V>.TryGetValue's
        // `out value` is only proven non-null in the true-arm; the else-arm
        // must still see `value` as nullable — must hold uniformly under a
        // MetadataLoadContext resolver, not just Default() reflection.
        let result = EvaluateBindOnlyWithMlc(`
import System.Collections.Generic

var dict = Dictionary[string, string]()
dict["key"] = "hello"
var value = ""
if dict.TryGetValue("key", &value) {
    var len = value.Length
}
`)
        Assert.Empty(result)
    }

    @Fact
    func MetadataLoadContext_UserDeclaredNotNullWhen_StillNarrows() {
        // Issue #178 control: a same-compilation (source-declared)
        // [NotNullWhen] contract does not route through the imported-CLR
        // ConversionClassifier path at all (no ClrType comparison is
        // involved), so it must be unaffected both before and after this
        // fix — confirms the fix did not accidentally rely on breaking user
        // contracts, and that #178 coverage holds under an MLC resolver too.
        let result = EvaluateBindOnlyWithMlc(`
import System.Diagnostics.CodeAnalysis

func tryFetch(@NotNullWhen(true) s string?) bool {
    return s != nil
}

var asin string? = "abc"
if tryFetch(asin) {
    var len = asin.Length
}
`)
        Assert.Empty(result)
    }

    shared {
        /// Binds (but deliberately does NOT execute) [`source`](paramref)
        /// against a (cref:ReferenceResolver.WithReferences) resolver
        /// backed by a real (cref:System.Reflection.MetadataLoadContext) —
        /// the same resolver kind `gsc`'s real compile paths use. Execution
        /// is intentionally skipped: methods reflected through a
        /// (cref:System.Reflection.MetadataLoadContext) cannot be invoked
        /// (.NET throws `InvalidOperationException`: "Cannot invoke a method
        /// on objects loaded by a MetadataLoadContext"), and `gsc`'s real
        /// pipeline never tree-interprets its own compiled program either — it
        /// binds/emits IL and the resulting assembly is executed separately, with
        /// ordinary real reflection. Bind-time diagnostics are exactly what these
        /// regression tests need to observe.
        private func EvaluateBindOnlyWithMlc(source string) ImmutableArray[Diagnostic] {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            let refPaths = Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            let references = ReferenceResolver.WithReferences(refPaths)
            let syntaxTree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, syntaxTree)
            let parseDiagnostics = compilation.SyntaxTrees.SelectMany(
                func (st SyntaxTree) IEnumerable[Diagnostic] {
                    return st.Diagnostics
                }
            )
            let diagnostics = parseDiagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToImmutableArray()
            return diagnostics
        }
    }
}
