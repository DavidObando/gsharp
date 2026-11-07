package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

class Issue5699RecordDeconstructTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func LiftedLocalHelpers_ReserveRecordAdapterNamesInEitherMemberOrder(helperFirst bool) {
        let deconstruct = "public void Deconstruct(out int x, out int y) { x = 30; y = 2; }"
        let helper = `public int Work() {
            int deconstructTuple() { return Bounce<int>(0); }
            int Bounce<T>(int n) { return n == 0 ? Value : deconstructTuple(); }
            return deconstructTuple();
        }`
        Verify((`
namespace RecordDeconstruction {
    public record R {
        public int Value = 7;
        MEMBERS
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            var (x, y) = r;
            return $"{x},{y},{r.Work()}";
        }
    }
}`).Replace(
                "MEMBERS",
                if helperFirst {
                    helper + "\n" + deconstruct
                } else {
                    deconstruct + "\n" + helper
                }
            ))
    }

    @Theory
    @InlineData("record")
    @InlineData("record class")
    @InlineData("record struct")
    func MetadataConsumersOfMigratedRecords_ReportGapAtEachAffectedUse(kind string) {
        let producer = CSharpProjectLoader.LoadInMemory([](string, string){("Producer.cs", (`
namespace Producer {
    public KIND R {
        public int X, Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`).Replace("KIND", kind))}, assemblyName: "Producer" + Guid.NewGuid().ToString("N"))
        Assert.True(producer.BoundWithoutErrors, string.Join("\n", producer.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(producer.Compilation.Emit(image).Success)
        const source = `
namespace RecordDeconstruction {
    public static class Probe {
        public static string Run() {
            var r = new Producer.R { X = 2, Y = 3 };
            var (x, y) = r;
            r.Deconstruct(out var a, out var b);
            return $"{x},{y},{a},{b}";
        }
    }
}`
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromImage(image.ToArray()))
            .ToArray()
        let consumer = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Consumer.cs", source)},
            references,
            assemblyName: "Consumer" + Guid.NewGuid().ToString("N")
        )
        Assert.True(consumer.BoundWithoutErrors, string.Join("\n", consumer.ErrorDiagnostics))
        using let baseline = MemoryStream()
        Assert.True(consumer.Compilation.Emit(baseline).Success)
        let document = Assert.Single(consumer.Documents)
        let context = TranslationContext(
            consumer.Compilation,
            document.SemanticModel,
            document.FilePath,
            repositoryCompilations: []Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpCompilation{producer.Compilation, consumer.Compilation}
        )
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        let gaps = context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported).ToArray()
        Assert.Equal(2, gaps.Length)
        Assert.All(
            gaps,
            (gap TranslationDiagnostic) -> {
                Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
                Assert.Contains("migrated producer", gap.Message)
                Assert.Equal("Consumer.cs", gap.Location!!.SourceTree!!.FilePath)
            }
        )
    }

    @Theory
    @InlineData("record", false)
    @InlineData("record", true)
    @InlineData("record class", false)
    @InlineData("record class", true)
    @InlineData("record struct", false)
    @InlineData("record struct", true)
    func PointerOutputs_ReportDeclarationGapWithoutEmittingAdapters(kind string, scalar bool) {
        let source = (`
namespace RecordDeconstruction {
    public KIND R {
        public unsafe void Deconstruct(PARAMETERS) { BODY }
    }
    public static class Probe {
        public static string Run() { return new R().ToString(); }
    }
}`).Replace(
            "KIND",
            kind
        ).Replace(
            "PARAMETERS",
            if scalar {
                "out int* p"
            } else {
                "out int* p, out int n"
            }
        ).Replace(
            "BODY",
            if scalar {
                "p = null;"
            } else {
                "p = null; n = 1;"
            }
        )
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(project.Compilation.Emit(image).Success)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let gap = Assert.Single(
            context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        )
        Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
        Assert.Contains("pointer outputs", gap.Message)
        Assert.Equal(
            source.IndexOf("public unsafe void Deconstruct", StringComparison.Ordinal),
            gap.Location!!.SourceSpan.Start
        )
        Assert.DoesNotContain("func deconstructTuple", printed)
        Assert.DoesNotContain("func deconstructValue", printed)
    }

    @Theory
    @InlineData("record")
    @InlineData("class")
    @InlineData("extension")
    func NestedNullableOutputs_PropagateAllSelectedSignatures(outerKind string) {
        Verify((`
#nullable enable
namespace RecordDeconstruction {
    public record R(int X, int Y) {
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    OUTER
    public static class Probe {
        public static bool Missing() {
            try { var ((a, b), tag) = new Outer(null, 4); return false; }
            catch (System.NullReferenceException) { return true; }
        }
        public static string Run() {
            var outer = new Outer(new R(2, 3), 4);
            var ((x, y), tag) = outer;
            var sum = x + y + tag;
            foreach (var ((a, b), id) in new[] { outer }) sum += a + b + id;
            return $"{sum},{Missing()}";
        }
    }
}`).Replace(
                "OUTER",
                if outerKind == "record" {
                    "public record Outer(R? Child, int Tag);"
                } else {
                    `public class Outer {
                    public R? Child;
                    public int Tag;
                    public Outer(R? child, int tag) { Child = child; Tag = tag; }
                    METHOD
                }
                EXTENSION`.Replace(
                        "METHOD",
                        if outerKind == "class" {
                            "public void Deconstruct(out R? child, out int tag) { child = Child; tag = Tag; }"
                        } else {
                            ""
                        }
                    )
                        .Replace(
                        "EXTENSION",
                        if outerKind == "extension" {
                            "public static class Extensions { public static void Deconstruct(this Outer outer, out R? child, out int tag) { child = outer.Child; tag = outer.Tag; } }"
                        } else {
                            ""
                        }
                    )
                }
            ))
    }

    @Fact
    func PatternAlternatives_SnapshotReceiversAcrossDeconstructMutations() {
        Verify(`
#nullable enable
namespace RecordDeconstruction {
    public record R {
        public int Value = 3;
        public static int Calls;
        public static System.Action? Hook;
        public void Deconstruct(out int x, out int y) { Calls++; x = 1; y = 2; Hook?.Invoke(); }
    }
    public static class Probe {
        public static string Run() {
            R? r = new R();
            R.Hook = () => r = null;
            var matched = r is R(0, _) or R(1, _);
            return $"{matched},{r is null},{R.Calls}";
        }
    }
}`)
    }

    @Fact
    func MixedPositionalPropertyDecision_ReportsGapInsteadOfChangingRoslynEvaluation() {
        const source = `
#nullable enable
namespace RecordDeconstruction {
    public record R {
            public int Value = 3;
            public static System.Action? Hook;
            public void Deconstruct(out int x, out int y) { x = 1; y = 2; Hook?.Invoke(); }
    }
    public static class Probe {
            public static string Run() {
                R? r = new R();
                R.Hook = () => r = null;
                try { return (r is R(0, _) or R(1, _) { Value: 3 }).ToString(); }
                catch (System.NullReferenceException) { return "threw"; }
            }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(project.Compilation.WithAssemblyName("Mixed" + Guid.NewGuid().ToString("N")).Emit(image).Success)
        Assert.Equal(
            "threw",
            cast[string](
                Assembly.Load(image.ToArray()).GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        let gap = Assert.Single(
            context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        )
        Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
        Assert.Contains("positional and property", gap.Message)
        Assert.Equal(source.IndexOf("r is R(0, _)", StringComparison.Ordinal), gap.Location!!.SourceSpan.Start)
    }

    @Fact
    func RepeatedNegatedGuardHoist_DeclaresCachesInEveryEmittedScope() {
        Verify(`
namespace RecordDeconstruction {
    public record R {
        public static int Calls;
        public void Deconstruct(out int x, out int y) { Calls++; x = 1; y = 2; }
    }
    public static class Probe {
        public static string Classify(int n, R r) {
            switch (n) {
                case 0:
                case 1 when true:
                    if (r is not R(1, var x)) return "miss";
                    return x.ToString();
                default: return "other";
            }
        }
        public static string Run() {
            var r = new R();
            return Classify(0, r) + "," + Classify(1, r) + "," + R.Calls;
        }
    }
}`)
    }

    @Theory
    @InlineData("record")
    @InlineData("record class")
    @InlineData("record struct")
    func TypedDeclarations_PreserveTargetTypesAndUserConversions(kind string) {
        Verify((`
namespace RecordDeconstruction {
    public KIND R {
        public void Deconstruct(out int x, out int y) { x = 30; y = 2; }
    }
    public class Box {
        public int Value;
        public static implicit operator Box(int value) { return new Box { Value = value }; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            (long x, long y) = r;
            (double a, double b) = r;
            (Box one, Box two) = r;
            return $"{x.GetType().Name},{y.GetType().Name},{a.GetType().Name},{b.GetType().Name},{one.Value},{two.Value}";
        }
    }
}`).Replace("KIND", kind))
    }

    @Theory
    @InlineData("record", false)
    @InlineData("record", true)
    @InlineData("record class", false)
    @InlineData("record class", true)
    @InlineData("record struct", false)
    @InlineData("record struct", true)
    func NestedAssignment_ExtractsAndConvertsBeforeWritingTargets(kind string, valuePosition bool) {
        Verify((`
namespace RecordDeconstruction {
    public struct V {
        public int Value;
        public static implicit operator int(V value) {
            R.Events += $"C{R.Stored};";
            return value.Value;
        }
    }
    public KIND R {
        public static int Stored;
        public static string Events = "";
        public void Deconstruct(out V x, out int y) {
            Events += $"D{Stored};";
            x = new V { Value = Stored };
            y = 2;
        }
    }
    public static class Probe {
        public static string Run() {
            int b = -1, c = -1;
            ASSIGNMENT
            return resultText + $"{R.Stored},{b},{c},{R.Events}";
        }
    }
}`).Replace("KIND", kind)
                .Replace(
                "ASSIGNMENT",
                if valuePosition {
                    "var result = ((R.Stored, (b, c)) = (9, new R())); var resultText = $\"{result.Item2.Item1.GetType().Name},{result.Item2.Item1};\";"
                } else {
                    "(R.Stored, (b, c)) = (9, new R()); var resultText = \"\";"
                }
            ))
    }

    @Fact
    func RepeatedCapturedPatternReceiver_ResetsOutputsOnEveryEvaluation() {
        Verify(`
namespace RecordDeconstruction {
    public record R(int Value) {
        public static int Calls;
        public void Deconstruct(out int x, out int y) { Calls++; x = Value; y = 2; }
    }
    public static class Probe {
        public static int Gets;
        public static R Next() { return new R(Gets++ == 0 ? 1 : 0); }
        public static string Run() {
            int iterations = 0;
            while (iterations < 2 && Next() is R(1, _)) iterations++;
            return $"{iterations},{Gets},{R.Calls}";
        }
    }
}`)
    }

    @Fact
    func RepeatedSwitchSectionEmission_DeclaresPatternCachesInEachScope() {
        Verify(`
namespace RecordDeconstruction {
    public record R {
        public static int Calls;
        public void Deconstruct(out int x, out int y) { Calls++; x = 1; y = 2; }
    }
    public static class Probe {
        public static string Classify(int n, R r) {
            switch (n) {
                case 0:
                case 1 when true:
                    var matched = r is R(1, 2);
                    var arm = r switch { R(1, 2) => true, _ => false };
                    return $"{matched}:{arm}";
                default: return "other";
            }
        }
        public static string Run() {
            var r = new R();
            return Classify(0, r) + "," + Classify(1, r) + "," + R.Calls;
        }
    }
}`)
    }

    @Fact
    func NullableReceivers_DeconstructOnceAndThrowOnlyAtTheCall() {
        Verify(`
#nullable enable
namespace RecordDeconstruction {
    public record R {
        public int X;
        public int Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public record Outer(R? Child, int Tag) {
        public void Deconstruct(out R? child, out int tag) { child = Child; tag = Tag; }
    }
    public static class Probe {
        public static int Gets;
        public static R? Create(bool absent) { Gets++; return absent ? null : new R { X = 2, Y = 3 }; }
        public static int Guarded(R? r) {
            if (r == null) return 0;
            var (x, y) = r;
            return x + y;
        }
        public static bool Missing() {
            try { var (x, y) = Create(true); return false; }
            catch (System.NullReferenceException) { return true; }
        }
        public static string Run() {
            var r = Create(false);
            var (a, b) = r;
            var ((c, d), e) = (Create(false), 4);
            var total = 0;
            foreach (var (x, y) in new R?[] { Create(false) }) total += x + y;
            var ((f, g), h) = new Outer(Create(false), 4);
            var sum = a + b + c + d + e + total + f + g + h + Guarded(r);
            return $"{sum},{Missing()},{Gets}";
        }
    }
}`)
    }

    @Theory
    @InlineData("record")
    @InlineData("record class")
    @InlineData("record struct")
    func FlatTypedForEachTargets_ApplySelectedOutputConversions(kind string) {
        Verify((`
namespace RecordDeconstruction {
    public KIND R {
        public void Deconstruct(out int x, out int y) { x = 30; y = 2; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            var text = "";
            foreach ((long x, long y) in new[] { r }) text += $"{x.GetType().Name},{y.GetType().Name};";
            foreach ((double x, double y) in new[] { r }) text += $"{x.GetType().Name},{y.GetType().Name}";
            return text;
        }
    }
}`).Replace("KIND", kind))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedDeconstructContracts_ReportDeclarationGapWithoutRenaming(overrideBase bool) {
        let external = CSharpProjectLoader.LoadInMemory([](string, string){("External.cs", `
namespace External {
    public interface IParts { void Deconstruct(out int x, out int y); }
    public record Base {
        public int X, Y;
        public virtual void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
}`)}, assemblyName: "External" + Guid.NewGuid().ToString("N"))
        Assert.True(external.BoundWithoutErrors, string.Join("\n", external.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(external.Compilation.Emit(image).Success)
        let source = (`
namespace RecordDeconstruction {
    public record R : PARENT {
        FIELDS
        public OVERRIDE void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            r.Deconstruct(out var x, out var y);
            return $"{x},{y}";
        }
    }
}`).Replace(
            "PARENT",
            if overrideBase {
                "External.Base"
            } else {
                "External.IParts"
            }
        ).Replace(
            "FIELDS",
            if overrideBase {
                ""
            } else {
                "public int X, Y;"
            }
        ).Replace(
            "OVERRIDE",
            if overrideBase {
                "override"
            } else {
                ""
            }
        )
        let references = CSharpProjectLoader
            .RuntimeReferences()
            .Append(MetadataReference.CreateFromImage(image.ToArray()))
            .ToArray()
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)}, references)
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let baseline = MemoryStream()
        Assert.True(project.Compilation.Emit(baseline).Success)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let gap = Assert.Single(
            context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        )
        Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
        Assert.Contains("imported Deconstruct contract", gap.Message)
        Assert.Equal(
            source.IndexOf(
                "public " +
                    (
                    if overrideBase {
                        "override"
                    } else {
                        ""
                    }
                ) +
                    " void Deconstruct",
                StringComparison.Ordinal
            ),
            gap.Location!!.SourceSpan.Start
        )
        Assert.DoesNotContain("func deconstruct", printed)
    }

    @Theory
    @InlineData("record", false)
    @InlineData("record class", false)
    @InlineData("record struct", false)
    @InlineData("record", true)
    @InlineData("record class", true)
    @InlineData("record struct", true)
    func NullableOutputs_UseEmittedSignatureTypes(kind string, annotated bool) {
        Verify((`
CONTEXT
namespace RecordDeconstruction {
    public KIND R {
        public static int Calls;
        public void Deconstruct(ATTRIBUTE out string text, out int count) { Calls++; text = null; count = 4; }
    }
    public KIND Unused {
        public void Deconstruct(ATTRIBUTE out string text, out int count) { text = null; count = 0; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            var (text, count) = r;
            var pattern = r is R(null, 4);
            var arm = r switch { R("x", _) => -1, R(null, var n) => n, _ => -2 };
            r.Deconstruct(out var direct, out var directCount);
            return $"{text ?? "nil"},{count},{pattern},{arm},{direct ?? "nil"},{directCount},{R.Calls}";
        }
    }
}`).Replace(
                "KIND",
                kind
            ).Replace(
                "CONTEXT",
                if annotated {
                    "#nullable enable"
                } else {
                    "#nullable disable"
                }
            ).Replace(
                "ATTRIBUTE",
                if annotated {
                    "[System.Diagnostics.CodeAnalysis.AllowNull]"
                } else {
                    ""
                }
            ), "func deconstructTuple() (string?, int32)")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func GenericNullableOutput_UsesConstructedEmittedSignature(annotated bool) {
        Verify((`
CONTEXT
namespace RecordDeconstruction {
    public record R<T> where T : class {
        public void Deconstruct(ATTRIBUTE out T value, out int count) { value = null; count = 4; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R<string>();
            var (value, count) = r;
            var pattern = r is R<string>(null, 4);
            return $"{value ?? "nil"},{count},{pattern}";
        }
    }
}`).Replace(
                "CONTEXT",
                if annotated {
                    "#nullable enable"
                } else {
                    "#nullable disable"
                }
            )
                .Replace(
                "ATTRIBUTE",
                if annotated {
                    "[System.Diagnostics.CodeAnalysis.AllowNull]"
                } else {
                    ""
                }
            ), "func deconstructTuple() (T?, int32)")
    }

    @Theory
    @InlineData("record")
    @InlineData("record class")
    @InlineData("record struct")
    func SingleOutputPatterns_UseScalarAdapters(kind string) {
        Verify((`
namespace RecordDeconstruction {
    public KIND R {
        public static int Calls;
        public void Deconstruct(out int value) { Calls++; value = 7; }
    }
    public KIND S {
        public void Deconstruct(out string value) { value = null; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            var value = r is R(var x) ? x : -1;
            var arm = r switch { R(0) => -1, R(7) => 7, _ => -2 };
            r.Deconstruct(out var direct);
            var nil = new S() is S(null);
            return $"{value},{arm},{direct},{R.Calls},{nil}";
        }
    }
}`).Replace("KIND", kind))
    }

    @Fact
    func PartialDeconstructOverloads_EmitOneAdapterPerImplementedPair() {
        Verify(`
namespace RecordDeconstruction {
    public partial record R {
        public int X;
        public int Y;
        public partial void Deconstruct(out int x, out int y);
        public partial void Deconstruct(out int x, out int y, out int z);
    }
    public partial record R {
        public partial void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
        public partial void Deconstruct(out int x, out int y, out int z) { x = Y * 10; y = X; z = X + Y; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            var (a, b) = r;
            var (c, d, e) = r;
            return $"{a},{b},{c},{d},{e}";
        }
    }
}`)
    }

    @Fact
    func InheritedDeconstruct_ReservesNamesAgainstUnrelatedDerivedMembers() {
        Verify(`
namespace RecordDeconstruction {
    public delegate void Parts(out int x, out int y);
    public record Base {
        public int X;
        public int Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public record R : Base {
        public void deconstruct(out int x, out int y) { x = -1; y = -2; }
        public (int, int) deconstructTuple() => (-3, -4);
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            var (a, b) = r;
            r.Deconstruct(out var c, out var d);
            Parts parts = r.Deconstruct;
            parts(out var e, out var f);
            return $"{a},{b},{c},{d},{e},{f}";
        }
    }
}`)
    }

    @Fact
    func ParenthesizedAndLogicalDiscards_DoNotInvokeDeconstruct() {
        Verify(`
namespace RecordDeconstruction {
    public record R {
        public static int Calls;
        public void Deconstruct(out int x, out int y) { Calls++; throw new System.InvalidOperationException(); }
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            var parentheses = r is R((_), (_));
            var conjunction = r is R((_ and _), _);
            var disjunction = r is R((_ or _), _);
            return $"{parentheses},{conjunction},{disjunction},{R.Calls}";
        }
    }
}`)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RenamedSourceInterfaceDeconstruction_ReportsDispatchGap(forEach bool) {
        let body = if forEach {
            `int x = 0, y = 0;
            foreach (var (a, b) in new IParts[] { new R { X = 2, Y = 3 } }) { x = a; y = b; }`
        } else {
            "IParts parts = new R { X = 2, Y = 3 }; var (x, y) = parts;"
        }
        let source = (`
namespace RecordDeconstruction {
    public interface IParts { void Deconstruct(out int x, out int y); }
    public record R : IParts {
        public int X;
        public int Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public static class Probe {
        public static string Run() {
            BODY
            return $"{x},{y}";
        }
    }
}`).Replace("BODY", body)
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(
            project.Compilation.WithAssemblyName("InterfaceBaseline" + Guid.NewGuid().ToString("N")).Emit(image).Success
        )
        Assert.Equal(
            "30,2",
            cast[string](
                Assembly.Load(image.ToArray()).GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        let gap = Assert.Single(
            context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        )
        Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
        Assert.Contains("renamed interface or non-record contract", gap.Message)
        Assert.Equal(source.IndexOf("void Deconstruct", StringComparison.Ordinal), gap.Location!!.SourceSpan.Start)
    }

    @Theory
    @InlineData("record", false)
    @InlineData("record class", false)
    @InlineData("record struct", false)
    @InlineData("record", true)
    @InlineData("record class", true)
    @InlineData("record struct", true)
    func BodyRecord_CustomDeconstruct_PreservesAllConsumersAndValueSemantics(kind string, properties bool) {
        let members = if properties {
            "public int X { get; init; } public int Y { get; init; }"
        } else {
            "public int X; public int Y;"
        }
        Verify((`
using System;
namespace RecordDeconstruction {
    public RECORD_KIND R {
        MEMBERS
        public static int Calls;
        public void Deconstruct(out int x, out int y) {
            Calls++;
            x = Y * 10;
            y = X;
        }
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            var equal = r == new R { X = 2, Y = 3 };
            var copy = r with { X = 5 };
            var (a, b) = r;
            int c = 0, d = 0;
            (c, d) = r;
            var total = 0;
            foreach (var (e, f) in new[] { r, copy }) total += e + f;
            var typed = r is R(var g, var h) ? g + h : -1;
            var bare = r is (var i, var j) ? i + j : -1;
            var arm = r switch { R(30, 2) => 1, _ => 0 };
            var statement = 0;
            switch (r) { case (30, 2): statement = 1; break; }
            var discarded = r is (_, _);
            r.Deconstruct(out var directX, out var directY);
            object absent = null;
            var nil = absent is R(_, _);
            return $"{a},{b}|{c},{d}|{total}|{typed},{bare},{arm},{statement},{discarded},{nil}" +
                $"|{directX},{directY}|{equal},{r == copy}|{copy}|{R.Calls}";
        }
    }
}
`).Replace("RECORD_KIND", kind).Replace("MEMBERS", members))
    }

    @Theory
    @InlineData("record", false)
    @InlineData("record class", false)
    @InlineData("record struct", false)
    @InlineData("record", true)
    @InlineData("record class", true)
    @InlineData("record struct", true)
    func PositionalRecord_CustomAndOverloadedDeconstruct_PreservesSelectedArity(kind string, replacePrimary bool) {
        let custom = if replacePrimary {
            "public void Deconstruct(out int u, out int v) { Calls++; u = Y * 10; v = X; }"
        } else {
            ""
        }
        Verify((`
namespace RecordDeconstruction {
    public RECORD_KIND R(int X, int Y) {
        public static int Calls;
        CUSTOM
        public void Deconstruct(out int u, out int v, out int w) {
            Calls++;
            u = Y * 10;
            v = X;
            w = X + Y;
        }
    }
    public static class Probe {
        public static string Run() {
            var r = new R(2, 3);
            var copy = r with { X = 5 };
            var (a, b) = r;
            var (c, d, e) = r;
            int f = 0, g = 0, h = 0;
            (f, g, h) = r;
            var total = 0;
            foreach (var (i, j, k) in new[] { r, copy }) total += i + j + k;
            var typed = r is R(var l, var m, var n) ? l + m + n : -1;
            var bare = r is (var o, var p, var q) ? o + p + q : -1;
            var arm = r switch { R(30, 2, 5) => 1, _ => 0 };
            var primary = r switch { R(var s, var t) => s + t };
            r.Deconstruct(out var directX, out var directY, out var directZ);
            return $"{a},{b}|{c},{d},{e}|{f},{g},{h}|{total}|{typed},{bare},{arm},{primary}" +
                $"|{directX},{directY},{directZ}|{r == new R(2, 3)},{r == copy}|{copy}|{R.Calls}";
        }
    }
}
`).Replace("RECORD_KIND", kind).Replace("CUSTOM", custom))
    }

    @Fact
    func MutableRecordStruct_DeconstructionUsesCopiesButDirectCallMutatesOriginal() {
        Verify(`
namespace RecordDeconstruction {
    public record struct R {
        public int X;
        public void Deconstruct(out int a, out int b) { a = ++X; b = X * 10; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R { X = 1 };
            var (a, b) = r;
            int c = 0, d = 0;
            (c, d) = r;
            r.Deconstruct(out var e, out var f);
            return $"{a},{b},{c},{d},{e},{f},{r.X}";
        }
    }
}`)
    }

    @Fact
    func PartialGenericRecord_NestedDeconstructionAndNameCollisions() {
        Verify(`
namespace RecordDeconstruction {
    public partial record R<T>(T Value) {
        public int deconstruct;
        public void deconstructTuple() { }
        public void deconstructTuple2() { }
    }
    public partial record R<T> {
        public void Deconstruct(out int count, out T item) { count = 7; item = Value; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R<string>("hi");
            var ((a, b), c) = (r, 2);
            ((a, b), c) = (r, 3);
            return $"{a},{b},{c}|{r == new R<string>("hi")}|{r with { Value = "bye" }}";
        }
    }
}`)
    }

    @Fact
    func InheritedVirtualDeconstruct_PreservesDispatchAndMethodGroups() {
        Verify(`
namespace RecordDeconstruction {
    public delegate void Parts(out int x, out int y);
    public record Base(int X, int Y) {
        public virtual void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
    public record R(int A, int B) : Base(A, B) {
        public override void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public static class Probe {
        public static string Run() {
            Base r = new R(2, 3);
            var (a, b) = r;
            Parts parts = r.Deconstruct;
            parts(out var c, out var d);
            var pattern = r is Base(var e, var f) ? e + f : -1;
            return $"{a},{b},{c},{d},{pattern}|{r with { X = 5 }}";
        }
    }
}`)
    }

    @Fact
    func NestedForEach_UserRecordOutputs_PreserveSelectedMethodsAndOuterArity() {
        Verify(`
#nullable enable
namespace RecordDeconstruction {
    public record R {
        public int X;
        public int Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public record Outer(R Child, int Tag) {
        public void Deconstruct(out R child, out int tag) { child = Child; tag = Tag * 10; }
    }
    public static class Probe {
        public static int WithRef(ref string? text, R r) {
            if (text == null) return 0;
            var total = 0;
            foreach (var ((a, b), c) in new[] { (r, 4) }) total += a + b + c;
            return text.Length + total;
        }
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            var total = 0;
            foreach (var ((a, b), c) in new[] { (r, 4) }) total += a + b + c;
            foreach (var ((a, b), c) in new[] { new Outer(r, 4) }) total += a + b + c;
            foreach (((int a, int b), int c) in new[] { (r, 4) }) total += a + b + c;
            string? text = "hi";
            return total.ToString() + "," + WithRef(ref text, r);
        }
    }
}`)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func UserRecordWithSelectedExtensionDeconstruct_ReportsGapInsteadOfReadingDataFields(forEach bool) {
        let body = if forEach {
            `int x = 0, y = 0, z = 0;
            foreach (var (a, b, c) in new[] { new R { X = 2, Y = 3, Z = 4 } }) { x = a; y = b; z = c; }`
        } else {
            "var (x, y, z) = new R { X = 2, Y = 3, Z = 4 };"
        }
        let source = (`
namespace RecordDeconstruction {
    public record R {
        public int X;
        public int Y;
        public int Z;
        public void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
    public static class Extensions {
        public static void Deconstruct(this R r, out int x, out int y, out int z) {
            x = r.Y * 10; y = r.X; z = r.Z * 50;
        }
    }
    public static class Probe {
        public static string Run() {
            BODY
            return $"{x},{y},{z}";
        }
    }
}`).Replace("BODY", body)
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(
            project.Compilation.WithAssemblyName("ExtensionBaseline" + Guid.NewGuid().ToString("N")).Emit(image).Success
        )
        Assert.Equal(
            "30,2,200",
            cast[string](
                Assembly.Load(image.ToArray()).GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        let gap = Assert.Single(
            context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        )
        Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
        Assert.Contains("extension Deconstruct calls", gap.Message)
        Assert.Equal(
            source.IndexOf("public void Deconstruct", StringComparison.Ordinal),
            gap.Location!!.SourceSpan.Start
        )
    }

    @Fact
    func NestedUserRecordPatterns_ReportGapInsteadOfRepeatingDeconstruct() {
        const source = `
namespace RecordDeconstruction {
    public record R {
        public int X;
        public int Y;
        public static int Calls;
        public void Deconstruct(out int x, out int y) { Calls++; x = Y * 10; y = X; }
    }
    public class Holder { public R Child = new R { X = 2, Y = 3 }; }
    public static class Probe {
        public static string Run() {
            var result = new Holder() switch {
                Holder { Child: R(0, _) } => 0,
                Holder { Child: R(var x, var y) } => x + y,
                _ => -1
            };
            return $"{result},{R.Calls}";
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        using let image = MemoryStream()
        Assert.True(
            project.Compilation.WithAssemblyName("NestedBaseline" + Guid.NewGuid().ToString("N")).Emit(image).Success
        )
        Assert.Equal(
            "32,1",
            cast[string](
                Assembly.Load(image.ToArray()).GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        let gaps = context.Diagnostics.Where((diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported).ToArray()
        Assert.Equal(2, gaps.Length)
        Assert.All(
            gaps,
            (gap TranslationDiagnostic) -> {
                Assert.Equal(UnsupportedClassification.Gap, gap.Classification)
                Assert.Contains("nested user-declared record Deconstruct", gap.Message)
            }
        )
        Assert.Equal(
            []int32{
                source.IndexOf("R(0, _)", StringComparison.Ordinal),
                source.IndexOf("R(var x, var y)", StringComparison.Ordinal)
            },
            gaps.Select((gap TranslationDiagnostic) -> gap.Location!!.SourceSpan.Start).ToArray()
        )
    }

    @Fact
    func UserRecordDeconstruct_RemovesByReferenceNarrowingFacts() {
        Verify(`
#nullable enable
namespace RecordDeconstruction {
    public record R(int X, int Y) {
        public void Deconstruct(out int a, out int b) { a = Y * 10; b = X; }
    }
    public static class Probe {
        public static int Decl(ref string? text, R r) {
            if (text == null) return 0;
            var (a, b) = r;
            return text.Length + a + b;
        }
        public static int Assign(ref string? text, R r) {
            if (text == null) return 0;
            int a = 0, b = 0;
            (a, b) = r;
            return text.Length + a + b;
        }
        public static int Pattern(ref string? text, R r) {
            if (text == null) return 0;
            return r is R(var a, var b) ? text.Length + a + b : -1;
        }
        public static int Arm(ref string? text, R r) {
            if (text == null) return 0;
            return r switch { R(var a, var b) => text.Length + a + b };
        }
        public static string Run() {
            string? text = "hi";
            var r = new R(2, 3);
            return $"{Decl(ref text, r)},{Assign(ref text, r)},{Pattern(ref text, r)},{Arm(ref text, r)}";
        }
    }
}`)
    }

    @Fact
    func SwitchArms_ShareDeconstructOutputsAndResetOnEveryEvaluation() {
        Verify(`
namespace RecordDeconstruction {
    public record R(int X, int Y) {
        public static int Calls;
        public void Deconstruct(out int a, out int b) { Calls++; a = Y * 10; b = X; }
    }
    public static class Probe {
        public static string Run() {
            var r = new R(2, 3);
            var total = 0;
            for (var i = 0; i < 3; i++) {
                if (r is R(0, _) or R(30, 2)) total += 1;
                total += r switch { R(0, _) => 10, R(var a, var b) when a == 30 => a + b, _ => 0 };
                switch (r) {
                    case R(0, _): total += 10; break;
                    case R(var c, var d): total += c + d; break;
                }
            }
            return $"{total},{R.Calls}";
        }
    }
}`)
    }

    shared {
        private func Verify(source string, emittedSignature string? = nil) {
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            using let image = MemoryStream()
            let baseline = project.Compilation.WithAssemblyName("Baseline" + Guid.NewGuid().ToString("N")).Emit(image)
            Assert.True(baseline.Success, string.Join("\n", baseline.Diagnostics))
            let expected = cast[string](
                Assembly.Load(image.ToArray()).GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(
                    nil,
                    nil
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain("func __", printed)
            if emittedSignature != nil {
                Assert.Contains(emittedSignature, printed)
            }
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) ->
                diagnostic.Severity == TranslationSeverity.Unsupported
            )
            Assert.Contains("data ", printed)
            Assert.Equal(expected + "\n", CompileAndRun(printed).Replace("\r\n", "\n"))
        }

        private func CompileAndRun(printed string) string {
            var root DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while root != nil && !RepositoryRootMarker.IsRoot(root.FullName) {
                root = root.Parent
            }
            Assert.NotNull(root)
            let configuration = if AppContext.BaseDirectory.Contains(
                Path.DirectorySeparatorChar + "Release" + Path.DirectorySeparatorChar
            ) {
                "Release"
            } else {
                "Debug"
            }
            let compiler = Path.Combine(root!!.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
            Assert.True(File.Exists(compiler), compiler)
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5699", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let source = Path.Combine(directory, "Snippet.gs")
                let output = Path.Combine(directory, "Snippet.dll")
                File.WriteAllText(source, printed + "\nSystem.Console.WriteLine(Probe.Run())\n")
                let compile = RunDotnet([]string{compiler, "/target:exe", "/out:" + output, source})
                Assert.True(compile.Exit == 0, compile.Output + "\n" + printed)
                let run = RunDotnet([]string{output})
                Assert.True(run.Exit == 0, run.Output)
                return run.Output
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func RunDotnet(arguments[]string)(Exit int32, Output string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start)!!
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            let completed = process.WaitForExit(120000)
            if !completed {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
            }
            Assert.True(completed, "Process exceeded two minutes.")
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }
    }
}
