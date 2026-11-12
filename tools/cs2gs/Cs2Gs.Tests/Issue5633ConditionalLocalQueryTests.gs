// <copyright file="Issue5633ConditionalLocalQueryTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import CompilationMeasurements = GSharp.Core.CodeAnalysis.Compilation.CompilationMeasurements
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

/// Issue #5633: repeated result arms must share local-query answers, including reaching assignments and tuple projections.
/// @remarks Before this fix, the enabled reassignment and deconstruction rows exceed the ten-second translation bound.
open class Issue5633ConditionalLocalQueryTests {
    private let output ITestOutputHelper
    private var translationAllocatedBytes int64 = 0
    private var translatorAllocatedBytes int64 = 0
    private var printerAllocatedBytes int64 = 0
    private var translationElapsedMilliseconds float64 = 0
    private var translationDiagnosticText string = ""
    private let translationWork System
        .Collections
        .Generic
        .Dictionary[string, int64] = System
        .Collections
        .Generic
        .Dictionary[string, int64]()
    private var translationOriginMetrics(SourceCount int32, EdgeCount int32, OperationCount int64)

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(true, false, "conditional")
    @InlineData(true, true, "conditional")
    @InlineData(false, false, "conditional")
    @InlineData(false, true, "conditional")
    @InlineData(true, false, "switch")
    @InlineData(true, true, "switch")
    @InlineData(false, false, "switch")
    @InlineData(false, true, "switch")
    @InlineData(true, false, "coalesce")
    @InlineData(true, true, "coalesce")
    @InlineData(false, false, "coalesce")
    @InlineData(false, true, "coalesce")
    @InlineData(true, false, "assigned")
    @InlineData(false, false, "assigned")
    @InlineData(true, true, "assigned")
    @InlineData(false, true, "assigned")
    @InlineData(true, false, "assigned-switch")
    @InlineData(false, false, "assigned-switch")
    @InlineData(true, false, "assigned-coalesce")
    @InlineData(false, false, "assigned-coalesce")
    @InlineData(true, false, "late-writes")
    @InlineData(false, false, "late-writes")
    func JoinedLocalChain_CompletesWithinBound(enabled bool, nullableInput bool, shape string) {
        let body = StringBuilder()
        if !enabled && nullableInput {
            body.AppendLine("p = null;")
        }
        body.AppendLine("var x0 = p;")
        for var i = 1; i <= 24; i++ {
            let previous = "x${i - 1}"
            let value = switch shape {
                case "conditional", "assigned", "late-writes": "flag ? $previous : $previous"
                case "switch", "assigned-switch": "flag switch { true => $previous, false => $previous }"
                default: "$previous ?? $previous"
            }
            body.AppendLine("var x$i = $value;")
            if shape.StartsWith("assigned", StringComparison.Ordinal) {
                body.AppendLine("x$i = $value;")
            }
        }
        if shape == "late-writes" {
            body.AppendLine("x0 = x24; x24 = x0;")
        }
        let annotation = if enabled && nullableInput {
            "?"
        } else {
            ""
        }
        let mode = if enabled {
            "enable"
        } else {
            "disable"
        }
        let source = "#nullable $mode\nnamespace Demo {\n" +
            "public class Node { public int Read() => 1; }\n" +
            "public static class P {\n" +
            "static void Take(Node$annotation value) { }\n" +
            "static Node$annotation Chain(Node$annotation p, bool flag) {\n" +
            body.ToString() +
            "Take(x24); if (x24 is var captured) Take(captured); _ = x24.Read(); return x24;\n" +
            "} } }"
        let printed = this.TranslateWithinBound(source, enabled)
        Assert.Contains("return x24", printed)
        Assert.Contains("Take(captured", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(8, "self")
    @InlineData(10, "self")
    @InlineData(12, "self")
    @InlineData(14, "self")
    @InlineData(16, "self")
    @InlineData(18, "self")
    @InlineData(18, "alias")
    @InlineData(18, "loop")
    @InlineData(18, "tuple")
    @InlineData(18, "deconstruct")
    @InlineData(12, "split")
    @InlineData(14, "split")
    @InlineData(16, "split")
    func CyclicOriginChain_CompletesWithinBound(links int32, shape string) {
        let body = StringBuilder(
            switch shape {
                case "alias": "var x0 = p; var alias = x0; x0 = alias; alias = x0;\n"
                case "loop": "var x0 = p; var alias = x0; do { x0 = alias; alias = x0; } while (flag);\n"
                case "tuple": "var x0 = (p, 0); x0 = x0;\n"
                case "deconstruct": "var pair = (p, 0); pair = pair; var (x0, _) = pair;\n"
                default: "var x0 = p; x0 = x0;\n"
            }
        )
        for var i = 1; i <= links; i++ {
            body.AppendLine(
                if shape == "split" {
                    "var a$i = x${i - 1}; var b$i = x${i - 1}; var x$i = flag ? a$i : b$i;"
                } else if shape == "deconstruct" {
                    "var (x$i, _) = (flag ? x${i - 1} : x${i - 1}, 0);"
                } else {
                    "var x$i = flag ? x${i - 1} : x${i - 1};"
                }
            )
        }
        if shape == "tuple" {
            body.AppendLine("var (end, _) = x$links;")
        }
        let result = if shape == "tuple" {
            "end"
        } else {
            "x$links"
        }
        let printed = this.TranslateWithinBound(
            "#nullable enable\nnamespace Demo {\n" +
                "public class Node { }\npublic static class P {\n" +
                "static Node Chain(Node p, bool flag) {\n" +
                body.ToString() + "return $result;\n} } }",
            enabled: true
        )
        Assert.Contains("return $result", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(6)
    @InlineData(8)
    @InlineData(10)
    @InlineData(12)
    func LoopCarriedSplitAliases_CompletesWithinBound(links int32) {
        let body = StringBuilder("var seed = p;\ndo {\nvar x0 = seed;\n")
        let arms = StringBuilder()
        for var i = 1; i <= links; i++ {
            body.AppendLine("var a$i = x${i - 1}; var b$i = x${i - 1}; var x$i = flag ? a$i : b$i;")
            arms.Append("${i * 2} => a$i, ${i * 2 + 1} => b$i, ")
        }
        body.AppendLine("seed = choice switch { $arms _ => x$links };")
        body.AppendLine("} while (again); return seed;")
        let printed = this.TranslateWithinBound(
            "#nullable enable\nnamespace Demo {\n" +
                "public class Node { }\npublic static class P {\n" +
                "static Node Chain(Node p, bool flag, bool again, int choice) {\n" +
                body.ToString() + "\n} } }",
            enabled: true
        )
        Assert.Contains("return seed", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func LargeScalarAliases_BoundWholePipelineAllocationsAndRetainSparseQueryWork(hasDefault bool, fanOut bool) {
        let metrics = System.Collections.Generic.List[(SourceCount int32, EdgeCount int32, OperationCount int64)]()
        let allocations = System.Collections.Generic.List[int64]()
        let keyVisits = System.Collections.Generic.List[int64]()
        let promotedEvaluations = System.Collections.Generic.List[int64]()
        let scopeWork = System.Collections.Generic.List[int64]()
        let aliasVisits = System.Collections.Generic.List[int64]()
        let terminalEntries = System.Collections.Generic.List[int64]()
        for links in[]int32{16, 128, 256, 512} {
            let body = StringBuilder()
            if fanOut {
                body.AppendLine("var hub = choice switch {")
                for var i = 0; i < links - 1; i++ {
                    body.AppendLine("$i => ${if hasDefault && i == 0 { "default(T)" } else { "p" }},")
                }
                body.AppendLine("_ => p };")
                for var i = 0; i <= links; i++ {
                    body.AppendLine("var x$i = hub;")
                }
            } else {
                body.AppendLine("var x0 = ${if hasDefault { "default(T)" } else { "p" }};")
                for var i = 1; i <= links; i++ {
                    body.AppendLine("var x$i = x${i - 1};")
                }
            }
            let printed = this.TranslateWithinBound(
                "#nullable enable\nnamespace Demo { public static class P {\n" +
                    "static T? Chain<T>(T p, int choice) {\n" +
                    body.ToString() + "return x$links;\n} } }",
                enabled: true,
                measureWork: true
            )
            if links == 16 {
                continue
            }
            metrics.Add(this.translationOriginMetrics)
            allocations.Add(this.translationAllocatedBytes)
            keyVisits.Add(this.translationWork["tuple_state_key_node_visits"])
            promotedEvaluations.Add(this.translationWork["promoted_value_evaluations"])
            scopeWork.Add(this.ScopeCensusWork())
            aliasVisits.Add(
                this.translationWork["projection_alias_visits"] +
                    this.translationWork["projection_alias_terminal_build_visits"] +
                    this.translationWork["projection_alias_live_boundary_visits"]
            )
            terminalEntries.Add(this.translationWork["projection_alias_terminal_entries"])
            this.output.WriteLine(
                "$links links: ${this.translationAllocatedBytes} allocated bytes; " +
                    "${this.translationOriginMetrics.SourceCount} sources; " +
                    "${this.translationOriginMetrics.EdgeCount} edges; " +
                    "${this.translationOriginMetrics.OperationCount} graph operations"
            )
            this.output.WriteLine(
                "Translator: ${this.translatorAllocatedBytes} bytes; printer: ${this.printerAllocatedBytes} bytes"
            )
            for counter in this.translationWork {
                this.output.WriteLine("${counter.Key}: ${counter.Value}")
            }
            Assert.Contains(
                if hasDefault {
                    "let x$links T? = ${if fanOut { "hub" } else { "x${links - 1}" }}"
                } else {
                    "let x$links = ${if fanOut { "hub" } else { "x${links - 1}" }}"
                },
                printed
            )
            TranslationTestValidation.AssertBinds(printed)
        }
        Assert.True(
            aliasVisits[0] > 0 && aliasVisits[1] <= aliasVisits[0] * 3 && aliasVisits[2] <= aliasVisits[1] * 3,
            "Raw alias construction and live projection probes must not revisit each chain prefix: ${aliasVisits[0]} -> ${aliasVisits[1]} -> ${aliasVisits[2]}."
        )
        Assert.True(
            terminalEntries[1] <= terminalEntries[0] * 3 && terminalEntries[2] <= terminalEntries[1] * 3,
            "Retained raw terminals must scale with source size: ${terminalEntries[0]} -> ${terminalEntries[1]} -> ${terminalEntries[2]}."
        )
        Assert.True(
            allocations[1] <= allocations[0] * 3 && allocations[2] <= allocations[1] * 3,
            "Doubling aliases must not quadruple whole translator/printer allocations: ${allocations[0]} -> ${allocations[1]} -> ${allocations[2]}."
        )
        Assert.True(keyVisits[0] > 0 && promotedEvaluations[0] > 0)
        Assert.True(
            keyVisits[2] <= keyVisits[0] * 5 && promotedEvaluations[2] <= promotedEvaluations[0] * 5,
            "Syntax-key scans and promoted-value evaluations must scale with source size."
        )
        Assert.True(
            scopeWork[0] > 0 && scopeWork[1] <= scopeWork[0] * 3 && scopeWork[2] <= scopeWork[1] * 3,
            "Scope construction, candidates, and semantic write probes must not rescan every local's body: ${scopeWork[0]} -> ${scopeWork[1]} -> ${scopeWork[2]}."
        )
        Assert.True(
            metrics[2].SourceCount <= metrics[0].SourceCount * 5 &&
                metrics[2].EdgeCount <= metrics[0].EdgeCount * 5 &&
                metrics[1].OperationCount <= metrics[0].OperationCount * 3 &&
                metrics[2].OperationCount <= metrics[1].OperationCount * 3,
            "Quadrupling links must retain linear source/edge counts and sub-quadratic graph work: ${metrics[0]} -> ${metrics[2]}."
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IndependentLocalCensuses_IndexWorkScalesWithSourceSize(guards bool) {
        let work = System.Collections.Generic.List[int64]()
        for links in[]int32{16, 128, 256, 512} {
            let body = StringBuilder()
            for var i = 0; i <= links; i++ {
                body.AppendLine(
                    if guards {
                        "var x$i = p; if (x$i != null) { _ = x$i.ToString(); }"
                    } else {
                        "var x$i = $i; x$i++;"
                    }
                )
            }
            let printed = this.TranslateWithinBound(
                "namespace Demo { public static class P { public static int Run(object? p) {\n" + body.ToString() +
                    "return ${if guards { "0" } else { "x$links" }}; } } }",
                enabled: true,
                measureWork: true
            )
            Assert.True(
                printed.Contains(
                    if guards {
                        "let x$links"
                    } else {
                        "var x$links = $links"
                    }
                ),
                printed
            )
            TranslationTestValidation.AssertBinds(printed)
            if links == 16 {
                continue
            }
            let scanned = this.ScopeCensusWork()
            work.Add(scanned)
            this.output.WriteLine(
                "$links independent writes: $scanned visits; ${this.translationWork["reassignment_write_probes"]} write probes"
            )
            for counter in this.translationWork {
                if counter.Key.StartsWith("guard", StringComparison.Ordinal) || counter.Key.StartsWith(
                    "reassignment",
                    StringComparison.Ordinal
                ) ||
                    counter
                    .Key
                    .StartsWith("storage_write", StringComparison.Ordinal) || counter.Key.StartsWith(
                    "scope_",
                    StringComparison.Ordinal
                ) {
                    this.output.WriteLine("${counter.Key}: ${counter.Value}")
                }
            }
        }
        Assert.True(
            work[0] > 0 && work[1] <= work[0] * 3 && work[2] <= work[1] * 3,
            "Independent writes need a per-symbol census, not a shared list rescanned for every local: ${work[0]} -> ${work[1]} -> ${work[2]}."
        )
    }

    @Fact
    func DistinctReferenceMemberChains_IndexPrefixesAndRetainedEntriesScale() {
        let prefixes = System.Collections.Generic.List[int64]()
        let retained = System.Collections.Generic.List[int64]()
        for links in[]int32{16, 32, 64, 128} {
            let fields = StringBuilder()
            let initialize = StringBuilder()
            let chain = StringBuilder("x")
            for var i = 1; i <= links; i++ {
                fields.AppendLine("public Node P$i;")
                initialize.AppendLine("P$i = this;")
                chain.Append(".P$i")
            }
            let printed = this.TranslateWithinBound(
                "#nullable enable\nnamespace Demo { public class Node {\n" + fields.ToString() +
                    "public Node() {\n" +
                    initialize.ToString() +
                    "}\npublic int Read() => 7;\n}\n" +
                    "public static class P { public static int Run(Node input) {\n" +
                    "var x = input; return $chain.Read();\n} } }",
                enabled: true,
                measureWork: true
            )
            Assert.Contains(".P$links", printed)
            TranslationTestValidation.AssertBinds(printed)
            if links == 128 {
                LocalFunctionHoistTranslationTests.CompileAndRun(
                    printed,
                    "System.Console.WriteLine(P.Run(Node()))",
                    "7"
                )
            }
            if links == 16 {
                continue
            }
            prefixes.Add(this.translationWork["reassignment_storage_target_visits"])
            retained.Add(this.translationWork["scope_write_candidates"])
            this.output.WriteLine(
                "$links distinct reference fields: ${this.translationAllocatedBytes} allocated bytes; " +
                    "${prefixes[prefixes.Count - 1]} prefix visits; ${retained[retained.Count - 1]} retained candidates; " +
                    "${this.translationWork["reassignment_node_visits"]} scope/candidate visits"
            )
        }
        Assert.True(
            prefixes[0] > 0 &&
                retained[0] > 0 &&
                prefixes[1] <= prefixes[0] * 3 &&
                prefixes[2] <= prefixes[1] * 3 &&
                retained[1] <= retained[0] * 3 &&
                retained[2] <= retained[1] * 3,
            "Distinct reference fields must not retain or revisit all receiver prefixes: " +
                "visits ${prefixes[0]} -> ${prefixes[1]} -> ${prefixes[2]}; " +
                "entries ${retained[0]} -> ${retained[1]} -> ${retained[2]}."
        )
    }

    @Theory
    @InlineData("value", true, 1)
    @InlineData("readonly", false, 0)
    @InlineData("reference", false, 1)
    @InlineData("unknown", true, 1)
    func StorageReceiverBoundaries_PreserveCanonicalMatchesAndRuntime(shape string, writesRoot bool, expected int32) {
        let method = switch shape {
            case "value":
            "public static int Run() { var root = new Outer(); root.Middle.Inner.Bump(); return root.Middle.Inner.Value; }"
            case "readonly":
            "public static int Run() { var root = new ReadOnlyOuter(); return root.Middle.Inner.Read(); }"
            case "reference":
            "public static int Run() { var root = new Holder(new ReferenceRoot()); " +
                "ref int alias = ref root.Reference.Middle.Inner.Value; alias++; return root.Reference.Middle.Inner.Value; }"
            default:
            "public static int Run<T>(T input) where T : ICounter { var root = new Box<T>(input); " +
                "root.Value.Bump(); return root.Value.Read(); }"
        }
        let source = `
#nullable enable
namespace Demo {
public interface ICounter { void Bump(); int Read(); }
public struct Leaf : ICounter {
    public int Value;
    public void Bump() { Value++; }
    public int Read() => Value;
}
public struct Middle { public Leaf Inner; }
public struct Outer { public Middle Middle; }
public readonly struct ReadOnlyLeaf { public int Read() => 0; }
public struct ReadOnlyMiddle { public ReadOnlyLeaf Inner; }
public struct ReadOnlyOuter { public ReadOnlyMiddle Middle; }
public class ReferenceRoot { public Middle Middle; }
public struct Holder {
    public ReferenceRoot Reference;
    public Holder(ReferenceRoot value) { Reference = value; }
}
public struct Box<T> where T : ICounter {
    public T Value;
    public Box(T value) { Value = value; }
}
public static class P {
` + method + "\n} }"
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Boundary.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let root = document.SyntaxTree.GetRoot()
        let declaration = root
            .DescendantNodes()
            .OfType[VariableDeclaratorSyntax]()
            .Single((candidate VariableDeclaratorSyntax) -> candidate.Identifier.ValueText == "root")
        let local = Assert.IsAssignableFrom[ILocalSymbol](document.SemanticModel.GetDeclaredSymbol(declaration))
        Assert.Equal(
            writesRoot,
            root.DescendantNodes().Any(
                (node SyntaxNode) -> CSharpToGSharpTranslator.SyntaxNodeWritesSymbol(
                    node,
                    local,
                    document.SemanticModel
                )
            )
        )
        let printed = this.TranslateWithinBound(source, enabled: true, measureWork: true)
        Assert.Contains("${if writesRoot { "var" } else { "let" }} root", printed)
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(${if shape == "unknown" { "P.Run(Leaf{})" } else { "P.Run()" }})",
            expected.ToString()
        )
    }

    @Fact
    func ScopeCensuses_PreserveCapturedWritesRefStorageAndGuardBoundaries() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public class Node { public int Read() => 7; }
    public struct Counter
    {
        public int Value;
        public int Touch() => ++Value;
        public int Next { get { Value++; return Value; } }
        public int this[int ignored] { get { Value++; return Value; } }
    }
    public static class P
    {
        static void Bump(ref int value) { value++; }
        public static string Run(bool flag)
        {
            var captured = 1;
            void Change() { captured++; }
            Change();
            ref int alias = ref captured;
            Bump(ref alias);
            var (left, right) = (0, 0);
            (left, right) = (3, 4);
            var caller = new Counter();
            _ = caller.Touch();
            var accessor = new Counter();
            _ = accessor.Next;
            var indexed = new Counter();
            _ = indexed[0];
            Node? current = flag ? new Node() : null;
            System.Func<int> read = () =>
            {
                if (current is Node nested) return nested.Read();
                return 0;
            };
            int result = read();
            while (current is Node outer)
            {
                result += outer.Read();
                current = null;
            }
            goto Done;
        Done:
            return captured + ":" + left + ":" + right + ":" +
                (caller.Value + accessor.Value + indexed.Value) + ":" + result;
        }
    }
}`, enabled: true, measureWork: true)
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5962ScopeCensus.golden"),
            printed
        )
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5962ScopeCensus.diagnostics.golden"),
            this.translationDiagnosticText
        )
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run(true))\nSystem.Console.WriteLine(P.Run(false))",
            "3:3:4:3:14" + Environment.NewLine + "3:3:4:3:0"
        )
    }

    @Fact
    func ScopeCensuses_PreserveSiblingNamesAndSynthesizedQueryBoundaries() {
        let printed = this.TranslateWithinBound(`
#nullable enable
using System.Linq;
namespace Demo
{
    public class Node { public int Read() => 7; }
    public static class P
    {
        public static int Run(bool flag)
        {
            Node? seed = flag ? new Node() : null;
            var query = from value in new[] { seed }
                        let code = value is Node nested ? nested.Read() : 0
                        select code;
            int total = query.Single();
            {
                Node? item = seed;
                if (item != null) total += item.Read();
            }
            {
                Node? item = new Node();
                void Clear() { item = null; }
                Clear();
                if (item == null) total += 1;
            }
            return total;
        }
    }
}`, enabled: true, measureWork: true)
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5962ScopeQuery.golden"),
            printed
        )
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5962ScopeQuery.diagnostics.golden"),
            this.translationDiagnosticText
        )
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run(true))\nSystem.Console.WriteLine(P.Run(false))",
            "15" + Environment.NewLine + "1"
        )
    }

    @Theory
    @InlineData(true, true, false)
    @InlineData(false, true, false)
    @InlineData(true, false, false)
    @InlineData(false, false, false)
    @InlineData(true, false, true)
    @InlineData(false, false, true)
    func TupleLocalChain_CompletesWithinBound(enabled bool, deconstruct bool, widened bool) {
        let input = if widened {
            "System.Threading.Volatile.Read(ref p!)"
        } else {
            "p"
        }
        let body = StringBuilder("var x0 = ($input, 0);\n")
        for var i = 1; i <= 24; i++ {
            body.AppendLine("var x$i = flag ? x${i - 1} : x${i - 1};")
            body.AppendLine("x$i = flag ? x${i - 1} : x${i - 1};")
        }
        let mode = if enabled {
            "enable"
        } else {
            "disable"
        }
        let source = "#nullable $mode\nnamespace Demo {\n" +
            "public class Node { }\npublic static class P {\n" +
            "static T First<T>((T Value, int Tag) pair) => pair.Value;\n" +
            "static Node Chain(Node${if enabled && widened { "?" } else { "" }} p, bool flag) {\n" +
            body.ToString() +
            (
            if deconstruct {
                "var (end, code) = x24; return end;"
            } else {
                "var result = First(x24); return result;"
            }
        ) +
            "\n} } }"
        let printed = this.TranslateWithinBound(source, enabled)
        Assert.Contains("var x24 = if flag { x23 } else { x23 }\n", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func TupleUnboxingCycle_CompletesWithinBound() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        public static object? Run((object? Next, int Tag) start, bool again)
        {
            var current = start;
            do
            {
                var (value, _) = current;
                current = ((object?, int))current.Next!;
            } while (again);
            return current.Next;
        }
    }
}`, enabled: true)
        Assert.Contains("return current.Next", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func TupleUnboxingCycle_PreservesDefaultEvidenceAndTupleLeaves() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string IsNull<T>(T value) => (value is null).ToString();
        public static string Run<T>(T replacement, bool flag)
        {
            var leaf = (Next: new object(), Value: default(T), Other: replacement);
            var current = (Next: (object)leaf, Value: (T?)replacement, Other: (T?)replacement);
            string result = "";
            int count = 0;
            do
            {
                var (next, value, other) = current;
                var observed = flag ? value : value;
                result += IsNull(observed) + ":" + IsNull(other) + ";";
                if (++count == 2) break;
                current = ((object, T?, T?))next;
            } while (true);
            return result;
        }
    }
}`, enabled: true)
        Assert.Contains("observed T?", printed)
        Assert.DoesNotContain("other T?", printed)
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run(\"value\", true))\n" + "System.Console.WriteLine(P.Run(\"value\", false))",
            "False:False;True:False;" + Environment.NewLine + "False:False;True:False;"
        )
    }

    @Fact
    func CyclicOrigins_PropagateDefaultsWithoutChangingRuntimeValues() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string IsNull<T>(T value) => (value is null).ToString();
        public static string Run<T>(T replacement, bool flag, bool clear)
        {
            T? seed = replacement;
            string result = "";
            int count = 0;
            do
            {
                var a = seed;
                var b = seed;
                var joined = flag ? a : b;
                result += IsNull(joined) + ":";
                seed = clear ? default(T) : flag ? a : b;
            } while (++count < 2);
            return result;
        }
    }
}`, enabled: true)
        Assert.Contains("let a T? = seed", printed)
        Assert.Contains("let joined T? = if flag", printed)
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run(\"value\", true, true))\n" +
                "System.Console.WriteLine(P.Run(\"value\", false, true))\n" +
                "System.Console.WriteLine(P.Run(\"value\", true, false))\n" +
                "System.Console.WriteLine(P.Run(\"value\", false, false))",
            string.Join(Environment.NewLine, "False:True:", "False:True:", "False:False:", "False:False:")
        )
    }

    @Fact
    func DeconstructedCallback_RetainsCapturedDefaultProvenance() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string IsNull<T>(T value) => (value is null).ToString();
        public static string Run<T>(T replacement)
        {
            var pair = (replacement, 0);
            string result = "";
            var (callback, _) = ((System.Action)(() =>
            {
                var (captured, _) = pair;
                result = IsNull(captured);
            }), 0);
            pair = (default(T), 0);
            callback();
            return result;
        }
    }
}`, enabled: true)
        Assert.Contains("captured T?", printed)
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(P.Run(\"value\"))", "True")
    }

    @Fact
    func DefaultOriginMemo_SeparatesReadPositionsAndTupleLeaves() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string IsNull<T>(T value) => (value is null).ToString();
        public static string Run(bool flag)
        {
            object? value = new object();
            var before = flag ? value : value;
            value = default;
            var after = flag ? value : value;
            (object? Left, object? Right) pair = (new object(), new object());
            var saved = pair;
            pair = flag ? (default(object), new object()) : (default(object), new object());
            var (savedLeft, savedRight) = saved;
            var (currentLeft, currentRight) = pair;
            return IsNull(before) + ":" + IsNull(after) + ":" +
                IsNull(savedLeft) + ":" + IsNull(savedRight) + ":" +
                IsNull(currentLeft) + ":" + IsNull(currentRight);
        }
    }
}`, enabled: true)
        GoldenFile.AssertMatches(
            Path.Combine(AppContext.BaseDirectory, "Fixtures", "Issue5633DefaultOriginMemo.golden"),
            printed
        )
        TranslationTestValidation.AssertBinds(printed)
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run(true))\nSystem.Console.WriteLine(P.Run(false))",
            "False:True:False:False:True:False" + Environment.NewLine + "False:True:False:False:True:False"
        )
    }

    @Fact
    func TruncatedTupleAlias_DoesNotCacheAMissingDefault() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static bool IsNull<T>(T value) => value is null;
        public static bool Probe<T>(T replacement, bool flag)
        {
            T a = replacement;
            var b = (default(T), 0);
            (a, _) = b;
            T d = a;
            b = (d, 0);
            var end = flag ? b.Item1 : d;
            return IsNull(end);
        }
    }
}`, enabled: true)
        Assert.Contains("let end T? = if flag { b.Item1 } else { d }\n", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func DeconstructionAtEveryLink_CompletesWithinBound(enabled bool) {
        let body = StringBuilder("var (x0, _) = (p, 0);\n")
        for var i = 1; i <= 24; i++ {
            body.AppendLine("var (x$i, _) = (flag ? x${i - 1} : x${i - 1}, 0);")
        }
        let mode = if enabled {
            "enable"
        } else {
            "disable"
        }
        let source = "#nullable $mode\nnamespace Demo {\n" +
            "public class Node { }\npublic static class P {\n" +
            "static Node Chain(Node p, bool flag) {\n" +
            body.ToString() + "return x24;\n} } }"
        let printed = this.TranslateWithinBound(source, enabled)
        Assert.Contains("return x24", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func LaterWritesOnBackedges_StillReachEarlierReads() {
        let printed = this.TranslateWithinBound(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static bool IsNull<T>(T value) => value is null;
        public static bool Loop<T>(T replacement, bool again)
        {
            T value = replacement;
            while (again)
            {
                var loopRead = value;
                value = default(T);
                if (IsNull(loopRead)) return true;
            }
            return false;
        }
        public static bool Jump<T>(T replacement, bool again)
        {
            T value = replacement;
            repeat:
            {
                var jumpRead = value;
                value = default(T);
                if (again) goto repeat;
                return IsNull(jumpRead);
            }
        }
    }
}`, enabled: true)
        Assert.Contains("let loopRead T? = value\n", printed)
        Assert.Contains("let jumpRead T? = value\n", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    private func ScopeCensusWork() int64 {
        var total int64 = 0
        for counter in[]string{
            "reassignment_node_visits",
            "reassignment_write_probes",
            "reassignment_storage_target_visits",
            "reassignment_symbol_queries",
            "reassignment_receiver_type_queries",
            "storage_write_target_probes",
            "storage_write_tuple_visits",
            "guard_scope_node_visits",
            "guard_candidate_visits",
            "guard_subject_symbol_queries",
            "scope_declaration_symbol_queries",
            "scope_address_node_visits",
            "scope_boundary_visits",
            "scope_namesake_visits"
        } {
            total += this.translationWork[counter]
        }
        return total
    }

    private func TranslateWithinBound(source string, enabled bool, measureWork bool = false) string {
        let beforeLoad = GC.GetAllocatedBytesForCurrentThread()
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Chain.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let afterLoad = GC.GetAllocatedBytesForCurrentThread()
        let compilation = project.Compilation.WithOptions(
            project
                .Compilation
                .Options
                .WithNullableContextOptions(
                if enabled {
                    NullableContextOptions.Enable
                } else {
                    NullableContextOptions.Disable
                }
            )
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let original = Assert.Single(project.Documents)
        let document = LoadedDocument(
            original.FilePath,
            original.SyntaxTree,
            compilation.GetSemanticModel(original.SyntaxTree)
        )
        let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
        this.output.WriteLine(
            "Input loading/initial binding: ${afterLoad - beforeLoad} bytes; preparation/diagnostics: " +
                "${GC.GetAllocatedBytesForCurrentThread() - afterLoad} bytes"
        )
        let translation = Task.Run(
            () -> {
                let started = Stopwatch.GetTimestamp()
                let before = GC.GetAllocatedBytesForCurrentThread()
                let translator = CSharpToGSharpTranslator()
                let unit = translator.TranslateDocument(document, context)
                let afterTranslation = GC.GetAllocatedBytesForCurrentThread()
                let printed = GSharpPrinter.Print(unit)
                this.translationAllocatedBytes = GC.GetAllocatedBytesForCurrentThread() - before
                this.translationElapsedMilliseconds = Stopwatch.GetElapsedTime(started).TotalMilliseconds
                this.translatorAllocatedBytes = afterTranslation - before
                this.printerAllocatedBytes = this.translationAllocatedBytes - this.translatorAllocatedBytes
                this.translationOriginMetrics = translator.LastDefaultOriginMetrics
                this.translationDiagnosticText = string.Join(
                    "\n",
                    context.Diagnostics.Select((diagnostic TranslationDiagnostic) -> diagnostic.ToString())
                )
                if measureWork {
                    // Measure work separately so opt-in counter overhead cannot change the allocation oracle.
                    let beforeWork = GC.GetAllocatedBytesForCurrentThread()
                    using let measurements = CompilationMeasurements.Start("scalar-alias-work")
                    let measuredContext = TranslationContext(compilation, document.SemanticModel, document.FilePath)
                    let measured = GSharpPrinter.Print(
                        CSharpToGSharpTranslator().TranslateDocument(document, measuredContext)
                    )
                    let workAllocatedBytes = GC.GetAllocatedBytesForCurrentThread() - beforeWork
                    Assert.Equal(Encoding.UTF8.GetBytes(printed), Encoding.UTF8.GetBytes(measured))
                    Assert.Equal(
                        this.translationDiagnosticText,
                        string.Join(
                            "\n",
                            measuredContext.Diagnostics.Select(
                                (diagnostic TranslationDiagnostic) -> diagnostic.ToString()
                            )
                        )
                    )
                    for counter in[]string{
                        "tuple_state_keys",
                        "tuple_state_key_characters",
                        "tuple_state_key_node_visits",
                        "projection_alias_facts",
                        "projection_alias_visits",
                        "projection_initializer_queries",
                        "projection_alias_terminal_build_visits",
                        "projection_alias_terminal_entries",
                        "projection_alias_live_boundary_visits",
                        "promoted_value_evaluations",
                        "promoted_value_dependency_reads",
                        "promoted_value_invalidation_visits",
                        "promoted_value_retained_dependencies",
                        "reassignment_node_visits",
                        "reassignment_write_probes",
                        "reassignment_storage_target_visits",
                        "reassignment_symbol_queries",
                        "reassignment_receiver_type_queries",
                        "storage_write_target_probes",
                        "storage_write_tuple_visits",
                        "guard_scope_node_visits",
                        "guard_candidate_visits",
                        "guard_subject_symbol_queries",
                        "scope_declaration_symbol_queries",
                        "scope_address_node_visits",
                        "scope_boundary_visits",
                        "scope_namesake_visits",
                        "scope_write_indexes",
                        "scope_write_candidates",
                        "scope_guard_indexes",
                        "scope_guard_candidates"
                    } {
                        this.translationWork[counter] = measurements.GetCounter("translation." + counter)
                    }
                    this.output.WriteLine("Separate instrumented translator/printer: $workAllocatedBytes bytes")
                }
                return printed
            }
        )
        Assert.True(translation.Wait(TimeSpan.FromSeconds(10)), "Translation took over 10 seconds.")
        this.output.WriteLine("Translation: ${this.translationElapsedMilliseconds} ms")
        return translation.Result
    }
}
