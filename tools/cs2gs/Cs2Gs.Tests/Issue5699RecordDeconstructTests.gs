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
import System.Runtime.Loader
import Xunit

class Issue5699RecordDeconstructTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func BroaderSourceExtensions_InvokeSelectedOverloadForTheActualRecordReceiver(forEach bool) {
        let statement = if forEach {
            `int x = 0, y = 0, z = 0;
            foreach (var (a, b, c) in new[] { r }) { x = a; y = b; z = c; }`
        } else {
            "var (x, y, z) = r;"
        }
        Verify((`
namespace RecordDeconstruction {
    public record R {
        public int X = 2, Y = 3, Z = 4;
        public void Deconstruct(out int x, out int y) { x = 30; y = 2; }
    }
    public static class Extensions {
        public static void Deconstruct(this object r, out int x, out int y, out int z) {
            x = 70; y = 80; z = 90;
        }
    }
    public static class Probe {
        public static string Run() {
            var r = new R();
            STATEMENT
            var pat = r is R(70, 80, 90);
            var sw = r switch { R(70, 80, 90) => 1, _ => 0 };
            return $"{x},{y},{z},{pat},{sw}";
        }
    }
}`).Replace("STATEMENT", statement))
    }

    @Theory
    @InlineData("extension")
    @InlineData("extension foreach")
    @InlineData("broad extension")
    @InlineData("broad extension foreach")
    @InlineData("interface")
    @InlineData("interface deconstruct")
    @InlineData("unqualified")
    func MetadataContractsAndExtensions_PreserveDispatchAndSelectedOverloads(shape string) {
        const producer = `
namespace Producer {
    public interface IParts { void Deconstruct(out int x, out int y); }
    public record R : IParts {
        public int deconstruct;
        public int X = 2, Y = 3, Z = 4;
        public virtual void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`
        if shape == "unqualified" {
            const middle = `
namespace Middle {
    public record Mid : Producer.R {
        public int deconstruct2 = 9;
        public int deconstruct3 = 11;
        public override void Deconstruct(out int x, out int y) { x = Y * 10 + deconstruct2; y = X; }
    }
}`
            const thirdConsumer = `
namespace RecordDeconstruction {
    public record Child : Middle.Mid {
        public delegate void Parts(out int x, out int y);
        public override void Deconstruct(out int x, out int y) { x = Y * 10 + deconstruct2; y = X; }
        public Parts Save() => Deconstruct;
    }
    public class ConsumerExplicit : Producer.IParts {
        void Producer.IParts.Deconstruct(out int x, out int y) { x = 91; y = 92; }
    }
    public static class Probe {
        public static string Run() {
            var child = new Child();
            var saved = child.Save();
            saved(out var x, out var y);
            Middle.Mid mid = child;
            var (mx, my) = mid;
            Producer.IParts expConsumer = new ConsumerExplicit();
            var (ex, ey) = expConsumer;
            return $"{x},{y},{mx},{my},{ex},{ey},{mid.deconstruct2}";
        }
    }
}`
            VerifyThreeMigratedCompilations(producer, middle, thirdConsumer)
            return
        }
        let consumer = (`
namespace RecordDeconstruction {
    public static class Extensions {
        public static void Deconstruct(this RECEIVER r, out int x, out int y, out int z) {
            x = 70; y = 80; z = 90;
        }
    }
    public static class Probe {
        public static string Run() {
            var r = new Producer.R();
            STATEMENT
        }
    }
}`).Replace(
            "STATEMENT",
            switch shape {
                case "extension" or "broad extension": "var (x, y, z) = r; return $\"{x},{y},{z}\";"
                case "extension foreach" or "broad extension foreach":
                "int x = 0, y = 0, z = 0; foreach (var (a, b, c) in new[] { r }) { x = a; y = b; z = c; } return $\"{x},{y},{z}\";"
                case "interface deconstruct":
                "Producer.IParts parts = r; var (x, y) = parts; return $\"{x},{y}\";"
                default: "Producer.IParts parts = r; parts.Deconstruct(out var x, out var y); return $\"{x},{y}\";"
            }
        )
            .Replace(
            "RECEIVER",
            if shape.StartsWith("broad", StringComparison.Ordinal) {
                "object"
            } else {
                "Producer.R"
            }
        )
        VerifyMigratedProducerAndConsumer(producer, consumer)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RenamedImplicitThisReferences_CannotBindShadowingDelegates(parameter bool) {
        Verify((`
namespace RecordDeconstruction {
    public record R {
        public delegate void Parts(out int x, out int y);
        public void Deconstruct(out int x, out int y) { x = 30; y = 2; }
        public string Work(PARAMETER) {
            LOCAL
            Parts selected = Deconstruct;
            selected(out var x, out var y);
            Deconstruct(out var a, out var b);
            return $"{x},{y},{a},{b}";
        }
    }
    public static class Probe {
        public static void Wrong(out int x, out int y) { x = -3; y = -4; }
        public static string Run() => new R().Work(ARGUMENT);
    }
}`).Replace(
                "PARAMETER",
                if parameter {
                    "Parts deconstruct"
                } else {
                    ""
                }
            ).Replace(
                "LOCAL",
                if parameter {
                    ""
                } else {
                    "Parts deconstruct = Probe.Wrong;"
                }
            ).Replace(
                "ARGUMENT",
                if parameter {
                    "Wrong"
                } else {
                    ""
                }
            ))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CachedPatterns_RetranslateWithStableDistinctScopeNames(duplicated bool) {
        let record = ("Record.cs", `
namespace RecordDeconstruction {
    public record R {
        public void Deconstruct(out int x, out int y) { x = 30; y = 2; }
    }
}`)
        let body = if duplicated {
            `public static bool Test(R r, int kind) {
                switch (kind) {
                    case 0:
                    case 1 when true: return r is R(0, _) or R(30, _);
                    default: return false;
                }
            }
            public static string Run() => Test(new R(), 0) + "," + Test(new R(), 1);`
        } else {
            `public static bool Test(R r) => r is R(0, _) or R(30, _);
            public static string Run() => Test(new R()).ToString();`
        }
        Verify(
            [](string, string){
                record,
                ("Consumer.cs", "namespace RecordDeconstruction { public static class Probe { " + body + " } }")
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SeparateDocuments_ReuseTheCanonicalAdapterName(consumerFirst bool) {
        let declaration = ("Record.cs", `
namespace RecordDeconstruction {
    public record R {
        public int X = 2, Y = 3;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`)
        let consumer = ("Consumer.cs", `
namespace RecordDeconstruction {
    public static class Probe {
        public static string Run() {
            var r = new R();
            var (x, y) = r;
            return $"{x},{y}";
        }
    }
}`)
        Verify(
            if consumerFirst {
                [](string, string){consumer, declaration}
            } else {
                [](string, string){declaration, consumer}
            }
        )
    }

    @Theory
    @InlineData("foreach")
    @InlineData("await foreach")
    @InlineData("nested")
    @InlineData("nested foreach")
    @InlineData("pattern")
    @InlineData("switch pattern")
    @InlineData("method group")
    func MetadataRecursiveAndForEachConsumers_PreserveMigratedProducerDeconstruct(shape string) {
        const producer = `
namespace Producer {
    public record struct R {
        public int X, Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`
        let statement = if shape == "foreach" {
            "var total = 0; foreach (var (x, y) in new[] { r }) { total += x + y; } return total.ToString();"
        } else if shape == "await foreach" {
            "var total = 0; await foreach (var (x, y) in Values(r)) { total += x + y; } return total.ToString();"
        } else if shape == "nested" {
            "var ((x, y), tag) = (r, 1); return $\"{x},{y},{tag}\";"
        } else if shape == "pattern" {
            "if (r is Producer.R(30, 2)) return \"matched\"; return \"\";"
        } else if shape == "switch pattern" {
            "return r switch { Producer.R(30, 2) => \"matched\", _ => \"\" };"
        } else if shape == "method group" {
            "Read read = r.Deconstruct; read(out var x, out var y); return $\"{x},{y}\";"
        } else {
            "var total = 0; foreach (var ((x, y), tag) in new[] { (r, 1) }) { total += x + y + tag; } return total.ToString();"
        }
        let consumer = (`
namespace RecordDeconstruction {
    public static class Probe {
        public delegate void Read(out int x, out int y);
        public static async System.Threading.Tasks.Task<string> Step() {
            var r = new Producer.R { X = 2, Y = 3 };
            await System.Threading.Tasks.Task.CompletedTask;
            STATEMENT
        }
        public static string Run() => Step().GetAwaiter().GetResult();
        public static async System.Collections.Generic.IAsyncEnumerable<Producer.R> Values(Producer.R r) {
            yield return r;
            await System.Threading.Tasks.Task.CompletedTask;
        }
    }
}`).Replace("STATEMENT", statement)
        VerifyMigratedProducerAndConsumer(producer, consumer)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func InheritedAdapters_DoNotCollideWithDerivedLiftedHelpers(derivedFirst bool) {
        let parent = ("Parent.cs", `
namespace RecordDeconstruction {
    public record Parent {
        public int Value = 7;
        public void Deconstruct(out int x, out int y) { x = 30; y = 2; }
    }
}`)
        let child = ("Child.cs", `
namespace RecordDeconstruction {
    public record Child : Parent {
        public string Work() {
            int deconstructTuple() { return Bounce<int>(0); }
            int Bounce<T>(int n) { return n == 0 ? Value : deconstructTuple(); }
            var (x, y) = this;
            return $"{x},{y},{deconstructTuple()}";
        }
    }
    public static class Probe {
        public static string Run() => new Child().Work();
    }
}`)
        Verify(
            if derivedFirst {
                [](string, string){child, parent}
            } else {
                [](string, string){parent, child}
            }
        )
    }

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
    func MetadataConsumersOfMigratedRecords_UseProducerRenamedAndAdaptedMembers(kind string) {
        let producer = (`
namespace Producer {
    public KIND R {
        public int X, Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`).Replace("KIND", kind)
        const consumer = `
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
        VerifyMigratedProducerAndConsumer(producer, consumer)
    }

    @Theory
    @InlineData("record", false, false)
    @InlineData("record", true, false)
    @InlineData("record class", false, false)
    @InlineData("record class", true, false)
    @InlineData("record struct", false, false)
    @InlineData("record struct", true, false)
    @InlineData("record", false, true)
    @InlineData("record", true, true)
    @InlineData("record struct", false, true)
    @InlineData("record struct", true, true)
    func PointerAndFunctionPointerOutputs_EmitAdaptersAndPreserveConsumers(
        kind string,
        scalar bool,
        functionPointer bool
    ) {
        let source = if functionPointer {
            (`
namespace RecordDeconstruction {
    public KIND R {
        public static int Double(int v) => v * 2;
        public unsafe void Deconstruct(PARAMETERS) { BODY }
    }
    public static class Probe {
        public static unsafe string Run() {
            var r = new R();
            CONSUMER
        }
    }
}`).Replace(
                "KIND",
                kind
            ).Replace(
                "PARAMETERS",
                if scalar {
                    "out delegate*<int, int> fn"
                } else {
                    "out delegate*<int, int> fn, out int n"
                }
            ).Replace(
                "BODY",
                if scalar {
                    "fn = &Double;"
                } else {
                    "fn = &Double; n = 5;"
                }
            ).Replace(
                "CONSUMER",
                if scalar {
                    "var pat = r is R(var f) ? f(7) : -1; r.Deconstruct(out var direct); return $\"{pat},{direct(3)}\";"
                } else {
                    `var (fn, n) = r;
                    delegate*<int, int> a = null;
                    int b = 0;
                    (a, b) = r;
                    var total = 0;
                    foreach (var (qf, qn) in new[] { r }) total += qf(qn);
                    var pat = r is R(var pf, var pn) ? pf(pn) : -1;
                    r.Deconstruct(out var df, out var dn);
                    return $"{fn(n)},{a(b)},{total},{pat},{df(dn)}";`
                }
            )
        } else {
            (`
namespace RecordDeconstruction {
    public KIND R {
        public static int[] Cells = new[] { 42 };
        public unsafe void Deconstruct(PARAMETERS) { BODY }
    }
    public static class PtrExt {
        public static unsafe void Deconstruct(this object value, out int* p, out int n, out int tag) {
            fixed (int* ptr = R.Cells) p = ptr;
            n = 5;
            tag = 7;
        }
    }
    public static class Probe {
        public static unsafe string Run() {
            fixed (int* cell = R.Cells) {
                var r = new R();
                CONSUMER
            }
        }
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
                    "fixed (int* ptr = Cells) p = ptr;"
                } else {
                    "fixed (int* ptr = Cells) p = ptr; n = 5;"
                }
            ).Replace(
                "CONSUMER",
                if scalar {
                    "var pat = r is R(var p) ? *p : -1; r.Deconstruct(out var direct); return $\"{pat},{*direct}\";"
                } else {
                    `var (p, n) = r;
                    var (ep, en, etag) = r;
                    int* a = null;
                    int b = 0;
                    int t = 0;
                    (a, b) = r;
                    (a, b, t) = r;
                    var total = 0;
                    foreach (var (qp, qn) in new[] { r }) total += *qp + qn;
                    var pat = r is R(var pp, var pn) ? *pp + pn : -1;
                    r.Deconstruct(out var dp, out var dn);
                    return $"{*p},{n},{*ep},{en},{etag},{*a},{b},{t},{total},{pat},{*dp},{dn}";`
                }
            )
        }
        Verify(source)
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

    @Theory
    @InlineData(false)
    @InlineData(true)
    func MixedPositionalPropertyDecision_PreservesRoslynReceiverAndOutputEvaluation(separateClauses bool) {
        Verify((`
#nullable enable
namespace RecordDeconstruction {
    public record R {
        public int Value = 3;
        public static System.Action? Hook;
        public void Deconstruct(out int x, out int y) { x = 1; y = 2; Hook?.Invoke(); }
    }
    public record Sub : R {
        public int Extra = 9;
    }
    public static class Probe {
        public static string Run() {
            R? r = new R();
            R.Hook = () => r = null;
            string first;
            try { first = (r is PATTERN).ToString(); }
            catch (System.NullReferenceException) { first = "threw"; }
            R? rSingle = new R();
            R.Hook = () => rSingle = null;
            string singleOutcome;
            try { singleOutcome = (rSingle is R(1, _) { Value: 3 }).ToString(); }
            catch (System.NullReferenceException) { singleOutcome = "threw"; }
            object? boxedCleared = new R();
            R.Hook = () => boxedCleared = null;
            var boxedClearedMatch = boxedCleared is PATTERN;
            object? boxedSingleCleared = new R();
            R.Hook = () => boxedSingleCleared = null;
            var boxedSingleClearedMatch = boxedSingleCleared is R(1, _) { Value: 3 };
            R.Hook = null;
            R plain = new R();
            var subtypeMiss = plain is R(0, _) or Sub { Extra: 9 };
            var inheritedSubtypeMiss = plain is R(0, _) or Sub(1, _) { Extra: 9 };
            object boxed = new R();
            var boxedMatch = boxed is PATTERN;
            return $"{first},{singleOutcome},{boxedClearedMatch},{boxedSingleClearedMatch},{subtypeMiss},{inheritedSubtypeMiss},{boxedMatch}";
        }
    }
}`).Replace(
                "PATTERN",
                if separateClauses {
                    "R(0, _) or R { Value: 3 }"
                } else {
                    "R(0, _) or R(1, _) { Value: 3 }"
                }
            ))
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
    func ImportedDeconstructContracts_EmitDispatchPreservingBridges(overrideBase bool) {
        const external = `
namespace External {
    public interface IParts {
        int Count { get; }
        int Reset();
        int Deconstruct(int scale);
        void Deconstruct(out int x, out int y);
    }
    public interface IStaticParts {
        static abstract int Deconstruct(int scale);
    }
    public interface IA {
        void Deconstruct(out int x, out int y);
    }
    public interface IB {
        void Deconstruct(out int x, out int y);
    }
    public interface IHasCount {
        int Count { get; }
    }
    public interface IDerivedParts : IHasCount {
        void Deconstruct(out int x, out int y);
    }
    public record Base {
        public int X, Y;
        public Base() { }
        public Base(ref int seed) { X = ++seed; Y = seed + 1; }
        public virtual void Deconstruct(out int x, out int y) { x = X; y = Y; }
        protected virtual void Deconstruct(out int x, out int y, out int z) { x = X; y = Y; z = X + Y; }
        public string RunProtected() {
            Deconstruct(out var x, out var y, out var z);
            return $"{x},{y},{z}";
        }
    }
    public abstract record AbstractExternal {
        protected abstract void Deconstruct(out int x, out int y);
    }
    public unsafe record ExtPtr {
        public static int[] Cells = new[] { 42 };
        public void Deconstruct(out int* p, out int n) { fixed (int* ptr = Cells) p = ptr; n = 5; }
    }
    public static class Ext {
        public static void Deconstruct(this object value, out int x, out int y, out int z) {
            x = 10; y = 20; z = 30;
        }
    }
}`
        let part1 = (`
using External;
namespace RecordDeconstruction {
    public partial record R : PARENT {
        FIELDS
    }
}`).Replace(
            "PARENT",
            if overrideBase {
                "External.Base"
            } else {
                "External.IParts"
            }
        )
            .Replace(
            "FIELDS",
            if overrideBase {
                ""
            } else {
                "public int X, Y; public int Count => X + Y; public int Reset() => Count * 2; public int Deconstruct(int scale) => (X + Y) * scale;"
            }
        )
        let part2 = (`
using External;
namespace RecordDeconstruction {
    public partial record R {
        public OVERRIDE void Deconstruct(out int x, out int y) { BODY }
    }
    EXTRA_TYPES
    public static class Probe {
        public static string Run() {
            var r = new R { X = 2, Y = 3 };
            r.Deconstruct(out var x, out var y);
            var (a, b) = r;
            PARENT contract = r;
            contract.Deconstruct(out var c, out var d);
            var (e, f) = contract;
            var (ex1, ex2, ex3) = r;
            int ptrCell = 0, len = 0;
            unsafe {
                var (ptr, ptrLen) = new External.ExtPtr();
                ptrCell = *ptr;
                len = ptrLen;
            }
            EXTRA_ASSERT
            return $"{x},{y},{a},{b},{c},{d},{e},{f},{ex1},{ex2},{ex3},{ptrCell},{len},{extra},{r == new R { X = 2, Y = 3 }}";
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
            "OVERRIDE",
            if overrideBase {
                "override"
            } else {
                ""
            }
        ).Replace(
            "BODY",
            if overrideBase {
                "base.Deconstruct(out var bx, out var by); x = by * 10; y = bx;"
            } else {
                "x = Y * 10; y = X;"
            }
        ).Replace(
            "EXTRA_TYPES",
            if overrideBase {
                `public record Derived : R { public override void Deconstruct(out int x, out int y) { x = Y * 100; y = X; } }
                public record ProtectedRecord : External.Base {
                    public ProtectedRecord(ref int seed) : base(ref seed) { }
                    protected override void Deconstruct(out int x, out int y, out int z) {
                        base.Deconstruct(out var bx, out var by, out var bz);
                        x = bx * 10; y = by * 10; z = bz * 10;
                    }
                    public string ReadSelf() { var (px, py, pz) = this; return $"{px},{py},{pz}"; }
                }
                public abstract record AbstractDerived : External.AbstractExternal {
                    protected override void Deconstruct(out int x, out int y) { x = 1; y = 2; }
                }`
            } else {
                `public class C : External.IParts {
                    public int X, Y;
                    public int Count => X + Y;
                    public int Reset() => Count;
                    public int Deconstruct(int scale) => (X + Y) * scale;
                    public void Deconstruct(out int x, out int y) { x = Y * 100; y = X; }
                }
                public record BaseRec {
                    public int Tag;
                    internal BaseRec(int v) { Tag = v; }
                    public void Deconstruct(out int x, out int y) { x = Tag * 10; y = 1; }
                }
                public record InheritedImpl : BaseRec, External.IParts {
                    public InheritedImpl(int v) : base(v) { }
                    public int Count => Tag;
                    public int Reset() => Tag;
                    public int Deconstruct(int scale) => Tag * scale;
                }
                public abstract record AbstractPropBase {
                    public abstract int Count { get; }
                }
                public record ConcretePropRecord : AbstractPropBase, External.IParts {
                    public override int Count => 7;
                    public int Reset() => Count;
                    public int Deconstruct(int scale) => Count * scale;
                    public void Deconstruct(out int x, out int y) { x = Count * 10; y = 3; }
                }
                public class Outer {
                    public record R : External.IParts {
                        public class RDeconstructBridge { }
                        public int Count => 4;
                        public int Reset() => 4;
                        public int Deconstruct(int scale) => 4 * scale;
                        public void Deconstruct(out int x, out int y) { x = 40; y = 4; }
                    }
                }
                public class classDeconstructBridge { }
                public record @class : External.IParts {
                    public int Count => 5;
                    public int Reset() => 5;
                    public int Deconstruct(int scale) => 5 * scale;
                    public void Deconstruct(out int x, out int y) { x = 50; y = 5; }
                }
                public record ExplicitRec : External.IParts {
                    public int Count => 6;
                    public int Reset() => 6;
                    int External.IParts.Deconstruct(int scale) => 6 * scale;
                    void External.IParts.Deconstruct(out int x, out int y) { x = 60; y = 6; }
                }
                public record DualExplicit : External.IA, External.IB {
                    void External.IA.Deconstruct(out int x, out int y) { x = 70; y = 7; }
                    void External.IB.Deconstruct(out int x, out int y) { x = 80; y = 8; }
                }
                public record DerivedPartsRec : External.IDerivedParts {
                    public int Count => 9;
                    void External.IDerivedParts.Deconstruct(out int x, out int y) { x = 90; y = 9; }
                }`
            }
        ).Replace(
            "EXTRA_ASSERT",
            if overrideBase {
                "External.Base dContract = new Derived { X = 2, Y = 3 }; var (dx, dy) = dContract; int seed = 6; var prot = new ProtectedRecord(ref seed); var extra = $\"{dx},{dy},{seed},{prot.RunProtected()},{prot.ReadSelf()}\";"
            } else {
                "External.IParts cContract = new C { X = 2, Y = 3 }; var (cx, cy) = cContract; External.IParts inh = new InheritedImpl(7); var (ix, iy) = inh; External.IParts propRec = new ConcretePropRecord(); var (prx, pry) = propRec; External.IParts nestedRec = new Outer.R(); var (nrx, nry) = nestedRec; External.IParts kwRec = new @class(); var (kwx, kwy) = kwRec; External.IParts expRec = new ExplicitRec(); var (erx, ery) = expRec; External.IA da = new DualExplicit(); var (dax, day) = da; External.IB db = new DualExplicit(); var (dbx, dby) = db; External.IDerivedParts dp = new DerivedPartsRec(); var (dpx, dpy) = dp; var extra = $\"{cx},{cy},{ix},{iy},{prx},{pry},{nrx},{nry},{kwx},{kwy},{erx},{ery},{dax},{day},{dbx},{dby},{dpx},{dpy},{dp.Count},{expRec.Deconstruct(2)},{contract.Count},{contract.Reset()},{contract.Deconstruct(3)},{cContract.Deconstruct(4)}\";"
            }
        )
        VerifyWithExternalReference(external, [](string, string){("Part1.cs", part1), ("Part2.cs", part2)})
        if !overrideBase {
            VerifyExternalUnsupported(external, `
namespace RecordDeconstruction {
    public record StaticRec : External.IStaticParts {
        public static int Deconstruct(int scale) => scale * 2;
    }
}`)
        }
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
    func RenamedSourceInterfaceDeconstruction_PreservesDispatch(forEach bool) {
        let body = if forEach {
            `int x = 0, y = 0;
            foreach (var (a, b) in new IParts[] { new R { X = 2, Y = 3 } }) { x = a; y = b; }`
        } else {
            "IParts parts = new R { X = 2, Y = 3 }; var (x, y) = parts;"
        }
        Verify((`
namespace RecordDeconstruction {
    public interface IParts {
        void Deconstruct(out int x, out int y) { x = 11; y = 22; }
    }
    public class DefaultImpl : IParts { }
    public class ExplicitImpl : IParts {
        void IParts.Deconstruct(out int x, out int y) { x = 77; y = 88; }
    }
    public record R : IParts {
        public int X;
        public int Y;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
        public int Check() {
            int deconstructTuple(int n) => n <= 0 ? X + Y : deconstructTuple(n - 1);
            return deconstructTuple(1);
        }
    }
    public static class Probe {
        public static string Run() {
            BODY
            IParts defParts = new DefaultImpl();
            var (dx, dy) = defParts;
            IParts expParts = new ExplicitImpl();
            var (ex, ey) = expParts;
            return $"{x},{y},{dx},{dy},{ex},{ey},{new R { X = 2, Y = 3 }.Check()}";
        }
    }
}`).Replace("BODY", body))
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
    public record Z(int X, int Y) {
        public virtual void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
    public record A(int A1, int B1) : Z(A1, B1) {
        public override void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public abstract record AbstractBase {
        public abstract void Deconstruct(out int x, out int y);
    }
    public record Concrete : AbstractBase {
        public int X = 4, Y = 5;
        public override void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public static class Probe {
        public static string Run() {
            Z r = new A(2, 3);
            var (a, b) = r;
            Parts parts = r.Deconstruct;
            parts(out var c, out var d);
            var pattern = r is Z(var e, var f) ? e + f : -1;
            AbstractBase abs = new Concrete();
            var (ax, ay) = abs;
            return $"{a},{b},{c},{d},{pattern},{ax},{ay}|{r with { X = 5 }}";
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
    func UserRecordWithSelectedExtensionDeconstruct_InvokesSelectedExtensionOverload(forEach bool) {
        let body = if forEach {
            `int x = 0, y = 0, z = 0;
            foreach (var (a, b, c) in new[] { new R { X = 2, Y = 3, Z = 4 } }) { x = a; y = b; z = c; }`
        } else {
            "var (x, y, z) = new R { X = 2, Y = 3, Z = 4 };"
        }
        Verify((`
#nullable enable
namespace RecordDeconstruction {
    public record R {
        public int X;
        public int Y;
        public int Z;
        public void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
    public record struct RS {
        public int X;
        public int Y;
        public int Z;
        public void Deconstruct(out int x, out int y) { x = X; y = Y; }
    }
    public static class Extensions {
        public static void Deconstruct(this R? component0, out int x, out int y, out int z) {
            if (component0 is null) { x = -1; y = -2; z = -3; return; }
            x = component0.Y * 10; y = component0.X; z = component0.Z * 50;
        }
        public static void Deconstruct(this ref RS r, out int x, out int y, out int z) {
            r.X += 100;
            x = r.X; y = r.Y; z = r.Z;
        }
        public static void Deconstruct(this in RS r, out int x, out int y, out int z, out int w) {
            x = r.X; y = r.Y; z = r.Z; w = r.X + r.Y + r.Z;
        }
    }
    public static class Probe {
        public static string Run() {
            BODY
            R? absent = null;
            var (nx, ny, nz) = absent;
            var rs = new RS { X = 2, Y = 3, Z = 4 };
            var (ix, iy, iz, iw) = rs;
            rs.Deconstruct(out var rx, out var ry, out var rz);
            return $"{x},{y},{z},{nx},{ny},{nz},{ix},{iy},{iz},{iw},{rx},{ry},{rz},{rs.X}";
        }
    }
}`).Replace("BODY", body))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedUserRecordPatterns_ShareReceiverAndOutputState(mutateNestedReceiver bool) {
        let hook = if mutateNestedReceiver {
            "Holder.Current.Child = null;"
        } else {
            ""
        }
        Verify((`
namespace RecordDeconstruction {
    public record R {
        public int X;
        public int Y;
        public static int Calls;
        public void Deconstruct(out int x, out int y) { Calls++; x = Y * 10; y = X; HOOK }
    }
    public class Holder {
        public static Holder Current;
        public R Child = new R { X = 2, Y = 3 };
    }
    public class DerivedHolder : Holder {
        public new R Child = new R { X = 4, Y = 5 };
    }
    public class OuterHolder {
        public static int Reads;
        private Holder inner = new Holder();
        public Holder Inner { get { Reads++; return inner; } }
    }
    public interface ICarrier<T> {
        R Child { get; }
    }
    public class Carrier : ICarrier<int>, ICarrier<string> {
        private R first = new R { X = 2, Y = 3 };
        private R second = new R { X = 7, Y = 8 };
        R ICarrier<int>.Child => first;
        R ICarrier<string>.Child => second;
    }
    public record Outer {
        public R First = new R { X = 2, Y = 3 };
        public R Second = new R { X = 6, Y = 7 };
        public void Deconstruct(out R child, out int a) { child = First; a = 1; }
        public void Deconstruct(out R child, out int a, out int b) { child = Second; a = 1; b = 2; }
    }
    public static class Probe {
        public static string Run() {
            Holder.Current = new Holder();
            var result = Holder.Current switch {
                Holder { Child: R(0, _) } => 0,
                Holder { Child: R(var x, var y) } => x + y,
                _ => -1
            };
            var firstCalls = R.Calls;
            var firstNull = Holder.Current.Child is null;
            Holder.Current = new Holder();
            Holder hiddenSubject = new DerivedHolder();
            var hiddenResult = hiddenSubject switch {
                DerivedHolder { Child: R(0, _) } => 0,
                Holder { Child: R(var hx, var hy) } => hx + hy,
                _ => -1
            };
            Holder.Current = new Holder();
            var overloadResult = new Outer() switch {
                Outer(R(0, _), _) => 0,
                Outer(R(var ox, var oy), _, _) => ox + oy,
                _ => -1
            };
            Holder.Current = new Holder();
            var dottedResult = new OuterHolder() switch {
                OuterHolder { Inner.Child: R(0, _) } => 0,
                OuterHolder { Inner: { Child: R(var dx, var dy) } } => dx + dy,
                _ => -1
            };
            Holder.Current = new Holder();
            object carrier = new Carrier();
            var carrierResult = carrier switch {
                ICarrier<int> { Child: R(0, _) } => 0,
                ICarrier<string> { Child: R(var cx, var cy) } => cx + cy,
                _ => -1
            };
            Holder.Current = new Holder();
            var items = new[] { new R { X = 1, Y = 9 }, new R { X = 2, Y = 1 }, new R { X = 5, Y = 3 } };
            var listMatch = items is [_, R(0, _), ..] or [.., R(30, 5)];
            return $"{result},{firstCalls},{firstNull},{hiddenResult},{overloadResult},{dottedResult},{OuterHolder.Reads},{carrierResult},{listMatch},{R.Calls}";
        }
    }
}`).Replace("HOOK", hook))
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

    @Fact
    func UnsafeSameArityPointerOverloadsAndCovariantPatternCache_PreserveParity() {
        Verify(`
#nullable enable
namespace RecordDeconstruction {
    public interface IGenericParts<T> {
        void Deconstruct(out T x, out int y);
    }
    public record MultiParts : IGenericParts<int>, IGenericParts<string> {
        public int Num = 7;
        public string Text = "hi";
        public void Deconstruct(out int x, out int y) { x = Num; y = Num * 2; }
        public void Deconstruct(out string x, out int y) { x = Text; y = Text.Length; }
    }
    public interface IBoxedParts {
        void Deconstruct(out int x, out int y);
    }
    public record struct BoxedCounter : IBoxedParts {
        public int Count;
        public void Deconstruct(out int x, out int y) {
            Count++;
            x = Count;
            y = Count * 10;
        }
    }
    public unsafe record OverloadedPtr {
        public static int[] IntCells = new[] { 11 };
        public static long[] LongCells = new[] { 22L };
        public void Deconstruct(out int* p, out int tag) {
            fixed (int* ptr = IntCells) { p = ptr; }
            tag = 1;
        }
        public void Deconstruct(out long* p, out int tag) {
            fixed (long* ptr = LongCells) { p = ptr; }
            tag = 2;
        }
    }
    public unsafe static class UnsafeExtensions {
        public static void Deconstruct(this OverloadedPtr r, out int* p, out int a, out int b) {
            fixed (int* ptr = OverloadedPtr.IntCells) { p = ptr; }
            a = 3;
            b = 4;
        }
        public static void Deconstruct(this OverloadedPtr r, out long* p, out int a, out int b) {
            fixed (long* ptr = OverloadedPtr.LongCells) { p = ptr; }
            a = 5;
            b = 6;
        }
        public static void Deconstruct(this R r, out int x, out int y, out int z) {
            x = r.X + 10;
            y = r.Y + 20;
            z = r.X + r.Y;
        }
        public static void Deconstruct(this R r, int* x, out int y, out int z) {
            y = -1;
            z = -2;
        }
    }
    public record R {
        public int X;
        public int Y;
        public static int Calls;
        public static System.Action? ClearFirst;
        public void Deconstruct(out int x, out int y) {
            Calls++;
            x = Y * 10;
            y = X;
            ClearFirst?.Invoke();
        }
    }
    public record D : R {
        public int Extra = 9;
    }
    public class Holder {
        public int Reads;
        private readonly R child;
        public Holder(R child) { this.child = child; }
        public virtual R Child { get { Reads++; return child; } }
    }
    public class DerivedHolder : Holder {
        private readonly D derivedChild;
        public DerivedHolder(D child) : base(child) { this.derivedChild = child; }
        public override D Child { get { Reads++; return derivedChild; } }
    }
    public static class Probe {
        public static unsafe string Run() {
            var item = new OverloadedPtr();
            int* ip;
            int itag;
            item.Deconstruct(out ip, out itag);
            long* lp;
            int ltag;
            item.Deconstruct(out lp, out ltag);
            int* eip;
            int ea, eb;
            UnsafeExtensions.Deconstruct(item, out eip, out ea, out eb);
            long* elp;
            int ela, elb;
            UnsafeExtensions.Deconstruct(item, out elp, out ela, out elb);
            var (rx, ry, rz) = new R { X = 2, Y = 3 };
            var mp = new MultiParts();
            int mi1, mi2;
            mp.Deconstruct(out mi1, out mi2);
            string ms1;
            int ms2;
            mp.Deconstruct(out ms1, out ms2);
            IGenericParts<int> gpi = mp;
            var (gix, giy) = gpi;
            IGenericParts<string> gps = mp;
            var (gsx, gsy) = gps;
            var bc = new BoxedCounter { Count = 1 };
            var (bc1, _) = bc;
            var (bc2, _) = bc;
            IBoxedParts bp = new BoxedCounter { Count = 1 };
            var (bp1, _) = bp;
            var (bp2, _) = bp;
            R?[] listItems = new R?[] { new R { X = 2, Y = 1 } };
            R.ClearFirst = () => listItems[0] = null;
            var listMatched = listItems is [R(0, _)] or [R(10, 2)];
            R.ClearFirst = null;
            Holder h = new DerivedHolder(new D { X = 2, Y = 3, Extra = 9 });
            var matched = h is DerivedHolder { Child: D(0, _) { Extra: 9 } } or Holder { Child: R(30, 2) };
            var untypedCovariant = h is DerivedHolder { Child: { Extra: 0 } } or Holder { Child: R(30, 2) };
            return $"{*ip},{itag},{*lp},{ltag},{*eip},{ea + eb},{*elp},{ela + elb},{rx},{ry},{rz},{mi1},{mi2},{ms1},{ms2},{gix},{giy},{gsx},{gsy},{bc1},{bc2},{bc.Count},{bp1},{bp2},{listMatched},{matched},{untypedCovariant}";
        }
    }
}`)
    }

    @Fact
    func ImportedContracts_CoverBridgeConstructorsValueSnapshotsEscapedOverridesAndInheritedSourceInterfaces() {
        let externalSource = `
namespace ExternalContracts {
    public interface IParts {
        void Deconstruct(out int x, out int y);
    }
    public interface IAsyncDeconstruct {
        System.Threading.Tasks.Task<int> Deconstruct(int delta);
    }
    public interface IRefDeconstruct {
        ref int Deconstruct();
        ref readonly int Deconstruct(short tag);
    }
    public record ProtectedBase {
        protected virtual void Deconstruct(out int x, out int y) { x = 1; y = 2; }
    }
    public unsafe record UnsafeCtorBase {
        public int Value;
        public UnsafeCtorBase() { Value = 5; }
        public UnsafeCtorBase(int* p) { Value = *p; }
    }
    public record CopyableBase(int X);
    public record struct MutatingStruct(int X, int Y) {
        public void Deconstruct(out int x, out int y) {
            X += 100;
            x = Y * 10;
            y = X;
        }
    }
    public class KeywordBase {
        public virtual int func() => 1;
    }
    public class UnrenamedBase {
        public int X = 4;
        public int Y = 7;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`
        let consumerSource = `
namespace RecordDeconstruction {
    public abstract record RefCtorBase {
        public int Seed;
        protected RefCtorBase(ref RefCtorBase other) {
            Seed = other.Seed + 5;
        }
        protected RefCtorBase(int seed) {
            Seed = seed;
        }
    }
    public record RefCtorDerived : RefCtorBase, ExternalContracts.IParts {
        public RefCtorDerived(ref RefCtorBase other) : base(ref other) { }
        public RefCtorDerived(int seed) : base(seed) { }
        public void Deconstruct(out int x, out int y) { x = Seed; y = Seed * 2; }
    }
    public abstract record GenericBase<T> {
        public int Value;
        protected GenericBase(GenericBase<int> other) {
            Value = (other == null ? 8 : other.Value) + 10;
        }
        protected GenericBase(int v) {
            Value = v;
        }
    }
    public record StringDerived : GenericBase<string>, ExternalContracts.IParts {
        public StringDerived(GenericBase<int> other) : base(other) { }
        public void Deconstruct(out int x, out int y) { x = Value; y = Value + 1; }
    }
    public record ProtectedHookCollision : ExternalContracts.ProtectedBase {
        public int Seed = 9;
        protected override void Deconstruct(out int x, out int y) { x = Seed; y = Seed + 1; }
        public int Compute() {
            void deconstructBridge(out int a, out int b) {
                Bounce<int>(0, out a, out b);
            }
            void Bounce<T>(int depth, out int a, out int b) {
                if (depth > 0) {
                    deconstructBridge(out a, out b);
                    return;
                }
                Deconstruct(out a, out b);
            }
            deconstructBridge(out var x, out var y);
            return x + y;
        }
    }
    public record AsyncAndRefRecord : ExternalContracts.IAsyncDeconstruct, ExternalContracts.IRefDeconstruct {
        public int Cell = 30;
        public async System.Threading.Tasks.Task<int> Deconstruct(int delta) {
            await System.Threading.Tasks.Task.Yield();
            return Cell + delta;
        }
        public ref int Deconstruct() => ref Cell;
        public ref readonly int Deconstruct(short tag) => ref Cell;
    }
    public record SafeDerivedFromUnsafeBase : ExternalContracts.UnsafeCtorBase, ExternalContracts.IParts {
        public void Deconstruct(out int x, out int y) { x = Value; y = Value * 3; }
    }
    public record CopyCtorDerived : ExternalContracts.CopyableBase, ExternalContracts.IParts {
        public int Extra;
        public CopyCtorDerived(int x, int extra) : base(x) { Extra = extra; }
        public CopyCtorDerived(ExternalContracts.CopyableBase other, int extra) : base(other) { Extra = extra; }
        public void Deconstruct(out int x, out int y) { x = X; y = Extra; }
    }
    public interface ISourceParts {
        void Deconstruct(out int x, out int y);
    }
    public interface ISourceParts2 {
        void Deconstruct(out int x, out int y);
    }
    public record SourceRecord : ISourceParts, ISourceParts2 {
        public int X = 2;
        public int Y = 3;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
    public class InheritedMetadataParts : ExternalContracts.UnrenamedBase, ISourceParts, ISourceParts2 { }
    public class KeywordDerived : ExternalContracts.KeywordBase {
        public override int func() => 42;
    }
    public static class StructHolder {
        public static ExternalContracts.MutatingStruct Current = new ExternalContracts.MutatingStruct(2, 3);
    }
    public static class Probe {
        public static string Run() {
            RefCtorBase seedBase = new RefCtorDerived(10);
            ExternalContracts.IParts p1 = new RefCtorDerived(ref seedBase);
            var (a1, b1) = p1;
            ExternalContracts.IParts p2 = new StringDerived(default(GenericBase<int>));
            var (a2, b2) = p2;
            var (sx, sy) = StructHolder.Current;
            var (sx2, sy2) = StructHolder.Current;
            ExternalContracts.KeywordBase kb = new KeywordDerived();
            var im = new InheritedMetadataParts();
            ISourceParts sp = im;
            ISourceParts2 sp2 = im;
            var (ix, iy) = sp;
            var (ix2, iy2) = sp2;
            var hookVal = new ProtectedHookCollision().Compute();
            var asyncRef = new AsyncAndRefRecord();
            ExternalContracts.IAsyncDeconstruct ia = asyncRef;
            var asyncVal = ia.Deconstruct(3).GetAwaiter().GetResult();
            ExternalContracts.IRefDeconstruct ir = asyncRef;
            ir.Deconstruct() += 5;
            var refRoVal = ir.Deconstruct((short)1);
            ExternalContracts.IParts unsafeBridge = new SafeDerivedFromUnsafeBase();
            var (ubx, uby) = unsafeBridge;
            ExternalContracts.IParts copyBridge = new CopyCtorDerived(new CopyCtorDerived(12, 1), 99);
            var (cbx, cby) = copyBridge;
            return $"{a1},{b1},{a2},{b2},{sx},{sy},{sx2},{sy2},{StructHolder.Current.X},{kb.func()},{ix},{iy},{ix2},{iy2},{hookVal},{asyncVal},{refRoVal},{ubx},{uby},{cbx},{cby}";
        }
    }
}`
        VerifyWithExternalReference(externalSource, [](string, string){("Snippet.cs", consumerSource)})
    }

    @Fact
    func MigratedProducerDeconstructCollision_RenamesConsumerInterfaceAndImplementingRecordTogether() {
        let producerSource = `
namespace Producer {
    public record R {
        public int X = 2;
        public int Y = 3;
        public void Deconstruct(out int x, out int y) { x = Y * 10; y = X; }
    }
}`
        let consumerSource = `
namespace RecordDeconstruction {
    public interface I {
        int deconstruct();
    }
    public record D : Producer.R, I {
        public int deconstruct() => 7;
    }
    public static class Probe {
        public static string Run() {
            var d = new D { X = 4, Y = 5 };
            I i = d;
            var (x, y) = d;
            return $"{x},{y},{d.deconstruct()},{i.deconstruct()}";
        }
    }
}`
        VerifyMigratedProducerAndConsumer(producerSource, consumerSource)
    }

    shared {
        private func Verify(source string, emittedSignature string? = nil) {
            Verify([](string, string){("Snippet.cs", source)}, emittedSignature)
        }

        private func Verify(sources[](string, string), emittedSignature string? = nil) {
            let project = CSharpProjectLoader.LoadInMemory(sources)
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
            let printedSources = project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                    Assert.DoesNotContain(
                        context.Diagnostics,
                        (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                    )
                    return printed
                }
            )
                .ToArray()
            if printedSources.Length > 1 {
                var index = 0
                for document in project.Documents {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    Assert.Equal(
                        printedSources[index++],
                        GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                    )
                }
            }
            let printed = string.Join("\n", printedSources)
            Assert.DoesNotContain("func __", printed)
            if emittedSignature != nil {
                Assert.Contains(emittedSignature, printed)
            }
            Assert.Contains("data ", printed)
            Assert.Equal(expected + "\n", CompileAndRun(printedSources).Replace("\r\n", "\n"))
        }

        private func VerifyWithExternalReference(externalSource string, sources[](string, string)) {
            let externalName = "External" + Guid.NewGuid().ToString("N")
            let external = CSharpProjectLoader.LoadInMemory(
                [](string, string){("External.cs", externalSource)},
                assemblyName: externalName
            )
            Assert.True(external.BoundWithoutErrors, string.Join("\n", external.ErrorDiagnostics))
            using let externalImage = MemoryStream()
            Assert.True(external.Compilation.Emit(externalImage).Success)
            let externalBytes = externalImage.ToArray()
            let references = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromImage(externalBytes))
                .ToArray()
            let project = CSharpProjectLoader.LoadInMemory(
                sources,
                references,
                assemblyName: "Consumer" + Guid.NewGuid().ToString("N")
            )
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            using let image = MemoryStream()
            Assert.True(project.Compilation.Emit(image).Success)
            let loadContext = AssemblyLoadContext("ExternalContext" + Guid.NewGuid().ToString("N"), isCollectible: true)
            var expected = ""
            try {
                using let externalStream = MemoryStream(externalBytes)
                loadContext.LoadFromStream(externalStream)
                using let consumerStream = MemoryStream(image.ToArray())
                let loadedConsumer = loadContext.LoadFromStream(consumerStream)
                expected = cast[string](
                    loadedConsumer.GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
                )
            } finally {
                loadContext.Unload()
            }
            let printedSources = project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                    Assert.DoesNotContain(
                        context.Diagnostics,
                        (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                    )
                    Assert.DoesNotContain("func __", printed)
                    return printed
                }
            )
                .ToArray()
            Assert.Contains("data ", string.Join("\n", printedSources))
            Assert.Equal(
                expected + "\n",
                CompileAndRun(printedSources, externalBytes, externalName + ".dll").Replace("\r\n", "\n")
            )
        }

        private func VerifyExternalUnsupported(externalSource string, source string) {
            let externalName = "External" + Guid.NewGuid().ToString("N")
            let external = CSharpProjectLoader.LoadInMemory(
                [](string, string){("External.cs", externalSource)},
                assemblyName: externalName
            )
            Assert.True(external.BoundWithoutErrors, string.Join("\n", external.ErrorDiagnostics))
            using let externalImage = MemoryStream()
            Assert.True(external.Compilation.Emit(externalImage).Success)
            let references = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromImage(externalImage.ToArray()))
                .ToArray()
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Snippet.cs", source)},
                references,
                assemblyName: "Consumer" + Guid.NewGuid().ToString("N")
            )
            Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let _ = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Contains(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
        }

        private func VerifyMigratedProducerAndConsumer(producerSource string, consumerSource string) {
            const producerName = "Producer"
            let producer = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Producer.cs", producerSource)},
                assemblyName: producerName
            )
            Assert.True(producer.BoundWithoutErrors, string.Join("\n", producer.ErrorDiagnostics))
            using let producerImage = MemoryStream()
            Assert.True(producer.Compilation.Emit(producerImage).Success)
            let producerBytes = producerImage.ToArray()
            let references = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromImage(producerBytes))
                .ToArray()
            let consumer = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Consumer.cs", consumerSource)},
                references,
                assemblyName: "Consumer" + Guid.NewGuid().ToString("N")
            )
            Assert.True(consumer.BoundWithoutErrors, string.Join("\n", consumer.ErrorDiagnostics))
            using let consumerImage = MemoryStream()
            Assert.True(consumer.Compilation.Emit(consumerImage).Success)
            let loadContext = AssemblyLoadContext("MigratedContext" + Guid.NewGuid().ToString("N"), isCollectible: true)
            var expected = ""
            try {
                using let producerStream = MemoryStream(producerBytes)
                loadContext.LoadFromStream(producerStream)
                using let consumerStream = MemoryStream(consumerImage.ToArray())
                let loadedConsumer = loadContext.LoadFromStream(consumerStream)
                expected = cast[string](
                    loadedConsumer.GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
                )
            } finally {
                loadContext.Unload()
            }
            let compilations = []Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpCompilation{producer.Compilation, consumer.Compilation}
            let producerDoc = Assert.Single(producer.Documents)
            let producerContext = TranslationContext(
                producer.Compilation,
                producerDoc.SemanticModel,
                producerDoc.FilePath,
                repositoryCompilations: compilations
            )
            let producerPrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(producerDoc, producerContext)
            )
            Assert.DoesNotContain(
                producerContext.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let consumerDoc = Assert.Single(consumer.Documents)
            let consumerContext = TranslationContext(
                consumer.Compilation,
                consumerDoc.SemanticModel,
                consumerDoc.FilePath,
                repositoryCompilations: compilations
            )
            let consumerPrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(consumerDoc, consumerContext)
            )
            Assert.DoesNotContain(
                consumerContext.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            Assert.DoesNotContain("func __", producerPrinted)
            Assert.DoesNotContain("func __", consumerPrinted)
            Assert.Contains("data ", producerPrinted)
            Assert.Equal(
                expected + "\n",
                CompileProducerAndConsumerAndRun(producerPrinted, consumerPrinted, producerName).Replace("\r\n", "\n")
            )
        }

        private func VerifyThreeMigratedCompilations(
            producerSource string,
            middleSource string,
            consumerSource string
        ) {
            const producerName = "Producer"
            const middleName = "Middle"
            let producer = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Producer.cs", producerSource)},
                assemblyName: producerName
            )
            Assert.True(producer.BoundWithoutErrors, string.Join("\n", producer.ErrorDiagnostics))
            using let producerImage = MemoryStream()
            Assert.True(producer.Compilation.Emit(producerImage).Success)
            let producerBytes = producerImage.ToArray()
            let middleRefs = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromImage(producerBytes))
                .ToArray()
            let middle = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Middle.cs", middleSource)},
                middleRefs,
                assemblyName: middleName
            )
            Assert.True(middle.BoundWithoutErrors, string.Join("\n", middle.ErrorDiagnostics))
            using let middleImage = MemoryStream()
            Assert.True(middle.Compilation.Emit(middleImage).Success)
            let middleBytes = middleImage.ToArray()
            let consumerRefs = CSharpProjectLoader
                .RuntimeReferences()
                .Append(MetadataReference.CreateFromImage(producerBytes))
                .Append(MetadataReference.CreateFromImage(middleBytes))
                .ToArray()
            let consumer = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Consumer.cs", consumerSource)},
                consumerRefs,
                assemblyName: "Consumer" + Guid.NewGuid().ToString("N")
            )
            Assert.True(consumer.BoundWithoutErrors, string.Join("\n", consumer.ErrorDiagnostics))
            using let consumerImage = MemoryStream()
            Assert.True(consumer.Compilation.Emit(consumerImage).Success)
            let loadContext = AssemblyLoadContext(
                "ThreeProjectContext" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            var expected = ""
            try {
                using let producerStream = MemoryStream(producerBytes)
                loadContext.LoadFromStream(producerStream)
                using let middleStream = MemoryStream(middleBytes)
                loadContext.LoadFromStream(middleStream)
                using let consumerStream = MemoryStream(consumerImage.ToArray())
                let loadedConsumer = loadContext.LoadFromStream(consumerStream)
                expected = cast[string](
                    loadedConsumer.GetType("RecordDeconstruction.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
                )
            } finally {
                loadContext.Unload()
            }
            let compilations = []Microsoft
                .CodeAnalysis
                .CSharp
                .CSharpCompilation{producer.Compilation, middle.Compilation, consumer.Compilation}
            let producerDoc = Assert.Single(producer.Documents)
            let producerContext = TranslationContext(
                producer.Compilation,
                producerDoc.SemanticModel,
                producerDoc.FilePath,
                repositoryCompilations: compilations
            )
            let producerPrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(producerDoc, producerContext)
            )
            let middleDoc = Assert.Single(middle.Documents)
            let middleContext = TranslationContext(
                middle.Compilation,
                middleDoc.SemanticModel,
                middleDoc.FilePath,
                repositoryCompilations: compilations
            )
            let middlePrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(middleDoc, middleContext)
            )
            let consumerDoc = Assert.Single(consumer.Documents)
            let consumerContext = TranslationContext(
                consumer.Compilation,
                consumerDoc.SemanticModel,
                consumerDoc.FilePath,
                repositoryCompilations: compilations
            )
            let consumerPrinted = GSharpPrinter.Print(
                CSharpToGSharpTranslator().TranslateDocument(consumerDoc, consumerContext)
            )
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
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5699", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let producerDll = Path.Combine(directory, producerName + ".dll")
                let producerGs = Path.Combine(directory, "Producer.gs")
                File.WriteAllText(producerGs, producerPrinted)
                let compileProducer = RunDotnet(
                    []string{compiler, "/target:library", "/out:" + producerDll, producerGs}
                )
                Assert.True(compileProducer.Exit == 0, compileProducer.Output + "\n" + producerPrinted)
                let middleDll = Path.Combine(directory, middleName + ".dll")
                let middleGs = Path.Combine(directory, "Middle.gs")
                File.WriteAllText(middleGs, middlePrinted)
                let compileMiddle = RunDotnet(
                    []string{compiler, "/target:library", "/out:" + middleDll, "/r:" + producerDll, middleGs}
                )
                Assert.True(compileMiddle.Exit == 0, compileMiddle.Output + "\n" + middlePrinted)
                let consumerDll = Path.Combine(directory, "Snippet.dll")
                let consumerGs = Path.Combine(directory, "Consumer.gs")
                File.WriteAllText(consumerGs, consumerPrinted + "\nSystem.Console.WriteLine(Probe.Run())\n")
                let compileConsumer = RunDotnet(
                    []string{
                        compiler,
                        "/target:exe",
                        "/out:" + consumerDll,
                        "/r:" + producerDll,
                        "/r:" + middleDll,
                        consumerGs
                    }
                )
                Assert.True(compileConsumer.Exit == 0, compileConsumer.Output + "\n" + consumerPrinted)
                let run = RunDotnet([]string{consumerDll})
                Assert.True(run.Exit == 0, run.Output)
                Assert.Equal(expected + "\n", run.Output.Replace("\r\n", "\n"))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileAndRun(
            printedSources[]string,
            externalAssemblyBytes([]byte)? = nil,
            externalFileName string? = nil
        ) string {
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
                let output = Path.Combine(directory, "Snippet.dll")
                let arguments = System.Collections.Generic.List[string]{compiler, "/target:exe", "/out:" + output}
                if externalAssemblyBytes != nil && externalFileName != nil {
                    let externalPath = Path.Combine(directory, externalFileName)
                    File.WriteAllBytes(externalPath, externalAssemblyBytes)
                    arguments.Add("/r:" + externalPath)
                }
                for var i = 0; i < printedSources.Length; i++ {
                    let source = Path.Combine(directory, "Snippet" + i.ToString() + ".gs")
                    File.WriteAllText(
                        source,
                        printedSources[i] + if i == 0 {
                            "\nSystem.Console.WriteLine(Probe.Run())\n"
                        } else {
                            string.Empty
                        }
                    )
                    arguments.Add(source)
                }
                let compile = RunDotnet(arguments.ToArray())
                Assert.True(compile.Exit == 0, compile.Output + "\n" + string.Join("\n", printedSources))
                let run = RunDotnet([]string{output})
                Assert.True(run.Exit == 0, run.Output)
                return run.Output
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileProducerAndConsumerAndRun(
            producerPrinted string,
            consumerPrinted string,
            producerAssemblyName string
        ) string {
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
                let producerDll = Path.Combine(directory, producerAssemblyName + ".dll")
                let producerGs = Path.Combine(directory, "Producer.gs")
                File.WriteAllText(producerGs, producerPrinted)
                let compileProducer = RunDotnet(
                    []string{compiler, "/target:library", "/out:" + producerDll, producerGs}
                )
                Assert.True(compileProducer.Exit == 0, compileProducer.Output + "\n" + producerPrinted)
                let consumerDll = Path.Combine(directory, "Snippet.dll")
                let consumerGs = Path.Combine(directory, "Consumer.gs")
                File.WriteAllText(consumerGs, consumerPrinted + "\nSystem.Console.WriteLine(Probe.Run())\n")
                let compileConsumer = RunDotnet(
                    []string{compiler, "/target:exe", "/out:" + consumerDll, "/r:" + producerDll, consumerGs}
                )
                Assert.True(compileConsumer.Exit == 0, compileConsumer.Output + "\n" + consumerPrinted)
                let run = RunDotnet([]string{consumerDll})
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
