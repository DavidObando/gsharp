// <copyright file="Issue4718IteratorTupleElementPromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

class Issue4718IteratorTupleElementPromotionTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func NonTupleGenericMapping_DoesNotComputeTupleGraph(explicitType bool) {
        let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Types.cs", `using System.Collections.Generic;
public class Types {
    public List<string> Plain;
    public List<(string Text, int Code)> Tuple;
}`)})
        let model = loaded.Compilation.GetSemanticModel(Assert.Single(loaded.Compilation.SyntaxTrees))
        let context = TranslationContext(loaded.Compilation, model, "Types.cs")
        let owner = Assert.IsAssignableFrom[INamedTypeSymbol](loaded.Compilation.GetTypeByMetadataName("Types"))
        let analyzer = Assert.IsAssignableFrom[Type](
            typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer")
        )
        let field = Assert.IsAssignableFrom[FieldInfo](
            analyzer.GetField("Cache", BindingFlags.Static | BindingFlags.NonPublic)
        )
        let cache = Assert.IsAssignableFrom[object](field.GetValue(nil))
        let tryGet = Assert.IsAssignableFrom[MethodInfo](cache.GetType().GetMethod("TryGetValue"))
        Assert.Equal(false, tryGet.Invoke(cache, []object? {loaded.Compilation, nil}))
        let mapper = CSharpTypeMapper()
        let plain = Assert.IsAssignableFrom[IFieldSymbol](Assert.Single(owner.GetMembers("Plain"))).Type
        let mapped = if explicitType {
            mapper.MapExplicitType(plain, context, Microsoft.CodeAnalysis.Location.None)!!
        } else {
            mapper.Map(plain, context, Microsoft.CodeAnalysis.Location.None)!!
        }
        Assert.Single(Assert.IsType[NamedTypeReference](mapped).TypeArguments)
        Assert.Equal(false, tryGet.Invoke(cache, []object? {loaded.Compilation, nil}))
        let tuple = Assert.IsAssignableFrom[IFieldSymbol](Assert.Single(owner.GetMembers("Tuple"))).Type
        let _ = if explicitType {
            mapper.MapExplicitType(tuple, context, Microsoft.CodeAnalysis.Location.None)!!
        } else {
            mapper.Map(tuple, context, Microsoft.CodeAnalysis.Location.None)!!
        }
        Assert.Equal(true, tryGet.Invoke(cache, []object? {loaded.Compilation, nil}))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructedGenericDelegateTupleContracts_SynchronizeNominalMappingPaths(nullBearing bool) {
        let body = if nullBearing {
            "return (text, 1);"
        } else {
            "return (\"present\", 2);"
        }
        let printed = Translate((`public delegate T Factory<T>();
public static class Obj {
    public static Factory<(string Text, int Code)> Field = Missing;
    public static event Factory<(string Text, int Code)> Produced;
    public static (string Text, int Code) Missing() {
        string text = null;
        ` + "$body" + `
    }
    public static void Use() {
        Factory<(string Text, int Code)> local = Missing;
        Factory<(string Text, int Code)> converted = (Factory<(string Text, int Code)>)local;
        Produced += Missing;
    }
}`))
        let tuple = "(Text ${(if nullBearing { "string?" } else { "string" })}, Code int32)"
        Assert.Contains("func Missing() " + tuple, printed)
        Assert.Contains("Field Factory[" + tuple + "]", printed)
        Assert.Contains("Produced Factory[" + tuple + "]", printed)
        Assert.Contains("local Factory[" + tuple + "]", printed)
        Assert.True(printed.Contains("cast[Factory[" + tuple + "]](local)", StringComparison.Ordinal), printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("IEnumerable", "", "sequence", true)
    @InlineData("IEnumerable", "", "sequence", false)
    @InlineData("IEnumerator", "", "IEnumerator", true)
    @InlineData("IEnumerator", "", "IEnumerator", false)
    @InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable", true)
    @InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable", false)
    @InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator", true)
    @InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator", false)
    func NominalDelegateIteratorContracts_SynchronizeNestedTupleSlots(
        envelope string,
        modifier string,
        mappedEnvelope string,
        nullBearing bool
    ) {
        let body = if nullBearing {
            "yield return (text, 1);"
        } else {
            "if (text != null) { yield return (text, 1); }"
        }
        let printed = Translate((`using System.Collections.Generic;
public delegate ` + "$envelope" + `<T> Factory<T>();
public static class Obj {
    public static Factory<(string Text, int Code)> Field = Rows;
    public static event Factory<(string Text, int Code)> Produced;
    public static ` + "$modifier" + "$envelope" + `<(string Text, int Code)> Rows() {
        string text = null;
        ` + "$body" + `
    }
    public static void Use() {
        Factory<(string Text, int Code)> local = Rows;
        Factory<(string Text, int Code)> converted = (Factory<(string Text, int Code)>)local;
        Produced += Rows;
    }
}`))
        let tuple = "(Text ${(if nullBearing { "string?" } else { "string" })}, Code int32)"
        Assert.Contains("func Rows() " + mappedEnvelope + "[" + tuple + "]", printed)
        Assert.Contains("Field Factory[" + tuple + "]", printed)
        Assert.Contains("Produced Factory[" + tuple + "]", printed)
        Assert.Contains("local Factory[" + tuple + "]", printed)
        Assert.Contains("cast[Factory[" + tuple + "]](local)", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("IEnumerable", "", "sequence")
    @InlineData("IEnumerator", "", "IEnumerator")
    @InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable")
    @InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator")
    func ConditionalTupleYield_PromotesOnlyNullBearingElement(envelope string, modifier string, mappedEnvelope string) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static ` + "$modifier" + "$envelope" + `<(string Text, int Code)> TupleRows(bool choose) {
        string text = null;
        yield return choose ? (text, 1) : ("x", 2);
    }
}`))
        Assert.Contains("func TupleRows(choose bool) $mappedEnvelope[(Text string?, Code int32)]", printed)
        Assert.Contains("let text string? = nil", printed)
        Assert.DoesNotContain("text!!", printed)
    }

    @Theory
    @InlineData("IEnumerable", "", true, false)
    @InlineData("IEnumerator", "", true, false)
    @InlineData("IAsyncEnumerable", "async ", true, false)
    @InlineData("IAsyncEnumerator", "async ", true, false)
    @InlineData("IEnumerable", "", false, false)
    @InlineData("IEnumerator", "", false, false)
    @InlineData("IAsyncEnumerable", "async ", false, false)
    @InlineData("IAsyncEnumerator", "async ", false, false)
    @InlineData("IEnumerable", "", true, true)
    @InlineData("IEnumerator", "", true, true)
    @InlineData("IAsyncEnumerable", "async ", true, true)
    @InlineData("IAsyncEnumerator", "async ", true, true)
    @InlineData("IEnumerable", "", false, true)
    @InlineData("IEnumerator", "", false, true)
    @InlineData("IAsyncEnumerable", "async ", false, true)
    @InlineData("IAsyncEnumerator", "async ", false, true)
    func IteratorTupleContracts_SynchronizeInterfacesOverridesAndSiblingImplementations(
        envelope string,
        modifier string,
        interfaceContract bool,
        guarded bool
    ) {
        let yielded = "yield return choose ? ((choose ? text : \"x\", \"keep\"), 1) : ((\"x\", \"keep\"), 2);"
        let row = if envelope.EndsWith("Enumerator", StringComparison.Ordinal) {
            "rows.Current"
        } else {
            "row"
        }
        let read = if guarded {
            "result += $row.Names.Text.Length;"
        } else {
            "if ($row.Names.Text == null) { result++; }"
        }
        let scan = switch envelope {
            case "IEnumerable": "foreach (var row in source.Rows(choose)) { $read }"
            case "IEnumerator": "var rows = source.Rows(choose); while (rows.MoveNext()) { $read }"
            case "IAsyncEnumerable": "await foreach (var row in source.Rows(choose)) { $read }"
            default: "var rows = source.Rows(choose); while (await rows.MoveNextAsync()) { $read }"
        }
        let returnType = if modifier.Length == 0 {
            "int"
        } else {
            "System.Threading.Tasks.Task<int>"
        }
        let contract = if interfaceContract {
            (`public interface IRows {
    ` + "$envelope" + `<((string Text, string Keep) Names, int Code)> Rows(bool choose);
}`)
        } else {
            (`public abstract class RowsBase {
    public abstract ` + "$envelope" + `<((string Text, string Keep) Names, int Code)> Rows(bool choose);
}`)
        }
        let contractType = if interfaceContract {
            "IRows"
        } else {
            "RowsBase"
        }
        let implementationModifier = if interfaceContract {
            modifier
        } else {
            "override " + modifier
        }
        let printed = Translate((`using System.Collections.Generic;
` + "$contract" + `
public sealed class MissingRows : ` + "$contractType" + ` {
    public ` + "$implementationModifier" + "$envelope" + `<((string Text, string Keep) Names, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ` + "${(if guarded { "if (text != null) { " + yielded + " }" } else { yielded })}" + `
    }
}
public sealed class PresentRows : ` + "$contractType" + ` {
    public ` + "$implementationModifier" + "$envelope" + `<((string Text, string Keep) Names, int Code)> Rows(bool choose) {
        yield return (("present", "keep"), 3);
    }
}
public static class Consumer {
    public static ` + "$modifier" + "$returnType" + ` Read(` + "$contractType" + ` source, bool choose) {
        int result = 0;
        ` + "$scan" + `
        return result;
    }
}`))
        TranslationTestValidation.AssertBinds(printed)
        let signatures = printed
            .Split(Environment.NewLine)
            .Where((line string) -> line.Contains("func Rows(", StringComparison.Ordinal))
            .ToArray()
        Assert.Equal(3, signatures.Length)
        let textType = if guarded {
            "string"
        } else {
            "string?"
        }
        Assert.All(
            signatures,
            (signature string) -> Assert.Contains("(Names (Text $textType, Keep string), Code int32)", signature)
        )
        Assert.DoesNotContain("Keep string?", printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedTupleReturnContracts_OnlyEquivalentShapesSharePositionalTaint(reordered bool) {
        let library = CSharpProjectLoader.LoadInMemory([](string, string){("Library.cs", `#nullable enable
namespace Contract4718;
public class Carrier<X, Y> { }
public class Reordered<X, Y> : Carrier<Y, X> { }
public abstract class RowsBase {
    public abstract Carrier<(string? Text, int Code), (string Keep, int Code)> Rows();
}`)}, assemblyName: "Contract4718")
        using let image = MemoryStream()
        let emitted = library.Compilation.Emit(image)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let bytes = image.ToArray()
        let returnType = if reordered {
            "Reordered<(string Keep, int Code), (string Text, int Code)>"
        } else {
            "Carrier<(string Text, int Code), (string Keep, int Code)>"
        }
        // #4729 tracks imported constructors; isolate the contract-shape oracle.
        let printed = Translate((`using Contract4718;
public sealed class Producer : RowsBase {
    public override ` + "$returnType" + ` Rows() {
        throw new System.NotImplementedException();
    }
}`), CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(bytes)).ToArray())
        let expected = if reordered {
            "Reordered[(Keep string, Code int32), (Text string, Code int32)]"
        } else {
            "Carrier[(Text string?, Code int32), (Keep string, Code int32)]"
        }
        Assert.Contains("override func Rows() " + expected, printed)
        let directory = Path.Combine(".local", "issue4718-import-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let referencePath = Path.Combine(directory, "Contract4718.dll")
            File.WriteAllBytes(referencePath, bytes)
            using let resolver = ReferenceResolver.WithRuntimeReferences([]string{referencePath})
            TranslationTestValidation.AssertBinds(resolver, printed)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("IEnumerable", "", true)
    @InlineData("IEnumerable", "", false)
    @InlineData("IAsyncEnumerable", "async ", true)
    @InlineData("IAsyncEnumerable", "async ", false)
    func GenericIteratorContracts_UseTypeParameterOrdinals(envelope string, modifier string, interfaceContract bool) {
        let contract = if interfaceContract {
            "public interface IRows { $envelope<(string Text, T Value)> Rows<T>(T value, bool choose); }"
        } else {
            "public abstract class RowsBase { public abstract $envelope<(string Text, T Value)> Rows<T>(T value, bool choose); }"
        }
        let owner = if interfaceContract {
            "IRows"
        } else {
            "RowsBase"
        }
        let implementationModifier = if interfaceContract {
            modifier
        } else {
            "override " + modifier
        }
        let printed = Translate((`using System.Collections.Generic;
` + "$contract" + `
public sealed class MissingRows : ` + "$owner" + ` {
    public ` + "$implementationModifier" + "$envelope" + `<(string Text, U Value)> Rows<U>(U value, bool choose) {
        string text = null;
        yield return choose ? (text, value) : ("x", value);
    }
}
public sealed class PresentRows : ` + "$owner" + ` {
    public ` + "$implementationModifier" + "$envelope" + `<(string Text, V Value)> Rows<V>(V value, bool choose) {
        yield return ("x", value);
    }
}`))
        Assert.Contains("(Text string?, Value T)", printed)
        Assert.Contains("(Text string?, Value U)", printed)
        Assert.Contains("(Text string?, Value V)", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("if (text != null) { text = null; yield return (text, 1); }", true)
    @InlineData("if (text == null) { throw new System.Exception(); } text = null; yield return (text, 1);", true)
    @InlineData("if (text != null) { Reset(ref text); yield return (text, 1); }", true)
    @InlineData("if (text != null) { (text, choose) = (null, true); yield return (text, 1); }", true)
    @InlineData("if (text != null) { for (int i = 0; i < 2; i++) { yield return (text, i); text = null; } }", true)
    @InlineData(
        "if (text != null) { text = choose ? null : \"fresh\"; if (text != null) { yield return (text, 1); } }",
        false
    )
    @InlineData("if (text != null) { choose = false; yield return (text, 1); }", false)
    func TupleYieldGuards_RequireAnUnchangedValue(body string, nullable bool) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ` + "$body" + `
    }
    private static void Reset(ref string value) { value = null; }
}`))
        let textType = if nullable {
            "string?"
        } else {
            "string"
        }
        Assert.Contains("func Rows(choose bool) sequence[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RefAliasEscape_InvalidatesTupleYieldGuard(beforeGuard bool) {
        let alias = "ref string alias = ref text;"
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ` + "${(if beforeGuard { alias } else { string.Empty })}" + `
        if (text != null) {
            ` + "${(if beforeGuard { string.Empty } else { alias })}" + `
            alias = null;
            yield return (text, 1);
        }
    }
}`))
        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed)
        // #4726 tracks the independent ref-alias storage/smart-cast bind failure.

    }

    @Theory
    @InlineData("alias = null;")
    @InlineData("Reset(ref alias);")
    func NullableRefAliasBeforeGuard_InvalidatesTupleYieldProof(mutation string) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ref string? alias = ref text;
        if (text != null) {
            ` + "$mutation" + `
            yield return (text, 1);
        }
    }
    private static void Reset(ref string? value) { value = null; }
}`))
        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("(text)", false)
    @InlineData("text!", false)
    @InlineData("(text!)", false)
    @InlineData("(text)", true)
    @InlineData("text!", true)
    @InlineData("(text!)", true)
    func WrappedRefStorage_UsesCentralWriteProof(target string, readOnly bool) {
        let modifier = if readOnly {
            "readonly "
        } else {
            string.Empty
        }
        let mutation = if readOnly {
            "_ = alias;"
        } else {
            "alias = null;"
        }
        let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Wrapped.cs", (`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ref ` + "$modifier" + `string? alias = ref ` + "$target" + `;
        if (text != null) {
            ` + "$mutation" + `
            yield return (text, 1);
        }
    }
}`))})
        Assert.True(loaded.BoundWithoutErrors, string.Join(Environment.NewLine, loaded.ErrorDiagnostics))
        let document = Assert.Single(loaded.Documents)
        let context = TranslationContext(loaded.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        let unsupported = Assert.Single(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("RefExpression", unsupported.ToString())
        let textType = if readOnly {
            "string"
        } else {
            "string?"
        }
        Assert.Contains("func Rows(choose bool) sequence[(Text $textType, Code int32)]", printed)
        // Wrapped ref lowering already fails loudly; its diagnostic is unchanged.

    }

    @Fact
    func ReadOnlyRefAliasBeforeGuard_PreservesTupleYieldProof() {
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ref readonly string? alias = ref text;
        if (text != null) {
            _ = alias;
            yield return (text, 1);
        }
    }
}`)
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("Borrow(ref text)")
    @InlineData("Forward(ref text)")
    func RefReturningCallBeforeGuard_InvalidatesTupleYieldProof(borrow string) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ref string? alias = ref ` + "$borrow" + `;
        if (text != null) {
            alias = null;
            yield return (text, 1);
        }
    }
    private static ref string? Borrow(ref string? value) { return ref value; }
    private static ref string? Forward(ref string? value) { return ref Borrow(ref value); }
}`))
        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func BackwardGoto_DoesNotReuseTupleYieldGuard() {
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        int count = 0;
        if (text != null) {
            Again:
            yield return (text, count);
            text = null;
            if (++count < 2) { goto Again; }
        }
    }
}`)
        Assert.Contains("func Rows(choose bool) sequence[(Text string?, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("IEnumerable", false, false)
    @InlineData("IEnumerable", false, true)
    @InlineData("IEnumerable", true, false)
    @InlineData("IEnumerable", true, true)
    @InlineData("IEnumerator", false, false)
    @InlineData("IEnumerator", false, true)
    @InlineData("IEnumerator", true, false)
    @InlineData("IEnumerator", true, true)
    func IteratorGetters_CollectOwnTupleYields(envelope string, indexer bool, guarded bool) {
        let member = if indexer {
            "this[bool choose]"
        } else {
            "Rows"
        }
        let choose = if indexer {
            "choose"
        } else {
            "Choose"
        }
        let initializer = "$choose ? null : \"x\""
        let yield = if guarded {
            "if (text != null) { yield return (text, 1); }"
        } else {
            "yield return $choose ? (text, 1) : (\"x\", 2);"
        }
        let printed = Translate((`using System.Collections.Generic;
public sealed class Obj {
    public bool Choose;
    public ` + "$envelope" + `<(string Text, int Code)> ` + "$member" + ` {
        get {
            string text = ` + "$initializer" + `;
            ` + "$yield" + `
        }
    }
}`))
        let textType = if guarded {
            "string"
        } else {
            "string?"
        }
        Assert.Contains("$envelope[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(true, false)
    @InlineData(false, false)
    @InlineData(true, true)
    @InlineData(false, true)
    func IteratorGetterContracts_SynchronizeNullableTupleSlots(interfaceContract bool, indexer bool) {
        let member = if indexer {
            "this[bool choose]"
        } else {
            "Rows"
        }
        let contract = if interfaceContract {
            "public interface IRows { IEnumerable<(string Text, int Code)> $member { get; } }"
        } else {
            "public abstract class RowsBase { public abstract IEnumerable<(string Text, int Code)> $member { get; } }"
        }
        let owner = if interfaceContract {
            "IRows"
        } else {
            "RowsBase"
        }
        let modifier = if interfaceContract {
            string.Empty
        } else {
            "override "
        }
        let printed = Translate((`using System.Collections.Generic;
` + "$contract" + `
public sealed class MissingRows : ` + "$owner" + ` {
    public ` + "$modifier" + `IEnumerable<(string Text, int Code)> ` + "$member" + ` {
        get { string text = null; yield return (text, 1); }
    }
}
public sealed class PresentRows : ` + "$owner" + ` {
    public ` + "$modifier" + `IEnumerable<(string Text, int Code)> ` + "$member" + ` {
        get { yield return ("x", 1); }
    }
}`))
        Assert.Equal(3, printed.Split("IEnumerable[(Text string?, Code int32)]").Length - 1)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func LocalIteratorGoto_InvalidatesOnlyItsOwnGuard(ownJump bool) {
        let iteratorJump = if ownJump {
            "if (++count < 2) { goto Again; }"
        } else {
            string.Empty
        }
        let unrelatedJump = if ownJump {
            string.Empty
        } else {
            "goto Done; Done: return 0;"
        }
        let printed = Translate((`using System.Collections.Generic;
Obj.Rows(false);
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        IEnumerable<(string Text, int Code)> Inner() {
            string text = choose ? null : "x";
            int count = 0;
            if (text != null) {
                Again:
                yield return (text, count);
                text = null;
                ` + "$iteratorJump" + `
            }
        }
        int Sibling() { ` + "$unrelatedJump" + ` return 1; }
        return Inner();
    }
}`), outputKind: OutputKind.ConsoleApplication)
        let textType = if ownJump {
            "string?"
        } else {
            "string"
        }
        Assert.Contains("func Rows(choose bool) IEnumerable[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func IteratorGetterForwarding_ReusesDeclarationPathsAndYieldOwnership() {
        let printed = Translate(`using System.Collections.Generic;
public sealed class Obj {
    public IEnumerable<((string Text, string Keep) Names, int Code)> Missing {
        get {
            string text = null;
            yield return ((text, "keep"), 1);
        }
    }
    public IEnumerable<((string Text, string Keep) Names, int Code)> Arrow => Missing;
    public IEnumerable<((string Text, string Keep) Names, int Code)> Block {
        get { return Missing; }
    }
    public IEnumerable<(string Text, int Code)> Present {
        get {
            IEnumerable<(string Text, int Code)> Inner() {
                string text = null;
                yield return (text, 1);
            }
            yield return ("x", 1);
        }
    }
}`)
        Assert.Equal(3, printed.Split("IEnumerable[(Names (Text string?, Keep string), Code int32)]").Length - 1)
        Assert.Contains("Present IEnumerable[(Text string, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CapturedIteratorStorage_AccountsForEnclosingWritesAcrossResumption(mutates bool) {
        let mutation = if mutates {
            "text = null;"
        } else {
            string.Empty
        }
        let result = if mutates {
            "rows.Current.Text == null ? 1 : -2"
        } else {
            "rows.Current.Text.Length"
        }
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static int Run(bool choose) {
        string text = choose ? null : "x";
        IEnumerable<(string Text, int Code)> Rows() {
            if (text != null) {
                yield return (text, 1);
                yield return (text, 2);
            }
        }
        var rows = Rows().GetEnumerator();
        if (!rows.MoveNext()) { return -1; }
        ` + "$mutation" + `
        if (!rows.MoveNext()) { return -3; }
        return ` + "$result" + `;
    }
}`))
        let textType = if mutates {
            "string?"
        } else {
            "string"
        }
        Assert.Contains("IEnumerable[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
        let execution = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run(false)")
        Assert.False(
            execution.Diagnostics.Any((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError),
            string.Join(Environment.NewLine, execution.Diagnostics) + Environment.NewLine + printed
        )
        Assert.Null(execution.UnhandledException)
        Assert.Equal(1, execution.Value)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedConstructedIteratorContracts_MapOwnArgumentsSeparately(guarded bool) {
        let body = if guarded {
            "if (text != null) { yield return (text, 1); }"
        } else {
            "yield return (text, 1);"
        }
        let source = (`using System.Collections.Generic;
public class Outer<T> {
    public interface IRows<U> { IEnumerable<U> Rows(); }
}
public sealed class MissingRows : Outer<int>.IRows<(string Text, int Code)> {
    public IEnumerable<(string Text, int Code)> Rows() {
        string text = null;
        ` + "$body" + `
    }
}
public static class Consumer {
    public static Outer<int>.IRows<(string Text, int Code)> Carry(
        Outer<int>.IRows<(string Text, int Code)> value) {
        return value;
    }
}`)
        let loaded = CSharpProjectLoader.LoadInMemory([](string, source string){("Nested.cs", source)})
        let implementation = Assert.IsAssignableFrom[INamedTypeSymbol](
            loaded.Compilation.GetTypeByMetadataName("MissingRows")
        )
        let nested = Assert.Single(implementation.AllInterfaces)
        Assert.Equal(1, nested.Arity)
        Assert.Single(nested.TypeArguments)
        Assert.Single(nested.ContainingType.TypeArguments)
        let printed = Translate(source)
        let textType = if guarded {
            "string"
        } else {
            "string?"
        }
        Assert.Equal(3, printed.Split("Outer[int32].IRows[(Text $textType, Code int32)]").Length - 1)
        Assert.Contains("sequence[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ConstructedInheritedContracts_ProjectParametersEmbeddedInsideTuples(interfaceContract bool, guarded bool) {
        let declaration = if interfaceContract {
            "public interface IAlias<X> : IRows<(X Value, int Code)> { }"
        } else {
            "public abstract class IAlias<X> : IRows<(X Value, int Code)> { public abstract IEnumerable<(X Value, int Code)> Rows(); }"
        }
        let modifier = if interfaceContract {
            string.Empty
        } else {
            "override "
        }
        let body = if guarded {
            "if (text != null) { yield return ((text, 1), 2); }"
        } else {
            "yield return ((text, 1), 2);"
        }
        let printed = Translate((`using System.Collections.Generic;
public interface IRows<T> { IEnumerable<T> Rows(); }
` + "$declaration" + `
public sealed class MissingRows : IAlias<(string Text, int Id)> {
    public ` + "$modifier" + `IEnumerable<((string Text, int Id) Value, int Code)> Rows() {
        string text = null;
        ` + "$body" + `
    }
}
public static class Consumer {
    public static IEnumerable<((string Text, int Id) Value, int Code)> Copy(
        IAlias<(string Text, int Id)> source) {
        return source.Rows();
    }
}`))
        let textType = if guarded {
            "string"
        } else {
            "string?"
        }
        Assert.Equal(2, printed.Split("IAlias[(Text $textType, Id int32)]").Length - 1)
        Assert.Contains("IRows[(Value X, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ConstructedIteratorContracts_SynchronizeTypeArgumentsAndUses(interfaceContract bool, guarded bool) {
        let declaration = if interfaceContract {
            "public interface IRows<T> { IEnumerable<T> Rows(); }"
        } else {
            "public abstract class IRows<T> { public abstract IEnumerable<T> Rows(); }"
        }
        let modifier = if interfaceContract {
            string.Empty
        } else {
            "override "
        }
        let yield = if guarded {
            "if (text != null) { yield return (text, 1); }"
        } else {
            "yield return (text, 1);"
        }
        let printed = Translate((`using System.Collections.Generic;
` + "$declaration" + `
public sealed class MissingRows : IRows<(string Text, int Code)> {
    public ` + "$modifier" + `IEnumerable<(string Text, int Code)> Rows() {
        string text = null;
        ` + "$yield" + `
    }
}
public sealed class PresentRows : IRows<(string Text, int Code)> {
    public ` + "$modifier" + `IEnumerable<(string Text, int Code)> Rows() {
        yield return ("x", 1);
    }
}
public sealed class OtherRows : IRows<(string Text, long Code)> {
    public ` + "$modifier" + `IEnumerable<(string Text, long Code)> Rows() {
        yield return ("x", 1L);
    }
}
public static class Consumer {
    public static IRows<(string Text, int Code)> Carry(IRows<(string Text, int Code)> value) {
        IRows<(string Text, int Code)> rows = Identity<IRows<(string Text, int Code)>>(
            (IRows<(string Text, int Code)>)value);
        return rows;
    }
    public static IRows<(string Label, int Number)> Alias(IRows<(string Label, int Number)> value) {
        return value;
    }
    private static T Identity<T>(T value) { return value; }
}`))
        let textType = if guarded {
            "string"
        } else {
            "string?"
        }
        Assert.Equal(6, printed.Split("IRows[(Text $textType, Code int32)]").Length - 1)
        Assert.Equal(2, printed.Split("IRows[(Label $textType, Number int32)]").Length - 1)
        Assert.Contains("IRows[(Text string, Code int64)]", printed)
        Assert.Contains("sequence[(Text string, Code int64)]", printed)
        Assert.Equal(2, printed.Split("sequence[(Text $textType, Code int32)]").Length - 1)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ConstructedInheritedContracts_ProjectReorderedNestedTupleArguments(interfaceContract bool) {
        let declaration = if interfaceContract {
            "public interface IAlias<X, Y> : IRows<Y, X> { }"
        } else {
            "public abstract class IAlias<X, Y> : IRows<Y, X> { public abstract IEnumerable<(X Value, int Code)> Rows(); }"
        }
        let modifier = if interfaceContract {
            string.Empty
        } else {
            "override "
        }
        let printed = Translate((`using System.Collections.Generic;
public interface IRows<A, T> { IEnumerable<(T Value, int Code)> Rows(); }
` + "$declaration" + `
public sealed class MissingRows : IAlias<(string Text, int Id), int> {
    public ` + "$modifier" + `IEnumerable<((string Text, int Id) Value, int Code)> Rows() {
        string text = null;
        yield return ((text, 1), 2);
    }
}
public static class Consumer {
    public static IEnumerable<((string Text, int Id) Value, int Code)> Copy(
        IAlias<(string Text, int Id), int> source) {
        var values = source.Rows();
        return values;
    }
}`))
        Assert.Equal(2, printed.Split("IAlias[(Text string?, Id int32), int32]").Length - 1)
        Assert.Contains("IEnumerable[(Value (Text string?, Id int32), Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ConstructedContractReferences_UseSiblingTupleEvidence(nullableConsumer bool, siblingContract bool) {
        let producer = CSharpProjectLoader.LoadInMemory([](string, string){("Producer.cs", `using System.Collections.Generic;
public interface IRows<T> { IEnumerable<T> Rows(); }
public sealed class MissingRows : IRows<(string Text, int Code)> {
    public IEnumerable<(string Text, int Code)> Rows() {
        string text = null;
        yield return (text, 1);
    }
}`)}).Compilation.WithAssemblyName("ConstructedProducer")
        using let image = MemoryStream()
        let emitted = producer.Emit(image)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let ownContract = if siblingContract {
            string.Empty
        } else {
            "public interface IRows<T> { }"
        }
        let loaded = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", ("" + "$ownContract" + `
public static class Consumer {
    public static IRows<(string Label, int Number)> Carry(IRows<(string Label, int Number)> value) {
        return value;
    }
}`))}, CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(image.ToArray())).ToArray())
        let consumer = loaded
            .Compilation
            .WithAssemblyName("ConstructedConsumer")
            .WithOptions(
            loaded
                .Compilation
                .Options
                .WithNullableContextOptions(
                if nullableConsumer {
                    NullableContextOptions.Enable
                } else {
                    NullableContextOptions.Disable
                }
            )
        )
        let printed = List[string]()
        for compilation in[]CSharpCompilation{producer, consumer} {
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Severity == Microsoft
                    .CodeAnalysis
                    .DiagnosticSeverity
                    .Error
            )
            let tree = Assert.Single(compilation.SyntaxTrees)
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(compilation, model, tree.FilePath, []CSharpCompilation{producer, consumer})
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            printed.Add(GSharpPrinter.Print(unit))
        }
        // Enabled callers own a fixed non-null construction, not the producer's oblivious tuple argument.
        let textType = if siblingContract && !nullableConsumer {
            "string?"
        } else {
            "string"
        }
        Assert.True(
            printed[1].Split("IRows[(Label $textType, Number int32)]").Length - 1 == 2,
            string.Join(Environment.NewLine, printed)
        )
        TranslationTestValidation.AssertBinds(
            if siblingContract {
                string.Join(Environment.NewLine, printed)
            } else {
                printed[1]
            }
        )
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func PositionalRecordTupleContracts_UsePrimaryParameterEvidence(envelope bool, nullable bool) {
        let valueType = if envelope {
            "IEnumerable<(string Text, int Code)>"
        } else {
            "(string Text, int Code)"
        }
        let initializer = if nullable {
            "null"
        } else {
            "\"x\""
        }
        let argument = if envelope {
            "Rows()"
        } else {
            "(text, 1)"
        }
        let printed = Translate((`using System.Collections.Generic;
public interface IRow { ` + "$valueType" + ` Value { get; } }
public record Row(` + "$valueType" + ` Value) : IRow;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows() {
        string text = ` + "$initializer" + `;
        yield return true ? (text, 1) : ("x", 2);
    }
    public static IRow Create() {
        string text = ` + "$initializer" + `;
        return new Row(` + "$argument" + `);
    }
}`))
        let declarations = printed
            .Split(Environment.NewLine)
            .Where(
            (line string) -> line.Contains("Value", StringComparison.Ordinal) && line.Contains(
                "(Text ",
                StringComparison.Ordinal
            )
        )
            .ToArray()
        Assert.Equal(2, declarations.Length)
        let textType = if nullable {
            "string?"
        } else {
            "string"
        }
        Assert.All(declarations, (declaration string) -> Assert.Contains("(Text $textType, Code int32)", declaration))
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("void Reset() { text = null; }", "Reset();", true)
    @InlineData("System.Action reset = () => text = null;", "reset();", true)
    @InlineData("void Clear() { text = null; } void Reset() { Clear(); }", "Reset();", true)
    @InlineData("void Clear() { text = null; } System.Action reset = Clear;", "reset();", true)
    @InlineData("void Observe() { choose = false; }", "Observe();", false)
    @InlineData("System.Action observe = () => choose = false;", "observe();", false)
    func CapturedWrites_DoNotEstablishStableTupleYieldGuards(declaration string, invocation string, nullable bool) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        ` + "$declaration" + `
        if (text != null) {
            ` + "$invocation" + `
            yield return (text, 1);
        }
    }
}`))
        let textType = if nullable {
            "string?"
        } else {
            "string"
        }
        Assert.Contains("func Rows(choose bool) sequence[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("in ")
    @InlineData("")
    func ReadOnlyInArgument_PreservesTupleYieldGuard(argumentModifier string) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        if (text != null) {
            Observe(` + "$argumentModifier" + `text);
            yield return (text, 1);
        }
    }
    private static void Observe(in string value) { }
}`))
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("void Reset() { text = null; }", "Reset();", true)
    @InlineData("System.Action reset = () => text = null;", "reset();", true)
    @InlineData("void Observe() { }", "Observe();", false)
    func TopLevelCapturedStorage_UsesTheWholeDeclaringScope(declaration string, invocation string, nullable bool) {
        let printed = Translate((`using System.Collections.Generic;
string text = args.Length == 0 ? null : "x";
` + "$declaration" + `
IEnumerable<(string Text, int Code)> Rows() {
    if (text != null) {
        ` + "$invocation" + `
        yield return (text, 1);
    }
}
foreach (var row in Rows()) { }`), outputKind: OutputKind.ConsoleApplication)
        let textType = if nullable {
            "string?"
        } else {
            "string"
        }
        Assert.Contains("let Rows = func () IEnumerable[(Text $textType, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func NestedSwitchTupleYield_UsesTheSameElementPathsAsForwardedCollection() {
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<((string Text, string Keep) Names, int Code)> NestedRows(bool choose) {
        string text = null;
        yield return choose switch {
            true => ((text, "keep"), 1),
            false => (("x", "keep"), 2)
        };
    }

    public static IEnumerable<((string Text, string Keep) Names, int Code)> Forward(bool choose) {
        return NestedRows(choose);
    }
}`)
        Assert.Contains(
            "func NestedRows(choose bool) sequence[(Names (Text string?, Keep string), Code int32)]",
            printed
        )
        Assert.Contains(
            "func Forward(choose bool) IEnumerable[(Names (Text string?, Keep string), Code int32)]",
            printed
        )
        Assert.DoesNotContain("Keep string?", printed)
        Assert.DoesNotContain("text!!", printed)
    }

    @Fact
    func NestedIteratorAndYieldBreak_DoNotTaintOuterIterator() {
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        IEnumerable<(string Text, int Code)> Missing() {
            string text = null;
            yield return choose ? (text, 1) : ("x", 2);
        }
        if (choose) { yield break; }
        yield return ("keep", 2);
    }
}`)
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        Assert.Contains("let Missing = func () IEnumerable[(Text string?, Code int32)]", printed)
    }

    @Theory
    @InlineData("(text, 1)", "string")
    @InlineData("choose ? (text, 1) : (\"x\", 2)", "string")
    @InlineData("choose switch { true => (text, 1), false => (\"x\", 2) }", "string")
    @InlineData("(choose ? text : \"x\", 1)", "string")
    @InlineData("(choose switch { true => text, false => \"x\" }, 1)", "string?")
    func GuardedTupleYield_DoesNotPromoteItsProvenNonNullLeaf(yielded string, declaredType string) {
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        ` + "$declaredType" + ` text = choose ? null : "x";
        if (text != null) {
            yield return ` + "$yielded" + `;
        }
    }

    public static int Lengths(bool choose) {
        int total = 0;
        foreach (var row in Rows(choose)) {
            total += row.Text.Length;
        }
        return total;
    }
}`))
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func GuardedNestedConditionalTupleYield_StillPromotesTheUnguardedSibling() {
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<((string Text, string Missing) Names, int Code)> Rows(bool choose) {
        string text = choose ? null : "x";
        string missing = null;
        if (text != null) {
            yield return choose ? ((text, missing), 1) : (("x", "keep"), 2);
        }
    }
}`)
        Assert.Contains("func Rows(choose bool) sequence[(Names (Text string, Missing string?), Code int32)]", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ConditionalTupleYield_PreservesNullAndNonNullRuntimeValues() {
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> TupleRows(bool choose) {
        string text = null;
        yield return choose ? (text, 1) : ("x", 2);
    }

    public static int Run() {
        int result = 0;
        foreach (var row in TupleRows(true)) {
            if (row.Text != null || row.Code != 1) { return -1; }
            result += 1;
        }
        foreach (var row in TupleRows(false)) {
            if (row.Text != "x" || row.Code != 2) { return -2; }
            result += 2;
        }
        return result;
    }
}`)
        Assert.Contains("func TupleRows(choose bool) sequence[(Text string?, Code int32)]", printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.False(
            result.Diagnostics.Any((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    shared {
        private func Translate(
            source string,
            references IReadOnlyList[MetadataReference]? = nil,
            outputKind OutputKind = OutputKind.DynamicallyLinkedLibrary
        ) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references,
                outputKind: outputKind
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
