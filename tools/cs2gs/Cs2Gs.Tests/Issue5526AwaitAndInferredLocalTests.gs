// <copyright file="Issue5526AwaitAndInferredLocalTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.ProjectLoading
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import Xunit

/// Issues #5526 and #5527, follow-ups of #5516. Two shapes of a maybe-null value written into a
/// declaration that stays non-null:
///
/// - #5526: `await call` of a `Task<C?>`. The assertion was printed `await call!!`, which asserts the
///   task. `EnsureNonNullAssertion` now prints `(await call)!!`, and where C# runs no flow analysis
///   `DeclaredCallResultIsAnnotatedNullable` reads the task's type argument.
/// - #5527: a `var` local whose initializer is nullable by declaration is `C?` in G#. Without flow
///   analysis a read of it that feeds a non-null sink gets `!!`, as full flow gives
///   (`IsInferredNullableLocal`, asked where `IsTranslatorWidenedDeclaration` is).
///
/// Rows marked both run in `Annotations` (no flow state) and `Enabled` and assert equal text.
///
/// | Row | Shape | Old output (Annotations) | New output | Mutant that fails the row |
/// | --- | --- | --- | --- | --- |
/// | 1 | `p = await MA()` into a non-null parameter, both | `p = await MA()` / `await MA()!!` (GS0155) | `p = (await MA())!!` | parentheses removed (M1); await read removed (M2) |
/// | 2 | `return await MA()` and `Take(await MA())`, both | same | `(await MA())!!` | M1; M2 |
/// | 3 | `await` of a `ValueTask<C?>`, both | same | `(await MV())!!` | M1; M2 |
/// | 4 | `await` of a `Task<C>` | unchanged | no `!!` | await read ignores the type argument (M3) |
/// | 5 | `C? q = await MA()` | unchanged | no `!!` | sink check removed (M4) |
/// | 6 | `var w = Maybe(); Take(w)` | `Take(w)` (GS0155) | `Take(w!!)` | inferred-local rule removed (M5) |
/// | 7 | `var w = Maybe(); return w` in a `C` method | `return w` | `return w!!` | M5 |
/// | 8 | `var w = Maybe(); Consume(w)` (nullable sink) | unchanged | no `!!` | sink check removed (M4) |
/// | 9 | `var w = new C(); Take(w)` | unchanged | no `!!` | rule applies to every `var` local (M6) |
/// | 10 | `var w = Maybe(); Id(w)` (G# infers the argument) | unchanged | no `!!` | inferred-argument exclusion removed (M7) |
/// | 12 | `F = await MA()` into a `B` field with `implicit operator B(A?)` | no `!!` | unchanged (the conversion bridge decides) | conversion exclusion removed from the await read (M8) |
/// | 13 | `var w = await MA(); Take(w)`, both | `Take(w)` (GS0155) | `Take(w!!)` | await case removed from `IsNullableInitializer` (M9) |
/// | 11 | `var w = Maybe(); w = new C(); Take(w)` | `Take(w)` (GS0155) | `Take(w!!)` (G# does not narrow `w` by the write) | M5 |
open class Issue5526AwaitAndInferredLocalTests {
    @Fact
    func Row1_AwaitedNullableTask_IntoParameter_IsAssertedAroundTheAwait() {
        let printed = AssertSameInBothContexts(`using System.Threading.Tasks;
public class C { public int N; }
public static class K {
  static Task<C?> MA() => Task.FromResult<C?>(null);
  public static async Task F(C p) { p = await MA(); }
}`)
        Assert.Equal(1, Count(printed, "p = (await MA())!!"))
    }

    @Fact
    func Row2_AwaitedNullableTask_ReturnAndArgument_AreAsserted() {
        let printed = AssertSameInBothContexts(`using System.Threading.Tasks;
public class C { public int N; }
public static class K {
  static Task<C?> MA() => Task.FromResult<C?>(null);
  static void Take(C x) { }
  public static async Task<C> R() { return await MA(); }
  public static async Task T() { Take(await MA()); }
}`)
        Assert.Equal(1, Count(printed, "return (await MA())!!"))
        Assert.Equal(1, Count(printed, "Take((await MA())!!)"))
    }

    @Fact
    func Row3_AwaitedNullableValueTask_IsAsserted() {
        let printed = AssertSameInBothContexts(`using System.Threading.Tasks;
public class C { public int N; }
public static class K {
  static ValueTask<C?> MV() => new ValueTask<C?>((C?)null);
  public static async Task F(C p) { p = await MV(); }
}`)
        Assert.Equal(1, Count(printed, "p = (await MV())!!"))
    }

    @Fact
    func Row4_AwaitedNonNullTask_IsUnchanged() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `using System.Threading.Tasks;
public class C { public int N; }
public static class K {
  static Task<C> MA() => Task.FromResult(new C());
  public static async Task F(C p) { p = await MA(); }
}`)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row5_AwaitedNullableTask_IntoNullableLocal_IsUnchanged() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `using System.Threading.Tasks;
public class C { public int N; }
public static class K {
  static Task<C?> MA() => Task.FromResult<C?>(null);
  public static async Task F() { C? q = await MA(); }
}`)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row6_InferredNullableLocal_ReadIntoNonNullArgument_IsAsserted() {
        let printed = AssertSameInBothContexts(`public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Take(C x) { }
  public static void M() { var w = Maybe(); w = Maybe(); Take(w); }
}`)
        Assert.Equal(1, Count(printed, "Take(w!!)"))
    }

    @Fact
    func Row7_InferredNullableLocal_Returned_IsAsserted() {
        let printed = Translate(true, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static C M() { var w = Maybe(); return w; }
}`)
        Assert.Equal(1, Count(printed, "return w!!"))
    }

    @Fact
    func Row8_InferredNullableLocal_IntoNullableSink_IsUnchanged() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Consume(C? x) { }
  public static void M() { var w = Maybe(); Consume(w); }
}`)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row9_InferredNonNullLocal_IsUnchanged() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static void Take(C x) { }
  public static void M() { var w = new C(); Take(w); }
}`)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row10_InferredNullableLocal_IntoInferredGenericArgument_IsUnchanged() {
        let printed = Translate(true, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static int Id<T>(T x) => 1;
  public static int M() { var w = Maybe(); return Id(w); }
}`)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row11_InferredNullableLocal_AssignedNonNull_IsStillAsserted() {
        let printed = Translate(true, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Take(C x) { }
  public static void M() { var w = Maybe(); w = new C(); Take(w); }
}`)
        // G# infers `C?` and does not narrow it by the write, so the read needs the `!!` C# proves safe.
        Assert.Equal(1, Count(printed, "Take(w!!)"))
    }

    @Fact
    func Row12_AwaitedValueThroughUserDefinedConversion_IsLeftToTheConversionBridge() {
        let printed = Translate(true, `using System.Threading.Tasks;
public class A { }
public class B { public static implicit operator B(A? a) => new B(); }
public class Holder { public B F = new B(); }
public static class K {
  static Task<A?> MA() => Task.FromResult<A?>(null);
  public static async Task M() { var h = new Holder { F = await MA() }; }
}`, bind: false)
        Assert.DoesNotContain("(await MA())!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row13_InferredLocalFromAwaitedNullableTask_IsAsserted() {
        let printed = AssertSameInBothContexts(`using System.Threading.Tasks;
public class C { public int N; }
public static class K {
  static Task<C?> MA() => Task.FromResult<C?>(null);
  static void Take(C x) { }
  public static async Task F() { var w = await MA(); Take(w); }
}`)
        Assert.Equal(1, Count(printed, "Take(w!!)"))
    }

    shared {
        private func AssertSameInBothContexts(source string) string {
            let annotations = Translate(true, source)
            let enabled = Translate(false, source)
            Assert.Equal(enabled, annotations)
            return annotations
        }

        private func Translate(annotationsOnly bool, source string, bind bool = true) string {
            let header = if annotationsOnly {
                "#nullable enable annotations\n#nullable disable warnings\n"
            } else {
                "#nullable enable\n"
            }
            let tree = CSharpSyntaxTree.ParseText(
                header + source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Snippet.cs"
            )
            // The generator host compiles a generated file with nullable enabled.
            let compilation = CSharpCompilation.Create(
                "GsgenBackTranslate",
                [](SyntaxTree){tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            let model = compilation.GetSemanticModel(tree)
            let context = TranslationContext(compilation, model, tree.FilePath)
            let unit = CSharpToGSharpTranslator(
                preservePartialParts: true,
                widenObliviousReferenceFields: true,
                translatedFilePaths: [](string){"Snippet.cs"},
                emitGeneratedImplementingParts: true
            ).TranslateDocument(LoadedDocument(tree.FilePath, tree, model), context)
            let printed = GSharpPrinter.Print(unit)
            if bind {
                let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
                Assert.True(
                    result!!.Success,
                    (
                        if annotationsOnly {
                            "annotations"
                        } else {
                            "enabled"
                        }
                    ) +
                        ": translated G# must bind. Errors:\n" +
                        string.Join("\n", result!!.Errors) + `

Printed:
` + printed
                )
            }
            return printed
        }

        private func Count(value string, substring string) int32 -> value.Split(substring, StringSplitOptions.None)
            .Length - 1
    }
}
