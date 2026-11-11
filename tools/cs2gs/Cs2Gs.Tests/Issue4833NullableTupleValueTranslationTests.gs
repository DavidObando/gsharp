// <copyright file="Issue4833NullableTupleValueTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Reflection
import System.Runtime.Loader
import System.Text
import Xunit

class Issue4833NullableTupleValueTranslationTests {
    @Fact
    func NullableReturnStoredInDictionaryTupleValue_PreservesNullAtRuntime() {
        const source = `using System.Collections.Generic;

public static class Obj
{
    private static string AttributeConstant(bool present)
    {
        if (present)
        {
            return "value";
        }

        return null;
    }

    public static string Run()
    {
        var values = new Dictionary<int, (string Name, string Default)>();
        string fallback = AttributeConstant(false);
        values[0] = ("arg", fallback);

        if (!values.TryGetValue(1, out (string Name, string Default) value))
        {
            value = ("missing", null);
        }

        return (values[0].Default ?? "null") + ":" + value.Name + ":" + (value.Default ?? "null");
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Issue4833.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("Dictionary[int32, (Name string, Default string?)]", printed, StringComparison.Ordinal)
        Assert.Contains("func AttributeConstant(present bool) string?", printed, StringComparison.Ordinal)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
        AssertParity(source, printed, "null:missing:null")
    }

    @Theory
    @InlineData("explicit-literal", "(null, 0)")
    @InlineData("explicit-literal", "(null!, 0)")
    @InlineData("explicit-literal", "((string)null, 0)")
    @InlineData("explicit-literal", "(default(string), 0)")
    @InlineData("explicit-literal", "default")
    @InlineData("implicit-literal", "(null, 0)")
    @InlineData("allocated", "(null, 0)")
    func ArrayElementTupleWrite_DirectAndSuppressedNullLeaves_PromoteElementAndMatchRuntime(
        creationKind string,
        writtenValue string
    ) {
        let setup = switch creationKind {
            case "implicit-literal": "var items = new[] { (\"x\", 0), (\"abc\", 1) };"
            case "allocated": "var items = new (string, int)[2]; items[0] = (\"x\", 0); items[1] = (\"abc\", 1);"
            default: "var items = new (string, int)[] { (\"x\", 0), (\"abc\", 1) };"
        }
        let source = `public static class Obj {
    public static string Run() {
        ` + setup + `
        items[0] = ` + writtenValue + `;
        string output = "";
        foreach (var row in items) output += (row.Item1 ?? "null") + ":" + row.Item2 + ",";
        return output;
    }
}`
        let printed = Translate(source)
        Assert.Contains("(string?, int32)", printed)
        AssertParity(source, printed, "null:0,abc:1,")
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ArrayElementTupleWrite_NestedTupleLeaves_PromoteOnlyTaintedLeafAndMatchRuntime(taintInner bool) {
        let assignment = if taintInner {
            "items[0] = ((null, 1), \"keep\", 2);"
        } else {
            "items[0] = ((\"x\", 1), null!, 2);"
        }
        let source = `public static class Obj {
    public static string Run() {
        var items = new ((string Inner, int Code) Nested, string Tag, int Id)[] {
            (("x", 1), "ok", 2),
            (("y", 3), "z", 4)
        };
        ` + assignment + `
        string output = "";
        foreach (var row in items) {
            output += (row.Nested.Inner ?? "null") + ":" + (row.Tag ?? "null") + ":" + row.Id + ",";
        }
        return output;
    }
}`
        let printed = Translate(source)
        if taintInner {
            Assert.Contains("Inner string?", printed)
            Assert.Contains("Tag string,", printed)
        } else {
            Assert.Contains("Inner string,", printed)
            Assert.Contains("Tag string?", printed)
        }
        AssertParity(
            source,
            printed,
            if taintInner {
                "null:keep:2,y:z:4,"
            } else {
                "x:null:2,y:z:4,"
            }
        )
    }

    @Theory
    @InlineData("ternary")
    @InlineData("switch")
    @InlineData("coalesce-rhs")
    @InlineData("coalesce-lhs")
    func ArrayElementTupleWrite_ConditionalSwitchAndNullCoalescingRhs_PromoteElementAndMatchRuntime(shape string) {
        let writeBody = switch shape {
            case "ternary": "items[0] = flag ? (null, 0) : (\"a\", 1);"
            case "switch": "items[0] = flag switch { true => (null, 0), false => (\"a\", 1) };"
            case "coalesce-rhs": "(string, int)? maybe = flag ? default((string, int)?) : (\"a\", 1); items[0] = maybe ?? (null, 0);"
            default: "(string, int)? maybe = flag ? (null, 0) : default((string, int)?); items[0] = maybe ?? (\"a\", 1);"
        }
        let source = `public static class Obj {
    public static string Eval(bool flag) {
        var items = new (string, int)[] { ("x", 0), ("abc", 1) };
        ` + writeBody + `
        return (items[0].Item1 ?? "null") + ":" + items[0].Item2 + "," + items[1].Item1 + ":" + items[1].Item2;
    }
    public static string Run() => Eval(true) + "|" + Eval(false);
}`
        let printed = Translate(source)
        Assert.Contains("(string?, int32)", printed)
        AssertParity(source, printed, "null:0,abc:1|a:1,abc:1")
    }

    @Theory
    @InlineData("local")
    @InlineData("parameter")
    @InlineData("call")
    @InlineData("array-element")
    @InlineData("scalar-variable")
    func ArrayElementTupleWrite_ForwardedTupleSources_PromoteElementAndMatchRuntime(sourceKind string) {
        let helper = switch sourceKind {
            case "parameter": "private static void Write((string, int)[] items, (string, int) sourceTuple) { items[0] = sourceTuple; }"
            case "call": "private static (string, int) Make(bool missing) => missing ? (null, 0) : (\"a\", 1);"
            default: ""
        }
        let body = switch sourceKind {
            case "local": "var sourceTuple = (\"x\", 0); sourceTuple = (null, 0); items[0] = sourceTuple;"
            case "parameter": "Write(items, (null, 0));"
            case "call": "items[0] = Make(true);"
            case "array-element": "var sourceItems = new (string, int)[] { (\"s\", 1) }; sourceItems[0] = (null, 0); items[0] = sourceItems[0];"
            default: "string label = \"x\"; label = null; items[0] = (label, 0);"
        }
        let source = `public static class Obj {
    ` + helper + `
    public static string Run() {
        var items = new (string, int)[] { ("x", 0), ("abc", 1) };
        ` + body + `
        string output = "";
        foreach (var row in items) output += (row.Item1 == null ? "null" : row.Item1) + ":" + row.Item2 + ",";
        return output;
    }
}`
        let printed = Translate(source)
        Assert.Contains("[](string?, int32)", printed)
        AssertParity(source, printed, "null:0,abc:1,")
    }

    @Theory
    @InlineData("jagged-literal")
    @InlineData("jagged-allocated")
    @InlineData("rectangular-literal")
    @InlineData("rectangular-allocated")
    @InlineData("tuple-projected")
    func ArrayElementTupleWrite_JaggedRectangularAndProjectedArrays_PromoteElementAndMatchRuntime(shape string) {
        let body = switch shape {
            case "jagged-literal": `var grid = new (string, int)[][] { new (string, int)[] { ("x", 0), ("abc", 1) } };
        grid[0][1] = (null, 2);
        return grid[0][0].Item1 + ":" + (grid[0][1].Item1 ?? "null") + ":" + grid[0][1].Item2;`
            case "jagged-allocated": `var grid = new (string, int)[1][];
        grid[0] = new (string, int)[] { ("x", 0), ("abc", 1) };
        grid[0][1] = (null, 2);
        return grid[0][0].Item1 + ":" + (grid[0][1].Item1 ?? "null") + ":" + grid[0][1].Item2;`
            case "rectangular-literal": `var matrix = new (string, int)[1, 2] { { ("x", 0), ("abc", 1) } };
        matrix[0, 1] = (null, 2);
        return matrix[0, 0].Item1 + ":" + (matrix[0, 1].Item1 ?? "null") + ":" + matrix[0, 1].Item2;`
            case "rectangular-allocated": `var matrix = new (string, int)[1, 2];
        matrix[0, 0] = ("x", 0);
        matrix[0, 1] = (null, 2);
        return matrix[0, 0].Item1 + ":" + (matrix[0, 1].Item1 ?? "null") + ":" + matrix[0, 1].Item2;`
            default: `var state = (Rows: new (string, int)[] { ("x", 0), ("abc", 1) }, Count: 2);
        state.Rows[1] = (null, 2);
        return state.Rows[0].Item1 + ":" + (state.Rows[1].Item1 ?? "null") + ":" + state.Rows[1].Item2;`
        }
        let source = `public static class Obj {
    public static string Run() {
        ` + body + `
    }
}`
        let printed = Translate(source)
        Assert.Contains("(string?, int32)", printed)
        AssertParity(source, printed, "x:null:2")
    }

    @Theory
    @InlineData("var-alias")
    @InlineData("explicit-alias")
    @InlineData("assigned-alias")
    @InlineData("jagged-row-alias")
    @InlineData("parameter-alias")
    @InlineData("ref-array-alias")
    func ArrayElementTupleWrite_SharedArrayAliases_PropagateToOwnerAndMatchRuntime(aliasKind string) {
        let helper = if aliasKind == "parameter-alias" {
            "private static void Mutate((string, int)[] alias) { alias[0] = (null, 0); }"
        } else {
            ""
        }
        let body = switch aliasKind {
            case "var-alias": `var items = new (string, int)[] { ("x", 0), ("abc", 1) };
        var alias = items;
        alias[0] = (null, 0);
        return (items[0].Item1 ?? "null") + "," + items[1].Item1;`
            case "explicit-alias": `(string, int)[] items = new (string, int)[] { ("x", 0), ("abc", 1) };
        (string, int)[] alias = items;
        alias[0] = (null, 0);
        return (items[0].Item1 ?? "null") + "," + items[1].Item1;`
            case "assigned-alias": `var items = new (string, int)[] { ("x", 0), ("abc", 1) };
        (string, int)[] alias;
        alias = items;
        alias[0] = (null, 0);
        return (items[0].Item1 ?? "null") + "," + items[1].Item1;`
            case "jagged-row-alias": `var grid = new (string, int)[][] { new (string, int)[] { ("x", 0), ("abc", 1) } };
        var row = grid[0];
        row[0] = (null, 0);
        return (grid[0][0].Item1 ?? "null") + "," + grid[0][1].Item1;`
            case "parameter-alias": `var items = new (string, int)[] { ("x", 0), ("abc", 1) };
        Mutate(items);
        return (items[0].Item1 ?? "null") + "," + items[1].Item1;`
            default: `var items = new (string, int)[] { ("x", 0), ("abc", 1) };
        ref var alias = ref items;
        alias[0] = (null, 0);
        return (items[0].Item1 ?? "null") + "," + items[1].Item1;`
        }
        let source = `public static class Obj {
    ` + helper + `
    public static string Run() {
        ` + body + `
    }
}`
        let printed = Translate(source)
        Assert.Contains("(string?, int32)", printed)
        AssertParity(source, printed, "null,abc")
    }

    @Theory
    @InlineData("fixed-field-alias")
    @InlineData("fixed-interface-property")
    @InlineData("fixed-consumer-parameter")
    func ArrayElementTupleWrite_FixedContracts_DoNotPromoteAndBridgeNullableWrites(contractKind string) {
        let source = switch contractKind {
            case "fixed-field-alias": `#nullable enable
public static class FixedOwner {
    public static (string Text, int Code)[] Rows = new[] { ("keep", 1) };
}
#nullable disable
public static class Obj {
    public static (string Text, int Code) Make(bool missing) => missing ? (null, 0) : ("ok", 2);
    public static string Run() {
        var mutable = new (string Text, int Code)[] { ("start", 9) };
        mutable[0] = (null, 3);
        var alias = FixedOwner.Rows;
        alias[0] = Make(false);
        return (mutable[0].Text ?? "null") + ":" + mutable[0].Code + "|" + FixedOwner.Rows[0].Text + ":" + FixedOwner.Rows[0].Code;
    }
}`
            case "fixed-interface-property": `#nullable enable
public interface IFixedRows {
    (string Text, int Code)[] Rows { get; }
}
#nullable disable
public class Holder : IFixedRows {
    public (string Text, int Code)[] Rows { get; } = new[] { ("keep", 1) };
}
public static class Obj {
    public static (string Text, int Code) Make(bool missing) => missing ? (null, 0) : ("ok", 2);
    public static string Run() {
        var mutable = new (string Text, int Code)[] { ("start", 9) };
        mutable[0] = (null, 3);
        var holder = new Holder();
        holder.Rows[0] = Make(false);
        return (mutable[0].Text ?? "null") + ":" + mutable[0].Code + "|" + holder.Rows[0].Text + ":" + holder.Rows[0].Code;
    }
}`
            default: `#nullable enable
public static class FixedConsumer {
    public static string Format((string Text, int Code)[] rows) => rows[0].Text + ":" + rows[0].Code;
}
#nullable disable
public static class Obj {
    public static (string Text, int Code) Make(bool missing) => missing ? (null, 0) : ("ok", 2);
    public static string Run() {
        var mutable = new (string Text, int Code)[] { ("start", 9) };
        mutable[0] = (null, 3);
        var rows = new (string Text, int Code)[] { ("keep", 1) };
        rows[0] = Make(false);
        return (mutable[0].Text ?? "null") + ":" + mutable[0].Code + "|" + FixedConsumer.Format(rows);
    }
}`
        }
        let printed = Translate(source)
        Assert.Contains("[](Text string, Code int32)", printed)
        Assert.Contains("[](Text string?, Code int32)", printed)
        AssertParity(source, printed, "null:3|ok:2")
    }

    @Fact
    func ArrayOfTuplesContainingArrays_PreservesSegmentOrderAndMatchesRuntime() {
        const source = `public static class Obj {
    public static string Run() {
        var groups = new[] {
            (Id: 7, Rows: new (string, int)[] { ("x", 0), ("abc", 1) })
        };
        groups[0].Rows[0] = (null, 2);
        return groups[0].Id + ":" + (groups[0].Rows[0].Item1 == null ? "null" : groups[0].Rows[0].Item1) + ":" + groups[0].Rows[0].Item2 + "," + groups[0].Rows[1].Item1 + ":" + groups[0].Rows[1].Item2;
    }
}`
        let printed = Translate(source)
        Assert.Contains("Rows: [](string?, int32)", printed)
        AssertParity(source, printed, "7:null:2,abc:1")
    }

    @Fact
    func PromotedArrayElementTuple_PassedToFixedTupleParameter_BridgesLeafAndMatchesRuntime() {
        const source = `#nullable enable
public static class FixedTupleConsumer {
    public static string Consume((string Text, int Code) value) => value.Text + ":" + value.Code;
}
#nullable disable
public static class Obj {
    public static string Run() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 0);
        return (items[0].Text == null ? "null" : items[0].Text) + "|" + FixedTupleConsumer.Consume(items[1]);
    }
}`
        let printed = Translate(source)
        Assert.Contains(".Item1!!", printed)
        AssertParity(source, printed, "null|abc:1")
    }

    @Fact
    func ArrayElementNestedTupleFieldWrite_PromotesNestedLeaf() {
        // Direct tuple-member assignment execution in gsc is tracked by #5897.
        const source = `public static class Obj {
    public static string Run() {
        var items = new ((string Text, int Code) Nested, int Id)[] { (("x", 1), 2), (("abc", 3), 4) };
        items[0].Nested = (null, 5);
        return (items[0].Nested.Text == null ? "null" : items[0].Nested.Text) + ":" + items[0].Nested.Code + ":" + items[0].Id + "," + items[1].Nested.Text + ":" + items[1].Nested.Code + ":" + items[1].Id;
    }
}`
        let printed = Translate(source)
        Assert.Contains("let items = [](Nested (Text string?, Code int32), Id int32)", printed)
        Assert.DoesNotContain("Text string,", printed)
    }

    @Theory
    @InlineData("method-return")
    @InlineData("property-getter")
    @InlineData("property-initializer")
    func ArrayElementTupleWrite_ThroughMethodReturnGetterAndPropertyInitializer_PromotesBackingStorageAndMatchesRuntime(
        memberKind string
    ) {
        let memberDecl = switch memberKind {
            case "method-return": "private static (string, int)[] GetRows() => rows;"
            case "property-getter": "private static (string, int)[] Rows => rows;"
            default: "private static (string, int)[] Rows { get; } = rows;"
        }
        let writeTarget = if memberKind == "method-return" {
            "GetRows()[0] = (null, 0);"
        } else {
            "Obj.Rows[0] = (null, 0);"
        }
        let source = `public static class Obj {
    private static (string, int)[] rows = new (string, int)[] { ("x", 0), ("abc", 1) };
    ` + memberDecl + `
    public static string Run() {
        ` + writeTarget + `
        return (rows[0].Item1 == null ? "null" : rows[0].Item1) + ":" + rows[0].Item2 + "," + rows[1].Item1 + ":" + rows[1].Item2;
    }
}`
        let printed = Translate(source)
        Assert.Contains("[](string?, int32)", printed)
        Assert.DoesNotContain("[](string, int32)", printed)
        AssertParity(source, printed, "null:0,abc:1")
    }

    @Fact
    func PromotedArrayElementTuple_PassedToObliviousNullableTupleParameter_OmitsLeafAssertionAndMatchesRuntime() {
        const source = `public static class Obj {
    private static string Consume((string Text, int Code)? value) =>
        value.HasValue ? (value.Value.Text ?? "null") + ":" + value.Value.Code : "empty";
    public static string Run() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 2);
        return Consume(items[0]) + "|" + Consume(items[1]) + "|" + Consume(null);
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain(".Item1!!", printed)
        AssertParity(source, printed, "null:2|abc:1|empty")
    }

    @Fact
    func CoalescingFallbackTupleArray_PromotesFallbackAllocationAndMatchesRuntime() {
        const source = `public static class Obj {
    public static string Eval(bool useSeed) {
        (string, int)[] seed = useSeed ? new (string, int)[] { ("seed", 1) } : null;
        var items = seed ?? new (string, int)[] { ("x", 0), ("abc", 2) };
        items[0] = (null, 3);
        return (items[0].Item1 == null ? "null" : items[0].Item1) + ":" + items[0].Item2;
    }
    public static string Run() => Eval(false) + "|" + Eval(true);
}`
        let printed = Translate(source)
        Assert.Contains("[](string?, int32)", printed)
        Assert.DoesNotContain("[](string, int32)", printed)
        AssertParity(source, printed, "null:3|null:3")
    }

    @Fact
    func TupleContainedArrayAlias_PropagatesWriteToSourceArrayAndMatchesRuntime() {
        const source = `public static class Obj {
    public static string Run() {
        var rows = new (string, int)[] { ("x", 0), ("abc", 1) };
        var state = (Rows: rows, Count: 2);
        state.Rows[0] = (null, 4);
        return (rows[0].Item1 == null ? "null" : rows[0].Item1) + ":" + rows[0].Item2 + "," + rows[1].Item1 + ":" + rows[1].Item2;
    }
}`
        let printed = Translate(source)
        Assert.Contains("[](string?, int32)", printed)
        Assert.DoesNotContain("[](string, int32)", printed)
        AssertParity(source, printed, "null:4,abc:1")
    }

    @Fact
    func ArrayElementWithNestedNullableTuple_PassedToFixedTupleParameter_BridgesLeafAndMatchesRuntime() {
        const source = `#nullable enable
public static class FixedNestedTupleConsumer {
    public static string Consume(((string Text, int Code)? Nested, int Id) value) =>
        value.Nested.HasValue ? value.Nested.Value.Text + ":" + value.Nested.Value.Code + ":" + value.Id : "none:" + value.Id;
}
#nullable disable
public static class Obj {
    public static string Run() {
        var items = new ((string Text, int Code)? Nested, int Id)[] {
            (("x", 1), 2),
            (("abc", 3), 4)
        };
        items[0] = ((null, 5), 6);
        return (items[0].Nested.Value.Text == null ? "null" : items[0].Nested.Value.Text) + ":" + items[0].Id + "|" + FixedNestedTupleConsumer.Consume(items[1]);
    }
}`
        let printed = Translate(source)
        Assert.Contains(".Item1!!", printed)
        AssertParity(source, printed, "null:6|abc:3:4")
    }

    @Fact
    func PromotedArrayElementTuple_YieldedFromObliviousIterator_OmitsLeafAssertionAndMatchesRuntime() {
        const source = `using System.Collections.Generic;
public static class Obj {
    private static IEnumerable<(string Text, int Code)> Rows() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 2);
        yield return items[0];
        yield return items[1];
    }
    public static string Run() {
        string output = "";
        foreach (var row in Rows()) {
            output += (row.Text ?? "null") + ":" + row.Code + ",";
        }
        return output;
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain(".Item1!!", printed)
        AssertParity(source, printed, "null:2,abc:1,")
    }

    @Fact
    func PromotedArrayElementTuple_InsideTupleLiteralArgument_OmitsLeafAssertionAndMatchesRuntime() {
        const source = `public static class Obj {
    private static string Consume(((string Text, int Code) Row, int Id) value) =>
        (value.Row.Text ?? "null") + ":" + value.Row.Code + ":" + value.Id;
    public static string Run() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 2);
        return Consume((items[0], 7)) + "|" + Consume((items[1], 8));
    }
}`
        let printed = Translate(source)
        Assert.DoesNotContain(".Item1!!", printed)
        AssertParity(source, printed, "null:2:7|abc:1:8")
    }

    @Fact
    func CoalescedNullableTuple_PassedToFixedTupleParameter_BridgesLeafAndMatchesRuntime() {
        const source = `#nullable enable
public static class FixedCoalesceConsumer {
    public static string Consume((string Text, int Code) value) => value.Text + ":" + value.Code;
}
#nullable disable
public static class Obj {
    public static string Run() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 2);
        (string Text, int Code)? maybe = items[1];
        return (items[0].Text == null ? "null" : items[0].Text) + "|" + FixedCoalesceConsumer.Consume(maybe ?? ("fallback", 9));
    }
}`
        let printed = Translate(source)
        Assert.Contains(".Item1!!", printed)
        AssertParity(source, printed, "null|abc:1")
    }

    @Fact
    func PartiallyGenericFixedTupleParameter_ExplicitTypeArgument_BridgesFixedLeafAndMatchesRuntime() {
        const source = `#nullable enable
public static class PartiallyGenericConsumer {
    public static string Consume<T>((string Text, T Code) value) => value.Text + ":" + value.Code;
}
#nullable disable
public static class Obj {
    public static string Run() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 2);
        return (items[0].Text == null ? "null" : items[0].Text) + "|" + PartiallyGenericConsumer.Consume<int>(items[1]);
    }
}`
        let printed = Translate(source)
        Assert.Contains(".Item1!!", printed)
        AssertParity(source, printed, "null|abc:1")
    }

    @Fact
    func ExternalObliviousTupleParameter_OmitsLeafAssertionAndMatchesRuntime() {
        const librarySource = `namespace ExternalLib {
    public static class ExternalOblivious {
        public static string Accept((string Text, int Code) value) => (value.Text ?? "null") + ":" + value.Code;
    }
}`
        const appSource = `using ExternalLib;
public static class Obj {
    public static string Run() {
        var items = new (string Text, int Code)[] { ("x", 0), ("abc", 1) };
        items[0] = (null, 2);
        return ExternalOblivious.Accept(items[0]) + "|" + ExternalOblivious.Accept(items[1]);
    }
}`
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5901-ext", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let libraryPath = Path.Combine(directory, "ExternalObliviousLib.dll")
            let libraryLoaded = CSharpProjectLoader.LoadInMemory([](string, string){("Lib.cs", librarySource)})
            Assert.True(
                libraryLoaded.BoundWithoutErrors,
                string.Join(Environment.NewLine, libraryLoaded.ErrorDiagnostics)
            )
            let emitResult = libraryLoaded.Compilation.WithAssemblyName("ExternalObliviousLib").Emit(libraryPath)
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            let appBase = CSharpProjectLoader.LoadInMemory([](string, string){("App.cs", appSource)})
            let appCompilation = appBase.Compilation.AddReferences(MetadataReference.CreateFromFile(libraryPath))
            let tree = Assert.Single(appCompilation.SyntaxTrees)
            let model = appCompilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(appCompilation, model, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            Assert.DoesNotContain(".Item1!!", printed)
            using let appStream = MemoryStream()
            let appEmit = appCompilation.Emit(appStream)
            Assert.True(appEmit.Success, string.Join(Environment.NewLine, appEmit.Diagnostics))
            appStream.Position = 0
            let loadContext = AssemblyLoadContext("issue5901-ext-oracle", isCollectible: true)
            var oracle string
            try {
                let _ = loadContext.LoadFromAssemblyPath(libraryPath)
                let assembly = loadContext.LoadFromStream(appStream)
                let method = assembly.GetType("Obj")!!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!!
                oracle = Assert.IsType[string](method.Invoke(nil, nil))
            } finally {
                loadContext.Unload()
            }
            Assert.Equal("null:2|abc:1", oracle)
            let compiler = FindCompiler()
            let input = Path.Combine(directory, "Source.gs")
            let output = Path.Combine(directory, "Source.dll")
            File.WriteAllText(input, printed + Environment.NewLine + "System.Console.WriteLine(Obj.Run())")
            let (compileExit, compileLog) = RunDotnet(
                compiler,
                "/target:exe",
                "/targetframework:net10.0",
                "/reference:" + libraryPath,
                "/out:" + output,
                input
            )
            Assert.True(compileExit == 0, compileLog + Environment.NewLine + printed)
            let (runExit, stdout) = RunDotnet(output)
            Assert.True(runExit == 0, stdout)
            Assert.Equal(Encoding.UTF8.GetBytes(oracle + Environment.NewLine), Encoding.UTF8.GetBytes(stdout))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func SuppressedArrayAllocation_PromotesTupleLeafAndMatchesRuntime() {
        const source = `public static class Obj {
    public static string Run() {
        var items = new (string, int)[] { ("x", 0), ("abc", 1) }!;
        items[0] = (null, 2);
        return (items[0].Item1 == null ? "null" : items[0].Item1) + ":" + items[0].Item2 + "," + items[1].Item1 + ":" + items[1].Item2;
    }
}`
        let printed = Translate(source)
        Assert.Contains("[](string?, int32)", printed)
        Assert.DoesNotContain("[](string, int32)", printed)
        AssertParity(source, printed, "null:2,abc:1")
    }

    @Fact
    func NullableTupleContainingArray_InitializerAndReplacement_PromoteAllocationsAndMatchRuntime() {
        const source = `public static class Obj {
    public static string Run() {
        var rows = new (string, int)[] { ("x", 0), ("abc", 1) };
        rows[0] = (null, 2);
        ((string, int)[] Rows, int Id)? state = (new (string, int)[] { ("init", 1) }, 1);
        state = (rows, 2);
        string first = (state.Value.Rows[0].Item1 == null ? "null" : state.Value.Rows[0].Item1) + ":" + state.Value.Id;
        state = (new (string, int)[] { ("ok", 3) }, 4);
        return first + "|" + state.Value.Rows[0].Item1 + ":" + state.Value.Rows[0].Item2 + ":" + state.Value.Id;
    }
}`
        let printed = Translate(source)
        Assert.Contains("[](string?, int32)", printed)
        Assert.DoesNotContain("[](string, int32)", printed)
        AssertParity(source, printed, "null:2|ok:3:4")
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
            let context = AssemblyLoadContext("issue5901-oracle", isCollectible: true)
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
            let directory = Path.Combine(AppContext.BaseDirectory, "issue5901", Guid.NewGuid().ToString("N"))
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
