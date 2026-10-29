// <copyright file="Issue5254ForgiveWidenedReadsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.ProjectLoading
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import Xunit

/// Issue #5254: one rule for every declaration the translator widens to `T?`
/// (a parameter, an `out` or `ref` parameter, and the locals that `out var`
/// declares for it). A read whose C# flow state is non-null gets `!!` and the
/// declaration stays widened, so the null write still binds.
///
/// Each row runs in two nullable contexts. `Annotations` is the shape the
/// generator host gives a source-generated file (`#nullable enable
/// annotations` with warnings off), where Roslyn runs no flow analysis and the
/// declaration is the only contract. `Enabled` is full C# flow analysis.
///
/// | Row | Shape | Contract |
/// | --- | --- | --- |
/// | 1 | parameter reassigned from a nullable call, null-guarded, returned | `return converter!!` |
/// | 2 | `out` parameter set to null, set non-null after a false `Try` call, read and returned | `info!!.Resolver`, `return info!!`, widened `out` stays |
/// | 3 | `out var` and `out T x` locals | `return v!!`, `w!!.N` |
/// | 4 | `ref` parameter reassigned from a nullable call | `return c!!` |
/// | 5 | reads inside a lambda and a local function | `return p!!` inside both |
/// | 6 | flow state maybe-null, nullable sink | no `!!` (Enabled only: Annotations has no flow state) |
/// | 7 | parameter never widened | unchanged: no `!!`, parameter stays non-null |
/// | 8 | `out T x` local read in a local function | `x!!` |
/// | 9 | assignment into a widened `out` local | `w = p`, no `!!` (the sink accepts null) |
/// | 10 | argument whose parameter type G# infers | `Id(p)`, no `!!` |
/// | 11 | argument to a non-null parameter | `Use(p!!)` |
/// | 12 | argument to a receiver-fixed generic parameter (`Box[C].Use`) | `Use(p!!)` |
/// | 13 | widened `out` local returned in a nil-accepting method, full flow | no `!!` |
/// | 16 | inferred generic argument whose result is consumed as non-null, full flow | `Id(p!!)` |
/// | 17 | argument to a constrained generic parameter | `Use(p!!)` |
/// | 18 | lambda parameter whose annotation drives inference | never widened, so no `!!` |
/// | 19 | inferred argument whose result is wrapped (`Box[T]`) | `Wrap(p!!)` |
/// | 14 | `params` carrier | never widened, so no `!!` |
/// | 15 | indexer key of a widened parameter | binds (`m[key!!]` when the key stays non-null) |
open class Issue5254ForgiveWidenedReadsTests {
    @Fact
    func Row1_ParameterReassignedFromNullableCall_IsForgivenAtReturn() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `using System;
public class Conv { public bool CanConvert(Type t) => true; }
public class Fac : Conv { public Conv? Create(Type t) => null; }
public static class K {
  public static Conv Expand(Type type, Conv converter, bool validate = true) {
    if (validate && !converter.CanConvert(type)) throw new InvalidOperationException();
    if (converter is Fac factory) {
      converter = factory.Create(type);
      if (converter == null || converter is Fac) throw new InvalidOperationException();
    }
    return converter;
  }
}`)
            Assert.Contains("converter Conv?", printed, StringComparison.Ordinal)
            Assert.Equal(1, Count(printed, "return converter!!"))
            Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row2_OutParameterAssignedNull_ReadsAreForgiven_AndDeclarationStaysWidened() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class Info<T> { public object Resolver; }
public class K {
  static bool Try<T>(int o, out Info<T> info) { info = null; return false; }
  static Info<T> Make<T>() => new Info<T>();
  public Info<T> Get<T>(int o) {
    if (!Try<T>(o, out Info<T> info)) { info = Make<T>(); }
    info.Resolver = this;
    return info;
  }
}`)
            Assert.Contains("out info Info[T]?", printed, StringComparison.Ordinal)
            Assert.Contains("info = nil", printed, StringComparison.Ordinal)
            Assert.Equal(1, Count(printed, "info!!.Resolver = this"))
            Assert.Equal(1, Count(printed, "return info!!"))
            Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row3_OutVarAndTypedOutLocals_AreForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  public static bool TryGet(out C c) { c = null; return false; }
  public static C Use() { if (!TryGet(out var v)) { v = new C(); } return v; }
  public static int Use2() { if (!TryGet(out C w)) { w = new C(); } return w.N; }
}`)
            Assert.Contains("out c C?", printed, StringComparison.Ordinal)
            Assert.Equal(1, Count(printed, "return v!!"))
            Assert.Equal(1, Count(printed, "return w!!.N"))
            Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row4_RefParameterReassignedFromNullableCall_IsForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static C Fill(ref C c) { c = Maybe(); if (c == null) { c = new C(); } c.N = 1; return c; }
}`)
            Assert.Contains("ref c C?", printed, StringComparison.Ordinal)
            Assert.Equal(1, Count(printed, "return c!!"))
            Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row5_ReadsInsideLambdaAndLocalFunction_AreForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `using System;
public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  public static C Cap(C p) {
    p = Maybe();
    if (p == null) { p = new C(); }
    Func<C> f = () => { return p; };
    C G() { return p; }
    return G();
  }
}`)
            Assert.Equal(2, Count(printed, "return p!!"))
            Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row6_MaybeNullFlowState_IsNotForgiven() {
        // Annotations has no flow state, so only full flow analysis can tell a
        // maybe-null read from a non-null one.
        let printed = Translate(false, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Consume(C? x) { }
  public static C? Pass(C p) { p = Maybe(); if (p == null) { Consume(null); } Consume(p); return p; }
}`)
        Assert.Contains("p C?", printed, StringComparison.Ordinal)
        Assert.Contains("Consume(p)", printed, StringComparison.Ordinal)
        Assert.Contains("return p\n", printed.Replace("\r\n", "\n"), StringComparison.Ordinal)
        Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row6b_NullableSink_KeepsTheWidenedValue_InEveryMode() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static void Consume(C? x) { }
  public static C? Pass(C p) { p = Maybe(); if (p == null) { Consume(null); } Consume(p); return p; }
}`)
            Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row7_ParameterThatIsNeverWidened_StaysAsIs() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  public static C Ident(C p) { return p; }
}`)
            Assert.Contains("func Ident(p C) C", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row8_CapturedTypedOutLocal_IsForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  public static bool TryGet(out C c) { c = null; return false; }
  public static C Read() {
    if (!TryGet(out C x)) { x = new C(); }
    C Local() => x;
    return Local();
  }
}`)
            Assert.Contains("out c C?", printed, StringComparison.Ordinal)
            Assert.Equal(1, Count(printed, "x!!"))
            Assert.DoesNotContain("!!!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row9_AssignmentIntoWidenedOutLocal_KeepsTheWidenedValue() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  public static bool TryGet(out C c) { c = null; return false; }
  public static C? Copy(C p) { p = null; TryGet(out C w); w = p; return w; }
}`)
            Assert.Contains("w = p\n", printed.Replace("\r\n", "\n"), StringComparison.Ordinal)
            Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row10_InferredGenericArgument_KeepsTheWidenedValue() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static T Id<T>(T x) => x;
  public static C? Pass(C p) { p = null; return Id(p); }
}`)
            Assert.Contains("Id(p)", printed, StringComparison.Ordinal)
            Assert.DoesNotContain("p!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row11_ArgumentToNonNullParameter_IsForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static C? Maybe() => null;
  static int Use(C x) => x.N;
  public static int Pass(C p) { p = Maybe(); if (p == null) { p = new C(); } return Use(p); }
}`)
            Assert.Equal(1, Count(printed, "Use(p!!)"))
        }
    }

    @Fact
    func Row15_IndexerKeyThatStaysNonNull_IsForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `using System.Collections.Generic;
public static class K {
  public static int Read(Dictionary<string, int> m, string key) {
    var n = m[key];
    if (key == null) { return 0; }
    return n;
  }
}`)
            Assert.Contains("m[key", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row12_ReceiverFixedGenericParameter_IsForgiven() {
        let printed = Translate(true, `public class C { public int N; }
public class Box<T> where T : class { public static int Use(T x) => 1; }
public static class K {
  static C? Maybe() => null;
  public static int Pass(C p) { p = Maybe(); if (p == null) { p = new C(); } return Box<C>.Use(p); }
}`)
        Assert.Equal(1, Count(printed, "Use(p!!)"))
    }

    @Fact
    func Row13_NullableReturnInFullFlow_KeepsTheWidenedOutLocal() {
        let printed = Translate(false, `public class C { public int N; }
public static class K {
  public static bool TryGet(out C c) { c = null; return false; }
  static T Id<T>(T x) => x;
  public static C? Ret() { TryGet(out C x); return x; }
}`)
        Assert.Contains("out c C?", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("x!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func Row14_VariadicCarrier_IsNeverWidened_SoNeverForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  public static C[] Echo(params C[] xs) { if (xs == null) throw new System.Exception(); return xs; }
}`)
            Assert.DoesNotContain("xs!!", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row16_InferredGenericResultConsumedAsNonNull_FullFlow_IsForgiven() {
        let printed = Translate(false, `public class C { public int N; }
public static class K {
  static T Id<T>(T x) => x;
  public static C Read(C p) { var n = Id(p); if (p == null) { return new C(); } return n; }
}`)
        Assert.Equal(1, Count(printed, "Id(p!!)"))
    }

    @Fact
    func Row17_ConstrainedGenericArgument_IsForgiven() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `public class C { public int N; }
public static class K {
  static int Use<T>(T x) where T : class => 1;
  public static int Read(C p) { var n = Use(p); if (p == null) { return 0; } return n; }
}`)
            Assert.Equal(1, Count(printed, "Use(p!!)"))
        }
    }

    @Fact
    func Row18_LambdaParameterThatDrivesInference_IsNeverWidened() {
        for annotationsOnly in[](bool){true, false} {
            let printed = Translate(annotationsOnly, `using System;
public class C { public int N; }
public static class K {
  static void Consume(C x) { }
  public static void Run(C[] items) { Array.ForEach(items, p => { if (p == null) return; Consume(p); }); }
}`)
            Assert.DoesNotContain("Consume(p!!)", printed, StringComparison.Ordinal)
        }
    }

    @Fact
    func Row19_WrappedInferredResult_FullFlow_IsAsserted() {
        let printed = Translate(false, `public class C { public int N; }
public class Box<T> { }
public static class K {
  static Box<T> Wrap<T>(T x) => new Box<T>();
  public static Box<C>? Ret(C p, bool b) { if (b) { return Wrap(p); } if (p == null) { return null; } return null; }
}`)
        Assert.Equal(1, Count(printed, "Wrap(p!!)"))
    }

    shared {
        private func Translate(annotationsOnly bool, source string) string {
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
            return printed
        }

        private func Count(value string, substring string) int32 -> value.Split(substring, StringSplitOptions.None)
            .Length - 1
    }
}
