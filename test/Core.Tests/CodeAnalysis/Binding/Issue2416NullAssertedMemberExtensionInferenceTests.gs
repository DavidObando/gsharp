// <copyright file="Issue2416NullAssertedMemberExtensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Binding
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System.Collections.Generic

/// Regression tests for issue #2416: after #2414 fixed cross-package
/// SOURCE-declared extension visibility, a generic extension declared over
/// an imported CLR generic interface parameter (e.g. `func (e
/// IEnumerable[T]?) IsNullOrEmpty[T]() bool`, mirroring
/// Oahu.Foundation's real declaration) still failed with `GS0159`
/// ("Cannot find function") whenever the call-site receiver was a
/// same-compilation, SOURCE-defined element type reached through a
/// slice/array-typed member access — regardless of whether that member
/// access was preceded by a null assertion (`x!!.Member.Call()`), was
/// a bare chain (`x.Member.Call()`), or was a for-loop element.
///
/// <b>Root cause</b>: (cref:Binder.InferTypeArguments)'s handling of
/// an `ImportedTypeSymbol` parameter constructed over an in-scope type
/// parameter (the `IEnumerable[T]` case, #313) only unified a
/// slice/array argument by REFLECTING over the argument's `ClrType`
/// ((cref:TypeSymbol.ClrType)) to find a matching
/// `IEnumerable<T>`-shaped interface (#611). A slice/array whose
/// element is a SOURCE type (a G# `class`/`struct` not yet
/// emitted) has no `ClrType` at bind time — see
/// `StructSymbol`/`TypeSymbol.ClrType` — so that reflection-based
/// lookup silently produced nothing and the type parameter was never
/// inferred, independent of any null assertion in the receiver chain.
///
/// <b>Fix</b>: (cref:Binder.InferTypeArguments) now also unifies
/// symbolically — using the slice/array's own `ElementType` directly,
/// no `ClrType` required — whenever the parameter's open CLR
/// definition is one of the fixed set of single-type-parameter interfaces
/// every CLR single-dimensional array unconditionally implements
/// (`IEnumerable<T>`, `ICollection<T>`,
/// `IList<T>`, `IReadOnlyCollection<T>`,
/// `IReadOnlyList<T>`). This is a general fix to the shared
/// type-argument substitution routine used by every generic call/extension
/// site — it does not special-case `IsNullOrEmpty` or null assertions
/// in any way, and null-assertion/member-access nullability semantics are
/// unchanged (the underlying-type computation in
/// `BoundUnaryOperator.Bind` for `!!` is untouched).
open class Issue2416NullAssertedMemberExtensionInferenceTests {
    @Fact
    func Control_DirectNullAssertedReceiver_Generic_Resolves() {
        // Baseline control from the issue: `x!!.IsNullOrEmpty()` already
        // resolved before this fix (the receiver IS the `IEnumerable[T]`
        // argument directly, no member access involved).
        let diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + "\nfunc Direct(source IEnumerable[Chapter]?) bool { return source!!.IsNullOrEmpty() }"
        )
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func Control_BareMemberAccess_NoNullAssertion_ArrayOfSourceStruct_Resolves() {
        // The equivalent "bare Member.IsNullOrEmpty()" control from the
        // issue: no null assertion anywhere in the chain. Pre-fix this
        // failed too (the array/ClrType gap is unconditional), so this also
        // regression-covers that this control genuinely resolves now.
        let diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + "\nfunc Bare(ch Chapter) bool { return ch.Chapters.IsNullOrEmpty() }"
        )
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func Broken_NullAssertedReceiver_ThenMemberAccess_ArrayOfSourceStruct_Resolves() {
        // The exact reported broken shape: `x!!.Member.IsNullOrEmpty()`.
        let diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + "\nfunc Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }"
        )
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func Broken_NullAssertedReceiver_ThenForLoopElement_NestedMemberChain_Resolves() {
        // Mirrors BookLibrary.gs's AddChapters loop: `for ch in
        // source!!.Chapters { if !ch.Chapters.IsNullOrEmpty() { ... } }` —
        // both a null-asserted-then-member receiver AND a for-loop element
        // reaching a second, nested member chain.
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, ChapterModelSource + `
func Nested(source ChapterInfo?) bool {
    for ch in source!!.Chapters {
        if !ch.Chapters.IsNullOrEmpty() {
            return true
        }
    }
    return false
}`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func NullableMemberType_NullAssertedReceiver_ThenMemberAccess_Resolves() {
        // The member itself is nullable (`[]Chapter?`), not just the outer
        // receiver — covers nullable member types distinctly from the
        // non-nullable `[]Chapter` member covered above.
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, `package Core
class Chapter {
    prop Title string
    prop Chapters []Chapter?
}
func Chained(ch Chapter?) bool { return ch!!.Chapters.IsNullOrEmpty() }`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func FieldMember_NullAssertedReceiver_ThenMemberAccess_Resolves() {
        // A field (`var`) rather than an auto-property (`prop`).
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, `package Core
class Chapter {
    var Title string
    var Chapters []Chapter
}
func Chained(ch Chapter?) bool { return ch!!.Chapters.IsNullOrEmpty() }`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func MethodReturnMember_NullAssertedReceiver_ThenMemberAccess_Resolves() {
        // The chain's array-typed step is a METHOD CALL return value, not a
        // field/property.
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, ChapterModelSource + `
class Holder {
    prop Info ChapterInfo
    func GetChapters() []Chapter { return this.Info.Chapters }
}
func Chained(h Holder?) bool { return h!!.GetChapters().IsNullOrEmpty() }`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func IndexerMember_NullAssertedReceiver_ThenMemberAccess_Resolves() {
        // The chain's array-typed step is reached through a Dictionary
        // INDEXER, not a plain field/property/method-return.
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, `package Core
import System.Collections.Generic
class Chapter {
    prop Title string
    prop Chapters []Chapter
}
class ChapterInfo {
    prop Chapters []Chapter
}
class Holder {
    prop Map Dictionary[string, []Chapter]
}
func Chained(h Holder?) bool { return h!!.Map["k"].IsNullOrEmpty() }`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func NestedTwoLevelMemberChain_NullAssertedReceiver_Resolves() {
        // `a!!.B.C.IsNullOrEmpty()` — two member-access hops after the null
        // assertion before reaching the array-typed member.
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, ChapterModelSource + `
class Wrapper {
    prop Info ChapterInfo
}
func Chained(w Wrapper?) bool { return w!!.Info.Chapters.IsNullOrEmpty() }`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func NonGenericExtension_NullAssertedReceiver_ThenMemberAccess_Resolves() {
        // A NON-generic extension declared directly over the slice type
        // (no type parameter at all) must keep working — proves the fix to
        // the generic-inference routine doesn't regress (or accidentally
        // depend on) the non-generic extension-lookup path.
        let diagnostics = BindAndReturnAllDiagnostics(
            "package Foundation\nfunc (e []?Core.Chapter) IsNullOrEmpty() bool { return e == nil || e!!.Length == 0 }",
            ChapterModelSource + "\nfunc Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }"
        )
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func ImportedReceiver_CrossAssembly_NullAssertedReceiver_ThenMemberAccess_Resolves() {
        // Source vs imported receivers: the extension itself comes from a
        // genuinely separately-compiled CLR assembly (reflection-only via
        // MetadataLoadContext), reached through `import Lib2416`, exactly
        // mirroring how Oahu.Core consumes Oahu.Foundation's extension when
        // Foundation is referenced as a prebuilt assembly rather than
        // translated G# source. The receiver's element type (`Chapter`) is
        // still a same-compilation SOURCE type.
        let diagnostics = BindImported(`package App
import Lib2416

class Chapter {
    prop Title string
    prop Chapters []Chapter
}
class ChapterInfo {
    prop Chapters []Chapter
}
func Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }`)
        Assert.DoesNotContain(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
    }

    @Fact
    func Negative_InvalidReceiver_NotSequenceCompatible_StillReportsCannotFindFunction() {
        // Invalid-receiver negative: the member's type is a plain
        // non-sequence struct (no slice/array, no IEnumerable[T] shape at
        // all). The fix must NOT broaden acceptance to non-array/slice
        // receivers — this must keep failing with GS0159.
        let diagnostics = BindAndReturnAllDiagnostics(GenericSourceExtension, `package Core
class Holder {
    prop Value int32
}
func Chained(h Holder?) bool { return h!!.Value.IsNullOrEmpty() }`)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func Negative_AmbiguousExtensionOverloads_ThroughNullAssertedMemberChain_StillReportsAmbiguity() {
        // Ambiguity negative: the SAME package declares two independently
        // applicable generic extension overloads for the same simple name
        // over two UNRELATED array-compatible interfaces
        // (ICollection[T]?/IReadOnlyCollection[T]? — neither extends the
        // other, so there is no legitimate "more specific" winner). Both
        // are only reachable for a same-compilation slice-of-source-struct
        // argument BECAUSE of the #2416 fix (previously neither's
        // ClrType-based fallback matched at all, so this shape never even
        // got far enough to be ambiguous). Reaching the receiver through a
        // null-asserted member chain must still surface a genuine ambiguity
        // (GS0266) rather than silently picking one of the two tied
        // candidates.
        let diagnostics = BindAndReturnAllDiagnostics(`package Foundation
import System.Collections.Generic
func (e ICollection[T]?) IsNullOrEmpty[T]() bool { return e == nil || e!!.Count == 0 }
func (e IReadOnlyCollection[T]?) IsNullOrEmpty[T]() bool { return e == nil || e!!.Count == 0 }`, ChapterModelSource +
                "\nfunc Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }")
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0266")
    }

    shared {
        private let ImportedLibraryPath string = EmitCSharpLibrary()

        // ---- Faithful Oahu BookLibrary/Chapter shape -------------------------
        private const ChapterModelSource string = `package Core
import System.Collections.Generic

class Chapter {
    prop Title string
    prop Chapters []Chapter
}
class ChapterInfo {
    prop Chapters []Chapter
}`

        private const GenericSourceExtension string = `package Foundation
import System.Collections.Generic
import System.Linq
func (e IEnumerable[T]?) IsNullOrEmpty[T]() bool { return e == nil || e!!.Count() == 0 }`

        private func BindAndReturnAllDiagnostics(sources ...string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            let scope_ = BindSource(sources)
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(scope_)
            return scope_.Diagnostics.Concat(program.Diagnostics).ToList()
        }

        private func BindSource(sources ...string) BoundGlobalScope {
            let trees = sources.Select((s string) -> GsSyntaxTree.Parse(SourceText.From(s))).ToImmutableArray()
            return GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(previous: nil, trees)
        }

        private func BindImported(source string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{ImportedLibraryPath})
            let tree = GsSyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(resolver, tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList()
        }

        private func EmitCSharpLibrary() string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2416Binding")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib2416.dll")
            const csharpSource = `#nullable enable
using System.Collections.Generic;
using System.Linq;

namespace Lib2416
{
    public static class ExtensionsVarious
    {
        public static bool IsNullOrEmpty<T>(this IEnumerable<T>? source)
        {
            return source == null || !source.Any();
        }
    }
}`
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Lib2416",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
