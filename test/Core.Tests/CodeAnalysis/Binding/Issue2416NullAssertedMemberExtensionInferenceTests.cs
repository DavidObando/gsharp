// <copyright file="Issue2416NullAssertedMemberExtensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #2416: after #2414 fixed cross-package
/// SOURCE-declared extension visibility, a generic extension declared over
/// an imported CLR generic interface parameter (e.g. <c>func (e
/// IEnumerable[T]?) IsNullOrEmpty[T]() bool</c>, mirroring
/// Oahu.Foundation's real declaration) still failed with <c>GS0159</c>
/// ("Cannot find function") whenever the call-site receiver was a
/// same-compilation, SOURCE-defined element type reached through a
/// slice/array-typed member access — regardless of whether that member
/// access was preceded by a null assertion (<c>x!!.Member.Call()</c>), was
/// a bare chain (<c>x.Member.Call()</c>), or was a for-loop element.
/// <para>
/// <b>Root cause</b>: <see cref="Binder.InferTypeArguments"/>'s handling of
/// an <c>ImportedTypeSymbol</c> parameter constructed over an in-scope type
/// parameter (the <c>IEnumerable[T]</c> case, #313) only unified a
/// slice/array argument by REFLECTING over the argument's <c>ClrType</c>
/// (<see cref="TypeSymbol.ClrType"/>) to find a matching
/// <c>IEnumerable&lt;T&gt;</c>-shaped interface (#611). A slice/array whose
/// element is a SOURCE type (a G# <c>class</c>/<c>struct</c> not yet
/// emitted) has no <c>ClrType</c> at bind time — see
/// <c>StructSymbol</c>/<c>TypeSymbol.ClrType</c> — so that reflection-based
/// lookup silently produced nothing and the type parameter was never
/// inferred, independent of any null assertion in the receiver chain.
/// </para>
/// <para>
/// <b>Fix</b>: <see cref="Binder.InferTypeArguments"/> now also unifies
/// symbolically — using the slice/array's own <c>ElementType</c> directly,
/// no <c>ClrType</c> required — whenever the parameter's open CLR
/// definition is one of the fixed set of single-type-parameter interfaces
/// every CLR single-dimensional array unconditionally implements
/// (<c>IEnumerable&lt;T&gt;</c>, <c>ICollection&lt;T&gt;</c>,
/// <c>IList&lt;T&gt;</c>, <c>IReadOnlyCollection&lt;T&gt;</c>,
/// <c>IReadOnlyList&lt;T&gt;</c>). This is a general fix to the shared
/// type-argument substitution routine used by every generic call/extension
/// site — it does not special-case <c>IsNullOrEmpty</c> or null assertions
/// in any way, and null-assertion/member-access nullability semantics are
/// unchanged (the underlying-type computation in
/// <c>BoundUnaryOperator.Bind</c> for <c>!!</c> is untouched).
/// </para>
/// </summary>
public class Issue2416NullAssertedMemberExtensionInferenceTests
{
    private static readonly string ImportedLibraryPath = EmitCSharpLibrary();

    // ---- Faithful Oahu BookLibrary/Chapter shape -------------------------

    private const string ChapterModelSource = """
        package Core
        class Chapter {
            prop Title string
            prop Chapters []Chapter
        }
        class ChapterInfo {
            prop Chapters []Chapter
        }
        """;

    private const string GenericSourceExtension = """
        package Foundation
        import System.Collections.Generic
        import System.Linq
        func (e IEnumerable[T]?) IsNullOrEmpty[T]() bool { return e == nil || e!!.Count() == 0 }
        """;

    [Fact]
    public void Control_DirectNullAssertedReceiver_Generic_Resolves()
    {
        // Baseline control from the issue: `x!!.IsNullOrEmpty()` already
        // resolved before this fix (the receiver IS the `IEnumerable[T]`
        // argument directly, no member access involved).
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + """

            func Direct(source IEnumerable[Chapter]?) bool { return source!!.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Control_BareMemberAccess_NoNullAssertion_ArrayOfSourceStruct_Resolves()
    {
        // The equivalent "bare Member.IsNullOrEmpty()" control from the
        // issue: no null assertion anywhere in the chain. Pre-fix this
        // failed too (the array/ClrType gap is unconditional), so this also
        // regression-covers that this control genuinely resolves now.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + """

            func Bare(ch Chapter) bool { return ch.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Broken_NullAssertedReceiver_ThenMemberAccess_ArrayOfSourceStruct_Resolves()
    {
        // The exact reported broken shape: `x!!.Member.IsNullOrEmpty()`.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + """

            func Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Broken_NullAssertedReceiver_ThenForLoopElement_NestedMemberChain_Resolves()
    {
        // Mirrors BookLibrary.gs's AddChapters loop: `for ch in
        // source!!.Chapters { if !ch.Chapters.IsNullOrEmpty() { ... } }` —
        // both a null-asserted-then-member receiver AND a for-loop element
        // reaching a second, nested member chain.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + """

            func Nested(source ChapterInfo?) bool {
                for ch in source!!.Chapters {
                    if !ch.Chapters.IsNullOrEmpty() {
                        return true
                    }
                }
                return false
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NullableMemberType_NullAssertedReceiver_ThenMemberAccess_Resolves()
    {
        // The member itself is nullable (`[]Chapter?`), not just the outer
        // receiver — covers nullable member types distinctly from the
        // non-nullable `[]Chapter` member covered above.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            """
            package Core
            class Chapter {
                prop Title string
                prop Chapters []Chapter?
            }
            func Chained(ch Chapter?) bool { return ch!!.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void FieldMember_NullAssertedReceiver_ThenMemberAccess_Resolves()
    {
        // A field (`var`) rather than an auto-property (`prop`).
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            """
            package Core
            class Chapter {
                var Title string
                var Chapters []Chapter
            }
            func Chained(ch Chapter?) bool { return ch!!.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MethodReturnMember_NullAssertedReceiver_ThenMemberAccess_Resolves()
    {
        // The chain's array-typed step is a METHOD CALL return value, not a
        // field/property.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + """

            class Holder {
                prop Info ChapterInfo
                func GetChapters() []Chapter { return this.Info.Chapters }
            }
            func Chained(h Holder?) bool { return h!!.GetChapters().IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IndexerMember_NullAssertedReceiver_ThenMemberAccess_Resolves()
    {
        // The chain's array-typed step is reached through a Dictionary
        // INDEXER, not a plain field/property/method-return.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            """
            package Core
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
            func Chained(h Holder?) bool { return h!!.Map["k"].IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NestedTwoLevelMemberChain_NullAssertedReceiver_Resolves()
    {
        // `a!!.B.C.IsNullOrEmpty()` — two member-access hops after the null
        // assertion before reaching the array-typed member.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            ChapterModelSource + """

            class Wrapper {
                prop Info ChapterInfo
            }
            func Chained(w Wrapper?) bool { return w!!.Info.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NonGenericExtension_NullAssertedReceiver_ThenMemberAccess_Resolves()
    {
        // A NON-generic extension declared directly over the slice type
        // (no type parameter at all) must keep working — proves the fix to
        // the generic-inference routine doesn't regress (or accidentally
        // depend on) the non-generic extension-lookup path.
        var diagnostics = BindAndReturnAllDiagnostics(
            """
            package Foundation
            func (e []?Core.Chapter) IsNullOrEmpty() bool { return e == nil || e!!.Length == 0 }
            """,
            ChapterModelSource + """

            func Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedReceiver_CrossAssembly_NullAssertedReceiver_ThenMemberAccess_Resolves()
    {
        // Source vs imported receivers: the extension itself comes from a
        // genuinely separately-compiled CLR assembly (reflection-only via
        // MetadataLoadContext), reached through `import Lib2416`, exactly
        // mirroring how Oahu.Core consumes Oahu.Foundation's extension when
        // Foundation is referenced as a prebuilt assembly rather than
        // translated G# source. The receiver's element type (`Chapter`) is
        // still a same-compilation SOURCE type.
        var diagnostics = BindImported("""
            package App
            import Lib2416

            class Chapter {
                prop Title string
                prop Chapters []Chapter
            }
            class ChapterInfo {
                prop Chapters []Chapter
            }
            func Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Negative_InvalidReceiver_NotSequenceCompatible_StillReportsCannotFindFunction()
    {
        // Invalid-receiver negative: the member's type is a plain
        // non-sequence struct (no slice/array, no IEnumerable[T] shape at
        // all). The fix must NOT broaden acceptance to non-array/slice
        // receivers — this must keep failing with GS0159.
        var diagnostics = BindAndReturnAllDiagnostics(
            GenericSourceExtension,
            """
            package Core
            class Holder {
                prop Value int32
            }
            func Chained(h Holder?) bool { return h!!.Value.IsNullOrEmpty() }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void Negative_AmbiguousExtensionOverloads_ThroughNullAssertedMemberChain_StillReportsAmbiguity()
    {
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
        var diagnostics = BindAndReturnAllDiagnostics(
            """
            package Foundation
            import System.Collections.Generic
            func (e ICollection[T]?) IsNullOrEmpty[T]() bool { return e == nil || e!!.Count == 0 }
            func (e IReadOnlyCollection[T]?) IsNullOrEmpty[T]() bool { return e == nil || e!!.Count == 0 }
            """,
            ChapterModelSource + """

            func Chained(source ChapterInfo?) bool { return source!!.Chapters.IsNullOrEmpty() }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0266");
    }

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> BindAndReturnAllDiagnostics(params string[] sources)
    {
        var scope = BindSource(sources);
        var program = Binder.BindProgram(scope);
        return scope.Diagnostics.Concat(program.Diagnostics).ToList();
    }

    private static BoundGlobalScope BindSource(params string[] sources)
    {
        var trees = sources.Select(s => GsSyntaxTree.Parse(SourceText.From(s))).ToImmutableArray();
        return Binder.BindGlobalScope(previous: null, trees);
    }

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> BindImported(string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { ImportedLibraryPath });
        var tree = GsSyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(resolver, tree);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }

    private static string EmitCSharpLibrary()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2416Binding");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Lib2416.dll");

        const string csharpSource = """
            #nullable enable
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
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Lib2416",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }
}
