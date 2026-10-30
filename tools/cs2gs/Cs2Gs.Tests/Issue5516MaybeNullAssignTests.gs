// <copyright file="Issue5516MaybeNullAssignTests.cs" company="GSharp">
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

/// Issue #5516: a call whose method declares a `T?` result, written into a declaration that stays
/// non-null, must be asserted where C# runs no flow analysis. In a file with `#nullable enable
/// annotations` and warnings off (the shape of a source-generated file) Roslyn gives the call
/// expression no flow state and no `?` on its type, so the declared return type is the only place C#
/// states the contract. The decision is one: `NullableReferenceValueMayBeNull` asks the declared call
/// result (`DeclaredCallResultIsAnnotatedNullable`) when the caller's sink is declared. Full
/// `#nullable enable` already asserted these values from the flow state; every row that has the same
/// shape in both contexts must print the same G#.
///
/// Each row runs in `Annotations` (no flow state) and `Enabled` (full flow analysis).
///
/// | Row | Shape | Old output (Annotations) | New output | Mutant that fails the row |
/// | --- | --- | --- | --- | --- |
/// | 1 | parameter assigned from a `C?` call, then read | `p = Maybe()` (GS0155) | `p = Maybe()!!` | declared call result ignored |
/// | 2 | `return Maybe()` and `=> Maybe()` in a `C` method | no `!!` (GS0155) | `Maybe()!!` | declared call result ignored |
/// | 3 | call as argument of a non-null parameter | `Take(Maybe())` (GS0155) | `Take(Maybe()!!)` | declared call result ignored |
/// | 4 | explicit `C l = Maybe()` and its reassignment | `l = Maybe()` (GS0155) | `Maybe()!!` | declared call result ignored |
/// | 5 | `var v = Maybe()` (G# infers `C?`) | `let v = Maybe()` | unchanged | inferred-local sink treated as declared |
/// | 6 | field and property writes | no `!!` (GS0155) | `Maybe()!!` | declared call result ignored |
/// | 7 | parameter G# widens (null-checked) | `p C?`, `p = Maybe()` | unchanged | call result asserted without the sink check |
/// | 8 | call in a conditional arm and the right of `??` | no `!!` (GS0155) | arm `Maybe()!!` | flag dropped on the arm recursion |
/// | 9 | indexer key | `D[Maybe()]` (GS0155) | `D[Maybe()!!]` | index path ignores the flag |
/// | 10 | call as argument of a nullable parameter | `Consume(Maybe())` | unchanged | call result asserted without the sink check |
/// | 11 | `#nullable disable` region calling a `T?` method | no `!!` | unchanged | annotations gate removed |
/// | 12 | call as argument of an unconstrained generic parameter G# infers | `Count(Maybe())` | unchanged | inferred sink treated as declared |
/// | 14 | reassignment of a `var` local whose initializer fixed a non-null type | `v = Maybe()` (GS0155) | `v = Maybe()!!` | declared sink required a symbol (M10) |
/// | 15 | object-initializer members and a collection-initializer element | no `!!` (GS0155) | `Holder{F: Maybe()!!, ...}`, `List[C]{ Maybe()!! }` | initializer path ignores the flag (M11) |
/// | 16 | `Path.GetFileName(path)` with a non-null and a nullable argument | `Name` and `Name2` no `!!` | `Name` unchanged, `Name2` `!!` | declared `?` read without `NotNullIfNotNull` (M9) |
/// | 13 | call as argument of a `where T : class` generic parameter | no `!!` (GS0155 or throw) | `Use(Maybe()!!)` | declared call result ignored |
open class Issue5516MaybeNullAssignTests {
    @Fact
    func Row1_ParameterAssignedFromNullableCall_IsAsserted() {
        let source = `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Consume(C? x) { }
  public static C? MaybeRet(C p) { p = Maybe(); Consume(p); return p; }
}`
        let printed = AssertSameInBothContexts(source)
        Assert.Contains("func MaybeRet(p C) C?", printed, StringComparison.Ordinal)
        Assert.Equal(1, Count(printed, "p = Maybe()!!"))
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row2_ReturnedCall_IsAsserted() {
        let printed = AssertSameInBothContexts(`public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static C Ret() { return Maybe(); }
  static C Arrow() => Maybe();
}`)
        Assert.Equal(1, Count(printed, "return Maybe()!!"))
        Assert.Equal(1, Count(printed, "func Arrow() C -> Maybe()!!"))
    }

    @Fact
    func Row3_ArgumentOfNonNullParameter_IsAsserted() {
        let printed = AssertSameInBothContexts(`public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Take(C x) { }
  public static void M() { Take(Maybe()); Take((Maybe())); }
}`)
        Assert.Equal(1, Count(printed, "Take(Maybe()!!)"))
        Assert.Equal(1, Count(printed, "Take((Maybe())!!)"))
    }

    @Fact
    func Row4_ExplicitlyTypedLocal_IsAsserted() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static void M() { C l = Maybe(); l = Maybe(); }
}`)
            Assert.Equal(2, Count(printed, "Maybe()!!"))
        }
    }

    @Fact
    func Row5_InferredLocal_TakesTheNullableResult() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Consume(C? x) { }
  public static void M() { var v = Maybe(); }
}`)
            Assert.Contains("let v = Maybe()\n", printed.Replace("\r\n", "\n"), StringComparison.Ordinal)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row6_FieldAndPropertyWrites_AreAsserted() {
        let printed = AssertSameInBothContexts(`public class C { public int N; public C F = new C(); public C P { get; set; } = new C(); }
public static class K {
  static C? Maybe() => null;
  public static void M(C c) { c.F = Maybe(); c.P = Maybe(); }
}`)
        Assert.Equal(1, Count(printed, "c.F = Maybe()!!"))
        Assert.Equal(1, Count(printed, "c.P = Maybe()!!"))
    }

    @Fact
    func Row7_WidenedParameter_KeepsTheNullableCall() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static void W(C p) { p = Maybe(); if (p == null) { p = new C(); } }
}`)
            Assert.Contains("func W(p C?)", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row8_ConditionalArmAndCoalesceRight_AreAsserted() {
        let printed = AssertSameInBothContexts(`public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static void M(C p, C q, bool b) { p = b ? Maybe() : p; p = q ?? Maybe(); }
}`)
        Assert.Equal(1, Count(printed, "if b { Maybe()!! } else { p }"))
        Assert.Equal(1, Count(printed, "(q ?? Maybe())!!"))
    }

    @Fact
    func Row9_IndexerKey_IsAsserted() {
        let printed = AssertSameInBothContexts(`using System.Collections.Generic;
public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static Dictionary<C, int> D = new Dictionary<C, int>();
  public static int Ix() { return D[Maybe()]; }
  public static int IxArm(C p, bool b) { return D[b ? Maybe() : p]; }
}`)
        Assert.Equal(1, Count(printed, "D[Maybe()!!]"))
        // The arm is asserted, so the conditional is not asserted again.
        Assert.Equal(1, Count(printed, "D[if b { Maybe()!! } else { p }]"))
        Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("})!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row10_NullableParameter_KeepsTheNullableCall() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Consume(C? x) { }
  public static void M() { Consume(Maybe()); }
}`)
            Assert.Contains("Consume(Maybe())", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row11_NullableDisabledRegion_IsUnchanged() {
        // C# states no contract for `p` there, so the declared result of the callee decides nothing.
        let printed = Translate(false, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
#nullable disable
  public static void M(C p) { p = Maybe(); }
#nullable restore
}`, bind: false)
        Assert.DoesNotContain("Maybe()!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row12_InferredGenericArgument_KeepsTheNullableCall() {
        // G# infers `T = C?`, so an assertion would throw where C# returns 1.
        let printed = Translate(true, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static int Count<T>(T x) => 1;
  public static int M() { return Count(Maybe()); }
}`)
        Assert.Contains("Count(Maybe())", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row13_ConstrainedGenericArgument_IsAsserted() {
        let printed = Translate(true, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static int Use<T>(T x) where T : class => 1;
  public static int M() { return Use(Maybe()); }
}`)
        Assert.Equal(1, Count(printed, "Use(Maybe()!!)"))
    }

    @Fact
    func Row14_ReassignedInferredLocalWithNonNullInitializer_IsAsserted() {
        let printed = AssertSameInBothContexts(`public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static void A() { var v = new C(); v = Maybe(); }
}`)
        Assert.Equal(1, Count(printed, "v = Maybe()!!"))
    }

    @Fact
    func Row15_InitializerMembersAndElements_AreAsserted() {
        let printed = AssertSameInBothContexts(`using System.Collections.Generic;
public class C { public int N; }
public class Holder { public C F = new C(); public C P { get; set; } = new C(); }
public static class K {
  static C? Maybe() => null;
  public static void M() { var h = new Holder { F = Maybe(), P = Maybe() }; var l = new List<C> { Maybe() }; }
}`)
        Assert.Equal(1, Count(printed, "F: Maybe()!!"))
        Assert.Equal(1, Count(printed, "P: Maybe()!!"))
        Assert.Equal(1, Count(printed, "List[C]{ Maybe()!! }"))
    }

    @Fact
    func Row16_NotNullIfNotNullResult_FollowsItsArgument() {
        let printed = Translate(true, `using System.IO;
public static class K {
  public static string Name(string path) => Path.GetFileName(path);
  public static string Name2(string? path) => Path.GetFileName(path);
}`)
        Assert.Contains(
            "func Name(path string) string -> Path.GetFileName(path)\n",
            printed.Replace("\r\n", "\n"),
            StringComparison.Ordinal
        )
        Assert.Equal(1, Count(printed, "Path.GetFileName(path)!!"))
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
