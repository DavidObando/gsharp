package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text
import Xunit

class Issue4726RefAliasNullabilityTests {
    @Theory
    @InlineData("ref")
    @InlineData("out")
    @InlineData("in")
    func TupleLeafRefArgument_SharesTheParameterContract(kind string) {
        let body = if kind == "in" {
            ""
        } else {
            "text = null;"
        }
        let source = `public static class Obj {
    private static (string Text, int Code) row = ("x", 1);
#nullable enable
    private static void Apply(` + kind + ` string? text) { ` + body + ` }
#nullable disable
    private static string Read() {
        Apply(` + kind + ` row.Text);
        return row.Text;
    }
    public static string Run() => Read() ?? "null";
}`
        let printed = Translate(source)
        Assert.Contains("Text string?", printed)
        AssertParity(
            source,
            printed,
            if kind == "in" {
                "x"
            } else {
                "null"
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func FixedTupleRefReturn_ConstrainsItsObliviousLeaf(readOnly bool) {
        let modifier = if readOnly {
            "ref readonly"
        } else {
            "ref"
        }
        let source = `public static class Obj {
    private static (string Text, int Code) row = ("x", 1);
#nullable enable
    public static ` + modifier + ` string Borrow() => ref row.Text;
#nullable disable
    public static string Run() {
        ` + modifier + ` string alias = ref Borrow();
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("Text string?", printed)
        AssertParity(source, printed, "x")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ArrayTupleLeafRefAlias_PromotesTheOwningStorage(nested bool) {
        let declaration = if nested {
            "((string Text, int Code) Inner, int Flag)[][] rows = new[] { new[] { ((\"x\", 1), 2) } };"
        } else {
            "(string Text, int Code)[] rows = new[] { (\"x\", 1) };"
        }
        let storage = if nested {
            "rows[0][0].Inner.Text"
        } else {
            "rows[0].Text"
        }
        let source = `public static class Obj {
    private static ` + declaration + `
    private static string Read() {
        ref string alias = ref ` + storage + `;
        alias = null;
        return ` + storage + `;
    }
    public static string Run() => Read() ?? "null";
}`
        let printed = Translate(source)
        Assert.Contains("Text string?", printed)
        AssertParity(source, printed, "null")
    }

    @Fact
    func SuppressedNestedTupleReceiver_ForwardsItsNullableLeafToTheAlias() {
        const source = `public static class Obj {
    private static ((string Text, int Code) Inner, int Flag) row = ((null, 1), 2);
    private static string Read() {
        ref string alias = ref row.Inner!.Text;
        return alias;
    }
    public static string Run() => Read() ?? "null";
}`
        let printed = Translate(source)
        Assert.Contains("ref alias string? = row.Inner.Text", printed)
        AssertParity(source, printed, "null")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleValuedRefAlias_SharesNullableLeavesWithItsStorage(nested bool) {
        let tuple = if nested {
            "((string Text, int Code) Inner, int Flag)"
        } else {
            "(string Text, int Code)"
        }
        let initial = if nested {
            "((\"x\", 1), 2)"
        } else {
            "(\"x\", 1)"
        }
        let storage = if nested {
            "row.Inner"
        } else {
            "row"
        }
        let source = `public static class Obj {
    private static ` + tuple + ` row = ` + initial + `;
    public static string Run() {
        ref (string? Text, int Code) alias = ref ` + storage + `;
        return alias.Text;
    }
}`
        let printed = Translate(source)
        Assert.Contains("Text string?", printed)
        AssertParity(source, printed, "x")
    }

    @Theory
    @InlineData("row.Text!")
    @InlineData("(row.Text!)")
    func SuppressedTupleRefAlias_StillSharesNullableStorage(expression string) {
        let source = `public static class Obj {
    private static (string Text, int Code) row = ("x", 1);
    public static string Read() {
        ref string alias = ref ` + expression + `;
        alias = null;
        return row.Text;
    }
    public static string Run() => Read() ?? "null";
}`
        let printed = Translate(source)
        Assert.Contains("Text string?", printed)
        Assert.Contains("ref alias string? =", printed)
        Assert.True(!printed.Contains("!!", StringComparison.Ordinal), printed)
        AssertParity(source, printed, "null")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NullableTupleRefAlias_SeedsItsStorageWithoutANullWrite(readOnly bool) {
        let modifier = if readOnly {
            "ref readonly"
        } else {
            "ref"
        }
        let source = `public static class Obj {
    private static (string Text, int Code) row = ("x", 1);
    public static string Run() {
        ` + modifier + ` string? alias = ref row.Text;
        return alias;
    }
}`
        let printed = Translate(source)
        Assert.Contains("Text string?", printed)
        Assert.Contains(
            "ref " +
                (
                if readOnly {
                    "readonly "
                } else {
                    ""
                }
            ) +
                "alias string? = row.Text",
            printed
        )
        AssertParity(source, printed, "x")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleElementAlias_PreservesTheStorageAndNullWrites(clear bool) {
        let assigned = if clear {
            "null"
        } else {
            "\"keep\""
        }
        let source = `public static class Obj {
    private static (string Text, int Code) Read() {
        (string Text, int Code) row = ("x", 1);
        ref string alias = ref row.Text;
        alias = ` + assigned + `;
        return row;
    }
    public static string Run() {
        var row = Read();
        return ` + (
            if clear {
                "(row.Text ?? \"null\")"
            } else {
                "row.Text"
            }
        ) + ` + ":" + row.Code;
    }
}`
        let printed = Translate(source)
        Assert.Contains(
            if clear {
                "ref alias string? = row.Text"
            } else {
                "ref alias string = row.Text"
            },
            printed
        )
        AssertParity(
            source,
            printed,
            if clear {
                "null:1"
            } else {
                "keep:1"
            }
        )
    }

    @Fact
    func GuardedIteratorAlias_PreservesNullableStorageAndCSharpOutput() {
        const source = `using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        if (text != null) {
            ref string alias = ref text;
            alias = null;
            yield return (text, 1);
        }
    }
    public static string Run() {
        string output = "";
        foreach (var row in Rows(true)) { output += "unexpected"; }
        foreach (var row in Rows(false)) {
            output += (row.Text ?? "null") + ":" + row.Code;
        }
        return output;
    }
}`
        let printed = Translate(source)
        Assert.Contains("var ref alias string? = text", printed)
        Assert.Contains("sequence[(Text string?, Code int32)]", printed)
        Assert.DoesNotContain("text!!", printed)
        Assert.DoesNotContain("alias!!", printed)
        AssertParity(source, printed, "null:1")
    }

    @Theory
    @InlineData("returned-array")
    @InlineData("subarray")
    @InlineData("parameter")
    @InlineData("typed-alias")
    @InlineData("array-write")
    @InlineData("array-write-cycle")
    @InlineData("out-element")
    @InlineData("nullable-ref-argument")
    func ConnectedStorageReads_PreserveCSharpOutput(shape string) {
        let source = switch shape {
            case "out-element": `public static class Obj {
    private static void Clear(out string value) { value = null; }
    private static string Read() {
        var xs = new[] { "x" };
        ref string[] ys = ref xs;
        Clear(out ys[0]);
        return xs[0];
    }
    public static string Run() => Read() ?? "null";
}`
            case "nullable-ref-argument": `public static class Obj {
#nullable enable
    private static void Keep(ref string value) { }
    public static string Run() {
        string? text = "x";
#nullable disable
        Keep(ref text);
        ref string alias = ref text;
        return alias ?? "fallback";
    }
}`
            case "array-write": `public static class Obj {
    private static string Read() {
        var xs = new[] { "x" };
        ref string[] ys = ref xs;
        ys[0] = null;
        return xs[0];
    }
    public static string Run() => Read() ?? "null";
}`
            case "array-write-cycle": `public static class Obj {
    private static string Read() {
        var xs = new[] { "x" };
        ref string[] ys = ref xs;
        ys[0] = xs[0];
        ys[0] = null;
        return xs[0];
    }
    public static string Run() => Read() ?? "null";
}`
            case "parameter": `public static class Obj {
    private static ref string Borrow(ref string value) => ref value;
    private static string Read() {
        var xs = new[] { "x" };
        ref string alias = ref Borrow(ref xs[0]);
        alias = null;
        return xs[0];
    }
    public static string Run() => Read() ?? "null";
}`
            case "typed-alias": `public static class Obj {
    public static string Run() {
        var xs = new[] { "x" };
        string[] ys = xs;
        ref string alias = ref ys[0];
        alias = null;
        return xs[0] ?? "null";
    }
}`
            case "returned-array": `public static class Obj {
    private static string[] xs = new[] { "x" };
    private static ref string[] Borrow() => ref xs;
    private static string Read() {
        ref string[] ys = ref Borrow();
        ref string alias = ref ys[0];
        alias = null;
        return xs[0];
    }
    public static string Run() => Read() ?? "null";
}`
            default: `public static class Obj {
    private static string Read() {
        string[][] xs = new[] { new[] { "x" } };
        ref string[] ys = ref xs[0];
        ref string alias = ref ys[0];
        alias = null;
        return xs[0][0];
    }
    public static string Run() => Read() ?? "null";
}`
        }
        AssertParity(
            source,
            Translate(source),
            if shape == "nullable-ref-argument" {
                "x"
            } else {
                "null"
            }
        )
    }

    @Fact
    func LinkedArrayPromotion_ReachesAnIdleRepositoryProject() {
        const sharedSource = `public static class Shared { public static string[] xs = new[] { "x" }; }`
        const appSource = `public static class Obj {
    public static string Run() {
        ref string alias = ref Shared.xs[0];
        alias = null;
        return Shared.xs[0] ?? "null";
    }
}`
        let app = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Shared.cs", sharedSource), ("App.cs", appSource)}
        )
        let idle = CSharpProjectLoader.LoadInMemory([](string, string){("Shared.cs", sharedSource)})
        let repository = []CSharpCompilation{app.Compilation, idle.Compilation}
        var appShared string? = nil
        var appPrinted = ""
        for project in[]LoadedCSharpProject{app, idle} {
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            for document in project.Documents {
                let context = TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath,
                    repositoryCompilations: repository
                )
                let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                )
                if document.FilePath.EndsWith("Shared.cs", StringComparison.Ordinal) {
                    if project == app {
                        appShared = printed
                    } else {
                        Assert.NotNull(appShared)
                        Assert.Equal(appShared, printed)
                    }
                }
                if project == app {
                    appPrinted += printed + Environment.NewLine
                }
            }
        }
        AssertParity(sharedSource + Environment.NewLine + appSource, appPrinted, "null")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func NullStoreThroughAlias_PromotesReferentAndAliasChain(chain bool, wrapped bool) {
        let text = if wrapped {
            "(text!)"
        } else {
            "text"
        }
        let first = if wrapped {
            "(first!)"
        } else {
            "first"
        }
        let alias = if chain {
            "ref string first = ref $text; ref string alias = ref $first;"
        } else {
            "ref string alias = ref $text;"
        }
        let source = `public static class Obj {
    public static string Clear() {
        string text = "x";
        ` + alias + `
        alias = null;
        return text;
    }
    public static string Run() => Clear() ?? "null";
}`
        let printed = Translate(source)
        Assert.Contains("var text string? = \"x\"", printed)
        Assert.Contains("var ref alias string? =", printed)
        if chain {
            Assert.Contains("ref first string? = text", printed)
        }
        AssertParity(source, printed, "null")
    }

    @Fact
    func NullableFieldStorage_PromotesItsReadOnlyAlias() {
        const source = `public class Holder { public string Text = "x"; }
public static class Obj {
    public static void Clear(Holder holder) { holder.Text = null; }
    public static string Run() {
        var holder = new Holder();
        Clear(holder);
        ref readonly string alias = ref holder.Text;
        return alias ?? "null";
    }
}`
        let printed = Translate(source)
        Assert.Contains("var Text string?", printed)
        Assert.Contains("let ref readonly alias string? = holder.Text", printed)
        AssertParity(source, printed, "null")
    }

    @Fact
    func NonNullAlias_DoesNotWidenUnrelatedStorage() {
        const source = `public static class Obj {
    public static string Run() {
        string text = "x";
        ref string alias = ref text;
        alias = "keep";
        return text;
    }
}`
        let printed = Translate(source)
        Assert.Contains("var ref alias string = text", printed)
        Assert.DoesNotContain("string?", printed)
        AssertParity(source, printed, "keep")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CoalesceOnlyEvidence_PromotesBothSidesOfRefStorage(coalesceReferent bool) {
        let read = if coalesceReferent {
            "text"
        } else {
            "alias"
        }
        let source = `public static class Obj {
    public static string Run() {
        string text = "x";
        ref string alias = ref text;
        return ` + read + ` ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x")
        Assert.Contains("var text string? = \"x\"", printed)
        Assert.Contains("let ref alias string? = text", printed)
    }

    @Fact
    func CoalesceOnlyAliasEvidence_PromotesItsFieldStorage() {
        const source = `public class Holder { public string Text = "x"; }
public static class Obj {
    public static string Run() {
        var holder = new Holder();
        ref readonly string alias = ref holder.Text;
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x")
        Assert.Contains("var Text string?", printed)
        Assert.Contains("let ref readonly alias string? = holder.Text", printed)
    }

    @Theory
    @InlineData("fixed-field")
    @InlineData("array")
    @InlineData("ref-return")
    func RefStorageBoundaries_CoalescingAliasMatchesCSharp(storage string) {
        let source = switch storage {
            case "fixed-field": `#nullable enable
public class Holder { public string Text = "x"; }
#nullable disable
public static class Obj {
    public static string Run() {
        var holder = new Holder();
        ref readonly string alias = ref holder.Text;
        return alias ?? "fallback";
    }
}`
            case "array": `public static class Obj {
    public static string Run() {
        var xs = new[] { "x" };
        ref string alias = ref xs[0];
        return alias ?? "fallback";
    }
}`
            default: `public static class Obj {
    private static string text = "x";
    public static ref string Borrow() => ref text;
    public static string Run() {
        ref string alias = ref Borrow();
        return alias ?? "fallback";
    }
}`
        }
        AssertParity(source, Translate(source), "x")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ArrayRefReturn_UsesItsElementStorage(blockBody bool) {
        let body = if blockBody {
            "{ return ref xs[0]; }"
        } else {
            "=> ref xs[0];"
        }
        let source = `public static class Obj {
    private static string[] xs = new[] { "x" };
    public static ref string Borrow() ` + body + `
    public static string Run() {
        ref string alias = ref Borrow();
        return alias ?? "fallback";
    }
}`
        AssertParity(source, Translate(source), "x")
    }

    @Fact
    func ArrayRefAliases_ShareTheElementContract() {
        const source = `public static class Obj {
    public static string Run() {
        var xs = new[] { "x" };
        ref string first = ref xs[0];
        ref string second = ref xs[0];
        return first ?? second;
    }
}`
        AssertParity(source, Translate(source), "x")
    }

    @Fact
    func FixedRefReturn_ConstrainsItsObliviousFieldStorage() {
        const source = `public static class Obj {
    private static string text = "x";
#nullable enable
    public static ref string Borrow() => ref text;
#nullable disable
    public static string Run() {
        ref string alias = ref Borrow();
        return alias ?? "fallback";
    }
}`
        AssertParity(source, Translate(source), "x")
    }

    @Theory
    @InlineData("property")
    @InlineData("getter")
    @InlineData("indexer")
    func RefGetters_KeepTheFixedStorageContract(shape string) {
        let member = switch shape {
            case "property": "public ref string Borrow => ref Text;"
            case "getter": "public ref readonly string Borrow { get { return ref Text; } }"
            default: "public ref string this[int index] => ref Text;"
        }
        let access = if shape == "indexer" {
            "holder[0]"
        } else {
            "holder.Borrow"
        }
        let source = `#nullable enable
public class Holder {
    public string Text = "x";
#nullable disable
    ` + member + `
}
public static class Obj {
    public static string Run() {
        var holder = new Holder();
        ref readonly string alias = ref ` + access + `;
        return alias ?? "fallback";
    }
}`
        AssertParity(source, Translate(source), "x")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func MixedRefReturnTargets_ShareTheFixedContract(choose bool) {
        let source = `public static class Obj {
#nullable enable
    private static string fixedText = "fixed";
#nullable disable
    private static string other = "other";
    public static ref string Borrow(bool choose) {
        if (choose) { return ref fixedText; }
        return ref other;
    }
    public static string Run() {
        ref string alias = ref Borrow(` + (
            if choose {
                "true"
            } else {
                "false"
            }
        ) + `);
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain("string?", printed)
        AssertParity(
            source,
            printed,
            if choose {
                "fixed"
            } else {
                "other"
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ParameterArrayRefReturn_SharesElementStorage(blockBody bool) {
        let body = if blockBody {
            "{ return ref xs[0]; }"
        } else {
            "=> ref xs[0];"
        }
        let source = `public static class Obj {
    public static ref string Borrow(string[] xs) ` + body + `
    public static string Run() {
        var xs = new[] { "x" };
        ref string alias = ref Borrow(xs);
        return alias ?? "fallback";
    }
}`
        AssertParity(source, Translate(source), "x")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RecursiveRefArrayParameter_PreservesStorageAndNullableEvidence(nullable bool) {
        let value = if nullable {
            "null"
        } else {
            "\"x\""
        }
        let source = `public static class Obj {
    private static string[] xs = new string[] { ` + value + ` };
    public static ref string Pick(ref string value, bool choose) {
        if (choose) { return ref value; }
        return ref xs[0];
    }
    public static string Read() {
        ref string alias = ref Pick(ref xs[0], false);
        return alias;
    }
    public static string Run() => Read() ?? "null";
}`
        let printed = Translate(source)
        if !nullable {
            Assert.DoesNotContain("string?", printed)
        }
        AssertParity(
            source,
            printed,
            if nullable {
                "null"
            } else {
                "x"
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RecursiveArrayWrite_PreservesStorageAndNullableEvidence(nullable bool) {
        let value = if nullable {
            "null"
        } else {
            "\"x\""
        }
        let source = `public static class Obj {
    public static string Read() {
        var xs = new string[1];
        xs[0] = ` + value + `;
        ref string alias = ref xs[0];
        xs[0] = alias;
        return alias;
    }
    public static string Run() => Read() ?? "null";
}`
        let printed = Translate(source)
        if !nullable {
            Assert.DoesNotContain("string?", printed)
        }
        AssertParity(
            source,
            printed,
            if nullable {
                "null"
            } else {
                "x"
            }
        )
    }

    @Fact
    func ArrayOwnerAliases_ForwardNullToTheScalarReturn() {
        const source = `public static class Obj {
    public static string Read() {
        var xs = new[] { "x" };
        var ys = xs;
        ref string first = ref xs[0];
        ref string second = ref ys[0];
        first = null;
        return second;
    }
    public static string Run() => Read() ?? "null";
}`
        AssertParity(source, Translate(source), "null")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefIndexer_ForwardNullToTheScalarReturn(readOnly bool) {
        let modifier = if readOnly {
            "readonly "
        } else {
            ""
        }
        let source = `public class Holder {
    public string Text = null;
    public ref ` + modifier + `string this[int index] => ref Text;
}
public static class Obj {
    public static string Read() {
        var holder = new Holder();
        ref ` + modifier + `string alias = ref holder[0];
        return alias;
    }
    public static string Run() => Read() ?? "null";
}`
        AssertParity(source, Translate(source), "null")
    }

    @Fact
    func FixedRefArgument_ConstrainsTheForwardedStorage() {
        const source = `public static class Obj {
#nullable enable
    private static string fixedText = "x";
#nullable disable
    public static ref string Borrow(ref string value) => ref value;
    public static string Run() {
        ref string alias = ref Borrow(ref fixedText);
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x")
        Assert.DoesNotContain("string?", printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func GenericRefArgument_PreservesTheSubstitutedContract(constrained bool, nullable bool) {
        let constraint = if constrained {
            " where T : class"
        } else {
            ""
        }
        let suffix = if nullable && !constrained {
            "?"
        } else {
            ""
        }
        let fieldSuffix = if nullable {
            "?"
        } else {
            ""
        }
        let value = if nullable {
            "null"
        } else {
            "\"x\""
        }
        let source = `public static class Obj {
#nullable enable
    private static string` + fieldSuffix + ` text = ` + value + `;
#nullable disable
    public static ref T Borrow<T>(ref T value)` + constraint + ` => ref value;
    public static string Run() {
        ref string alias = ref Borrow<string` + suffix + `>(ref text);
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(
            source,
            printed,
            if nullable {
                "fallback"
            } else {
                "x"
            }
        )
        if !nullable {
            Assert.DoesNotContain("string?", printed)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func GenericFieldAlias_PreservesTheSubstitutedContract(constrained bool, nullable bool) {
        let constraint = if constrained {
            " where T : class"
        } else {
            ""
        }
        let suffix = if nullable && !constrained {
            "?"
        } else {
            ""
        }
        let value = if nullable && !constrained {
            "null"
        } else {
            "\"x\""
        }
        let source = `public class Box<T>` + constraint + ` {
    public T Value;
    public Box(T value) { Value = value; }
}
public static class Obj {
    public static string Run() {
        var box = new Box<string` + suffix + `>(` + value + `);
        ref string alias = ref box.Value;
        ` + (
            if nullable && constrained {
                "alias = null;"
            } else {
                ""
            }
        ) + `
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(
            source,
            printed,
            if nullable {
                "fallback"
            } else {
                "x"
            }
        )
        if !nullable && !constrained {
            Assert.DoesNotContain("string?", printed)
        }
        if constrained {
            Assert.Contains("var Value T?", printed)
        }
    }

    @Fact
    func FixedArrayElement_ConstrainsItsRefAliasAndArgument() {
        const source = `public static class Obj {
#nullable enable
    private static string[] xs = new[] { "x" };
    private static void Keep(ref string value) { }
#nullable disable
    public static string Run() {
        ref string alias = ref xs[0];
        Keep(ref xs[0]);
        return alias ?? "fallback";
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x")
        Assert.DoesNotContain("string?", printed)
    }

    @Fact
    func GenericFieldSubstitutions_KeepIndependentAliasContracts() {
        const source = `public class Box<T> {
    public T Value;
    public Box(T value) { Value = value; }
}
public static class Obj {
    public static string Run() {
        var plain = new Box<string>("x");
        var nullable = new Box<string?>(null);
        ref string first = ref plain.Value;
        ref string second = ref nullable.Value;
        return (first ?? "unexpected") + ":" + (second ?? "fallback");
    }
}`
        let printed = Translate(source)
        AssertParity(source, printed, "x:fallback")
        Assert.Contains("ref first string = plain.Value", printed)
        Assert.Contains("ref second string? = nullable.Value", printed)
    }

    @Theory
    @InlineData("local")
    @InlineData("generated-initializer")
    @InlineData("generated-element")
    func AnnotatedArrayStorage_NullWritesStillPromoteTheElement(shape string) {
        let source = if shape == "generated-element" {
            `// <auto-generated/>
#nullable enable
public static class Obj {
    private static string[] xs = new[] { "x" };
#nullable disable
    public static string Run() {
        xs[0] = null;
        ref string alias = ref xs[0];
        return alias ?? "fallback";
    }
}`
        } else if shape == "generated-initializer" {
            `// <auto-generated/>
#nullable enable
public static class Obj {
    private static string[] xs = new string[] { null };
#nullable disable
    public static string Run() {
        ref string alias = ref xs[0];
        return alias ?? "fallback";
    }
}`
        } else {
            `public static class Obj {
    public static string Run() {
#nullable enable
        var xs = new string[1];
        xs[0] = null;
#nullable disable
        ref string alias = ref xs[0];
        return alias ?? "fallback";
    }
}`
        }
        AssertParity(source, Translate(source), "fallback")
    }

    @Theory
    @InlineData("element-read")
    @InlineData("array-alias")
    @InlineData("jagged")
    @InlineData("out-discard")
    @InlineData("out-direction")
    @InlineData("reduced-extension")
    @InlineData("reduced-generic")
    @InlineData("reduced-generic-nullable")
    @InlineData("ref-return-array")
    @InlineData("jagged-array-alias")
    func RefStorageEdges_PreserveCSharpOutput(shape string) {
        let source = switch shape {
            case "element-read": `public static class Obj {
    public static string Read() {
        var xs = new[] { "x" };
        ref string alias = ref xs[0];
        alias = null;
        return xs[0];
    }
    public static string Run() => Read() ?? "null";
}`
            case "array-alias": `public static class Obj {
    public static string Run() {
        var xs = new[] { "x" };
        ref string[] ys = ref xs;
        ref string alias = ref ys[0];
        alias = null;
        return xs[0] ?? "null";
    }
}`
            case "jagged": `public static class Obj {
    public static string Run() {
        string[][] xs = new[] { new[] { "x" } };
        ref string alias = ref xs[0][0];
        return alias ?? "fallback";
    }
}`
            case "out-discard": `public static class Obj {
    private static void Clear(out string value) { value = null; }
    public static string Run() { Clear(out _); return "x"; }
}`
            case "out-direction": `public static class Obj {
#nullable enable
    private static void Produce(out string value) { value = "x"; }
#nullable disable
    public static string Run() {
        string text = "x";
        Produce(out text);
        ref string alias = ref text;
        alias = null;
        return text ?? "null";
    }
}`
            case "reduced-generic": `#nullable enable
public class Holder<T> { public string Text = "x"; }
#nullable disable
public static class Extensions {
    public static ref string Borrow<T>(this Holder<T> holder) => ref holder.Text;
}
public static class Obj {
    public static string Run() {
        var holder = new Holder<int>();
        ref string alias = ref holder.Borrow();
        return alias ?? "fallback";
    }
}`
            case "reduced-generic-nullable": `#nullable enable
public class Holder<T> {
    public T Value;
    public Holder(T value) { Value = value; }
}
#nullable disable
public static class Extensions {
    public static ref T Borrow<T>(this Holder<T> holder) => ref holder.Value;
}
public static class Obj {
    public static string Run() {
        var holder = new Holder<string?>(null);
        ref string alias = ref holder.Borrow();
        return alias ?? "null";
    }
}`
            case "ref-return-array": `public static class Obj {
    private static string[] xs = new[] { "x" };
    private static ref string[] Borrow() => ref xs;
    public static string Run() {
        ref string[] ys = ref Borrow();
        ref string alias = ref ys[0];
        alias = null;
        return xs[0] ?? "null";
    }
}`
            case "jagged-array-alias": `public static class Obj {
    public static string Run() {
        string[][] xs = new[] { new[] { "x" } };
        ref string[] ys = ref xs[0];
        ref string alias = ref ys[0];
        alias = null;
        return xs[0][0] ?? "null";
    }
}`
            default: `#nullable enable
public class Holder { public string Text = "x"; }
#nullable disable
public static class Extensions {
    public static ref string Borrow(this Holder holder) => ref holder.Text;
}
public static class Obj {
    public static string Run() {
        var holder = new Holder();
        ref string alias = ref holder.Borrow();
        return alias ?? "fallback";
    }
}`
        }
        let expected = if shape is "element-read" or
            "array-alias" or
            "out-direction" or
            "reduced-generic-nullable" or
            "ref-return-array" or
            "jagged-array-alias" {
            "null"
        } else {
            "x"
        }
        AssertParity(source, Translate(source), expected)
    }

    @Theory
    @InlineData("(string)null")
    @InlineData("null as string")
    @InlineData("default(string)")
    @InlineData("(string)default")
    func CastNullNestedIterator_KeepsOuterContractAndRuntimeParity(value string) {
        let source = `using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        IEnumerable<(string Text, int Code)> Missing() {
            yield return choose ? (` + value + `, 1) : ("x", 2);
        }
        int count = 0;
        foreach (var row in Missing()) {
            count++;
            if (choose) {
                if (row.Text != null || row.Code != 1) { throw new System.InvalidOperationException("nested tuple"); }
            } else {
                if (row.Text != "x" || row.Code != 2) { throw new System.InvalidOperationException("nested tuple"); }
            }
        }
        if (count != 1) { throw new System.InvalidOperationException("nested row count"); }
        if (choose) { yield break; }
        yield return ("keep", 2);
    }
    public static IEnumerable<(string Text, int Code)> MissingRows(bool choose) {
        yield return choose ? (` + value + `, 1) : ("x", 2);
    }
    public static string Run() {
        string output = "";
        foreach (var row in Rows(true)) { output += "unexpected"; }
        foreach (var row in Rows(false)) { output += row.Text + ":" + row.Code + "|"; }
        foreach (var row in MissingRows(true)) { output += (row.Text ?? "null") + ":" + row.Code + "|"; }
        foreach (var row in MissingRows(false)) { output += row.Text + ":" + row.Code; }
        return output;
    }
}`
        let printed = Translate(source)
        Assert.Contains("let Missing = func () IEnumerable[(Text string?, Code int32)]", printed)
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        Assert.Contains("func MissingRows(choose bool) sequence[(Text string?, Code int32)]", printed)
        AssertParity(source, printed, "keep:2|null:1|x:2")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func LinkedFieldContracts_AgreeAcrossRepositoryCompilations(idleProject bool) {
        const sharedSource = `public static class Shared { public static string Text = "x"; }`
        const appSource = `public static class Obj {
    public static string Run() {
        ref string alias = ref Shared.Text;
        return alias ?? "fallback";
    }
}`
        const constraintSource = `#nullable enable
public static class Constraint {
    public static ref string Keep() => ref Shared.Text;
}`
        let app = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Shared.cs", sharedSource), ("App.cs", appSource)}
        )
        let constraint = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Shared.cs", sharedSource), ("Constraint.cs", constraintSource)}
        )
        let idle = CSharpProjectLoader.LoadInMemory([](string, string){("Shared.cs", sharedSource)})
        let projects = if idleProject {
            []LoadedCSharpProject{app, constraint, idle}
        } else {
            []LoadedCSharpProject{app, constraint}
        }
        let repository = projects.Select((project LoadedCSharpProject) -> project.Compilation).ToArray()
        let translator = CSharpToGSharpTranslator()
        var appShared string? = nil
        var constraintShared string? = nil
        var appPrinted = ""
        for project in projects {
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            for document in project.Documents {
                let context = TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath,
                    repositoryCompilations: repository
                )
                let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                )
                if document.FilePath.EndsWith("Shared.cs", StringComparison.Ordinal) {
                    if project == app {
                        appShared = printed
                    } else if project == constraint {
                        constraintShared = printed
                    } else {
                        Assert.Equal(appShared, printed)
                    }
                }
                if project == app {
                    appPrinted += printed + Environment.NewLine
                }
            }
        }
        Assert.NotNull(appShared)
        Assert.NotNull(constraintShared)
        Assert.Equal(appShared, constraintShared)
        AssertParity(sharedSource + Environment.NewLine + appSource, appPrinted, "x")
    }

    shared {
        private func Translate(source string) string {
            let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", source)})
            Assert.True(loaded.BoundWithoutErrors, string.Join(Environment.NewLine, loaded.ErrorDiagnostics))
            Assert.Equal(NullableContextOptions.Disable, loaded.Compilation.Options.NullableContextOptions)
            let tree = Assert.Single(loaded.Compilation.SyntaxTrees)
            let document = LoadedDocument(tree.FilePath, tree, loaded.Compilation.GetSemanticModel(tree))
            let context = TranslationContext(loaded.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func AssertParity(source string, printed string, expected string) {
            let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", source)})
            using let stream = MemoryStream()
            let emitted = loaded.Compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            stream.Position = 0
            let context = AssemblyLoadContext("issue4726-oracle", isCollectible: true)
            var oracle string
            try {
                let assembly = context.LoadFromStream(stream)
                let method = assembly.GetType("Obj")!!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!!
                oracle = Assert.IsType[string](method.Invoke(nil, nil))
            } finally {
                context.Unload()
            }
            Assert.Equal(expected, oracle)
            let compiler = FindCompiler()
            let directory = Path.Combine(AppContext.BaseDirectory, "issue4726", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let input = Path.Combine(directory, "Source.gs")
                let output = Path.Combine(directory, "Source.dll")
                File.WriteAllText(input, printed + Environment.NewLine + "System.Console.WriteLine(Obj.Run())")
                let (compileExit, compileLog) = RunDotnet(
                    compiler,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/out:" + output,
                    input
                )
                Assert.True(compileExit == 0, compileLog + Environment.NewLine + printed)
                Assert.DoesNotContain("GS0612", compileLog)
                let (runExit, stdout) = RunDotnet(output)
                Assert.True(runExit == 0, stdout)
                Assert.Equal(Encoding.UTF8.GetBytes(oracle + Environment.NewLine), Encoding.UTF8.GetBytes(stdout))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }

            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(120_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                throw TimeoutException("The compiler or translated program did not finish.")
            }
            return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }

        private func FindCompiler() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                let compiler = Path.Combine(directory.FullName, "Compiler", "gsc.dll")
                if File.Exists(compiler) {
                    return compiler
                }
                directory = directory.Parent
            }
            throw FileNotFoundException("Build gsc before running runtime parity tests.")
        }
    }
}
