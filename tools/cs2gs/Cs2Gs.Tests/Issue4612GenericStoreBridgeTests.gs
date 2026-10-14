// <copyright file="Issue4612GenericStoreBridgeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Threading.Tasks
import Xunit

/// Issue #4612 (option 1): cs2gs keeps its fail-fast `!!` when a maybe-null
/// value is stored into a type-parameter or array-element slot, and now reports each such site
/// as `CS2GS-GENERIC-STORE-BRIDGE`, so the runtime change is visible at
/// translate time. The generated code is unchanged.
/// @remarks Discrimination witness (ADR-0154): with `ReportStoreBridge` returning
/// before it reports, every test that expects a site fails, and the output
/// assertions still pass, which shows the report does not change the code.
open class Issue4612GenericStoreBridgeTests {
    @Fact
    func InferredMethodTypeParameter_Append_IsReported() {
        let (printed, sites) = Translate(`using System.Linq;

public static class C
{
    public static int Appended(string[] items) =>
        items.Append(Branch("x")).Where(s => s != null).Count();
` + MaybeNullHelper + "\n}")
        Assert.Contains(".Append(Branch(\"x\")!!)", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(TranslationSeverity.Warning, site.Severity)
        Assert.Equal("6:22", Position(site))
        Assert.StartsWith("kind=inferred-method-type-parameter | target=", site.Message, StringComparison.Ordinal)
        Assert.Contains("| result-depends-on-slot=yes | value=Branch(\"x\")", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func ConstructedGenericMember_ListAdd_IsReported() {
        let (printed, sites) = Translate(`using System.Collections.Generic;

public static class C
{
    public static int Added()
    {
        var list = new List<string>();
        list.Add(Branch("x"));
        return list.Count;
    }
` + MaybeNullHelper + "\n}")
        Assert.Contains(".Add(Branch(\"x\")!!)", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal("8:18", Position(site))
        Assert.StartsWith(
            "kind=constructed-generic-member | target=List<string>.Add(string)",
            site.Message,
            StringComparison.Ordinal
        )
        Assert.Contains("| result-depends-on-slot=no |", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func DelegateInvoke_IsReported() {
        let (printed, sites) = Translate(`using System;

public static class C
{
    public static void Called(Action<string> callback) => callback(Branch("x"));
` + MaybeNullHelper + "\n}")
        Assert.Contains("callback(Branch(\"x\")!!)", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.StartsWith(
            "kind=delegate-invoke | target=Action<string>.Invoke(string)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ExplicitTypeArgument_IsReportedWithItsOwnKind() {
        let (printed, sites) = Translate(`public static class C
{
    public static T Identity<T>(T value) => value;

    public static string Explicit() => Identity<string>(Branch("x"));
` + MaybeNullHelper + "\n}")
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.StartsWith("kind=explicit-type-argument | target=", site.Message, StringComparison.Ordinal)
        Assert.Contains("| result-depends-on-slot=yes |", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func ConcreteImportedParameter_KeepsItsBridge_AndIsNotReported() {
        let (printed, sites) = Translate(`public static class C
{
    public static System.Uri Concrete() => new System.Uri(Branch("x"));
` + MaybeNullHelper + "\n}")
        Assert.Contains("Uri(Branch(\"x\")!!)", printed, StringComparison.Ordinal)
        Assert.Empty(sites)
    }

    @Fact
    func IndexerAssignment_IntoTypeParameterSlot_IsReported() {
        let (printed, sites) = Translate(`using System.Collections.Generic;

public static class C
{
    public static int Stored()
    {
        var map = new Dictionary<string, string>();
        map["k"] = Branch("x");
        return map.Count;
    }
` + MaybeNullHelper + "\n}")
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.StartsWith(
            "kind=constructed-generic-member | target=Dictionary<string, string>.this[string]",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func CollectionExpressionElement_IntoAGenericCollection_IsReported() {
        let (printed, sites) = Translate(`#nullable enable
using System.Collections;
using System.Collections.Generic;

public class Bag<T> : IEnumerable<T>
{
    public void Add(T item) { }
    public IEnumerator<T> GetEnumerator() => throw new System.NotImplementedException();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public static class C
{
    public static Bag<string> Make(string? x)
    {
        Bag<string> b = [x];
        return b;
    }
}`)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.StartsWith(
            "kind=collection-expression-element | target=Bag<string> | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ArrayInitializerElement_FilteredByOfType_IsReported() {
        // The #4628 shape: C# stores the null in the array and OfType drops it.
        let (printed, sites) = Translate(`using System.Linq;

public static class C
{
    public static int Kept() => new[] { Branch("x"), Branch("yy") }.OfType<string>().Count();
` + MaybeNullHelper + "\n}")
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        Assert.Equal(2, sites.Count)
        Assert.All(
            sites,
            (site TranslationDiagnostic) -> Assert.StartsWith(
                "kind=array-element | target=string[] | slot-type=string",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.Equal("5:41", Position(sites[0]))
    }

    /// The #4681 shape (Gsharp.Runtime.Channels): C# writes `value!` on an
    /// unconstrained `T` that may hold null. C# erases the operator; the
    /// migrated `value!!` throws for a channel of a nullable reference type.
    @Fact
    func ForgivenUnconstrainedTypeParameterValue_IsReported() {
        let (printed, sites) = Translate(`#nullable enable
using System.Threading.Tasks;

public sealed class Chan<T>
{
    private T? value;

    public ValueTask<T> ReceiveValueAsync() => new ValueTask<T>(this.value!);
}`)
        Assert.Contains("value!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal("8:65", Position(site))
        Assert.StartsWith("kind=forgiven-type-parameter-value | target=", site.Message, StringComparison.Ordinal)
        Assert.Contains("| slot-type=T", site.Message, StringComparison.Ordinal)
        Assert.Contains("| result-depends-on-slot=yes |", site.Message, StringComparison.Ordinal)
        Assert.EndsWith("| value=this.value!", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func ConstructorTupleSlot_ResultDependsOnContainingType() {
        let source = `#nullable enable
public class Box<T>
{
    public Box((T, string) pair) { }
}
public static class C
{
    public static Box<string> Create(string? maybe) => new Box<string>((maybe!, ""));
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "maybe!"), Position(site))
        Assert.StartsWith("kind=forgiven,type-parameter-tuple-element | ", site.Message, StringComparison.Ordinal)
        Assert.Contains(
            "| slot-type=string (NotAnnotated) | result-depends-on-slot=yes |",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ChainedElementAssignments_ReportRetainedBridgeAgainstImmediateGenericStore() {
        let source = `using System.Collections.Generic;
public static class C
{
    public static void Stores(string[] array, List<string> list, Dictionary<int, string> dictionary)
    {
        array[0] = list[0] = dictionary[0] = Maybe();
    }
#nullable enable
    private static string? Maybe() => null;
}`
        let (printed, sites) = Translate(source)
        Assert.Equal(1, printed.Split("!!", StringSplitOptions.None).Length - 1)
        Assert.Contains("dictionary[0] = Maybe()!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "Maybe();"), Position(site))
        Assert.StartsWith(
            "kind=constructed-generic-member | target=Dictionary<int, string>.this[int]",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func DelegateResult_SelectLambdaResult_IsReported() {
        let source = `using System.Linq;

public static class C
{
    public static string[] Mapped(string[] items) => items.Select(item => Branch(item)).ToArray();
` + MaybeNullHelper + "\n}"
        let (printed, sites) = Translate(source)
        Assert.Contains("Branch(item)!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "Branch(item)"), Position(site))
        Assert.StartsWith(
            "kind=delegate-result | target=Func<string, string>.Invoke(string) | slot-type=string (None) | result-depends-on-slot=no",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func DelegateResult_BlockLambdaReturn_IsReported() {
        let source = `using System;

public static class C
{
    public static Func<string> Make() => () => { return Branch("x"); };
` + MaybeNullHelper + "\n}"
        let (printed, sites) = Translate(source)
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(site))
        Assert.StartsWith(
            "kind=delegate-result | target=lambda expression | slot-type=string (None)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func BlockLambdaTupleLeaf_UsesTheDeclaredDelegateContract(isAsync bool) {
        let returnType = if isAsync {
            "System.Threading.Tasks.Task<((T, int), string)>"
        } else {
            "((T, int), string)"
        }
        let asyncModifier = if isAsync {
            "async "
        } else {
            string.Empty
        }
        let awaited = if isAsync {
            "await System.Threading.Tasks.Task.Yield();"
        } else {
            string.Empty
        }
        let source = (`#nullable enable
public delegate ` + "$returnType" + ` Factory<T>();
public static class C
{
    public static Factory<string> Make(string? maybe) => ` + "$asyncModifier" + `() =>
    {
        ` + "$awaited" + `
        return ((maybe!, 1), "tail");
    };
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "maybe!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,type-parameter-tuple-element | target=lambda expression | slot-type=string (NotAnnotated)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func UnresolvedTarget_IsReportedAsUnknownTarget() {
        let source = `#nullable enable
public static class C
{
    public static int Length(string? x)
    {
        var tfm = string.IsNullOrEmpty(x) ? "d" : x;
        return tfm.Length;
    }
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("else { x!! }", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "x;"), Position(site))
        Assert.Equal("kind=unknown-target | target=? | slot-type=? | result-depends-on-slot=no | value=x", site.Message)
    }

    @Fact
    func ForgivenValue_IntoAGenericMember_IsReportedWithTheForgivenPrefix() {
        let source = `#nullable enable
using System.Collections.Generic;

public sealed class HintBar
{
    private readonly List<(string Key, string Action)> hints = new();

    public HintBar Add(string key, string? action)
    {
        if (!string.IsNullOrWhiteSpace(action))
        {
            hints.Add((key, action!));
        }

        return this;
    }
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("hints.Add((key, action!!))", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "action!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,constructed-generic-member | target=List<(string Key, string Action)>.Add((string Key, string Action)) parameter 'item'",
            site.Message,
            StringComparison.Ordinal
        )
        Assert.EndsWith("| value=action!", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func ForgivenValue_IntoADelegateResult_IsReportedWithTheForgivenPrefix() {
        let source = `using System.Linq;

public static class C
{
    public static string[] Kept() => Items().Select(x => x!).ToArray();

#nullable enable
    private static string?[] Items() => new string?[] { "a" };
#nullable restore
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("-> x!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "x!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,delegate-result | target=Func<string, string>.Invoke(string) | slot-type=string (None)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func InferredParamsElement_FromAnObliviousImport_IsReported() {
        let library = CSharpCompilation.Create(
            "ObliviousLibrary",
            []SyntaxTree{
                CSharpSyntaxTree.ParseText("public static class Lib { public static string Make(string v) => v; }")
            },
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Disable
            )
        )
        using let image = MemoryStream()
        Assert.True(library.Emit(image).Success)
        let source = `using System.Collections.Generic;

public static class C
{
    public static List<T> Of<T>(params T[] items) => new List<T>(items);

    public static List<string> Built() => Of(Lib.Make("x"), "y");
}`
        let (printed, sites) = Translate(
            source,
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(image.ToArray())).ToList()
        )
        Assert.Contains("Of(Lib.Make(\"x\")!!, \"y\")", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "Lib.Make"), Position(site))
        Assert.StartsWith(
            "kind=inferred-method-type-parameter,params-element | target=C.Of<string>(params string[]) parameter 'items' | slot-type=string (None) | result-depends-on-slot=yes",
            site.Message,
            StringComparison.Ordinal
        )
    }

    /// An explicit-type-argument params bridge appears in the corpus only through
    /// cross-project promotion state (GNodeSamples' `List<GExpression>(...)`
    /// over Cs2Gs.CodeModel), which no self-contained translation reproduces.
    /// The classifier itself is pinned here on both params variants.
    @Fact
    func ParamsElement_ClassifiesExpandedElementsOnly() {
        const source = `using System;
using System.Collections.Generic;

public static class C
{
    public static List<T> Of<T>(params T[] items) => new List<T>(items);

    public static int Span<T>(params ReadOnlySpan<T> items) => items.Length;

    public static List<string> Explicit(string s) => Of<string>(s, "y");

    public static List<string> Inferred(string s) => Of(s, "y");

    public static int Collection(string s) => Span(s, "y");

    public static List<string> Direct(string[] s) => Of(s);
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let arguments = document
            .GetRoot()
            .DescendantNodes()
            .OfType[ArgumentSyntax]()
            .Where((argument ArgumentSyntax) -> argument.Expression.ToString() == "s")
            .ToList()
        Assert.Equal(4, arguments.Count)
        let kinds = List[string]()
        for argument in arguments {
            // An expanded params argument has no argument operation of its
            // own; its slot is the invoked method's params parameter.
            let expanded = !(document.SemanticModel.GetOperation(argument) is IArgumentOperation)
            let invocation InvocationExpressionSyntax? = cast[InvocationExpressionSyntax](argument.Parent!!.Parent)
            let method IMethodSymbol? = cast[IMethodSymbol](document.SemanticModel.GetSymbolInfo(invocation!!).Symbol)
            let kind string? = CSharpToGSharpTranslator.ClassifyParameterSlotForTests(
                method!!.Parameters[0],
                argument.Expression,
                expanded,
                out var slotType,
                out var resultDependsOnSlot
            )
            kinds.Add(
                (kind ?? "not-reported") + " " + slotType.ToDisplayString() + " " + resultDependsOnSlot.ToString()
            )
        }
        Assert.Equal(
            []string{
                "explicit-type-argument,params-element string True",
                "inferred-method-type-parameter,params-element string True",
                "inferred-method-type-parameter,params-element string False",
                "not-reported string[] False"
            },
            kinds
        )
    }

    @Theory
    @InlineData("((T, int), string)[]")
    @InlineData("System.Collections.Generic.List<((T, int), string)>")
    func ExpandedParamsTupleLeaf_RetainsDeclaredTypeParameterAndResultDependency(carrierType string) {
        let source = (`#nullable enable
public static class C
{
    public static T Pick<T>(params ` + "$carrierType" + ` values) => values[0].Item1.Item1;
    public static string Result(string? maybe) => Pick<string>(((maybe!, 1), "tail"));
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "maybe!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,explicit-type-argument,params-element | target=C.Pick<string>(params ",
            site.Message,
            StringComparison.Ordinal
        )
        Assert.Contains(
            "| slot-type=string (NotAnnotated) | result-depends-on-slot=yes | value=maybe!",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func AsyncLambdaResult_ReportsTheValueInsideTheTask() {
        let source = `using System;
using System.Threading.Tasks;

public static class C
{
    public static Func<Task<string>> Make() => async () => { await Task.Yield(); return Branch("x"); };
` + MaybeNullHelper + "\n}"
        let (printed, sites) = Translate(source)
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(site))
        Assert.StartsWith(
            "kind=delegate-result | target=lambda expression | slot-type=string (None)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func CollectionExpressionElement_UsesTheResolvedElementType() {
        let source = `#nullable enable
using System.Collections;
using System.Collections.Generic;

public class Bag<T> : IEnumerable<string>
{
    public void Add(string item) { }
    public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public static class C
{
    public static Bag<int> Make(string? x)
    {
        Bag<int> b = [x];
        return b;
    }
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "x];"), Position(site))
        Assert.StartsWith(
            "kind=collection-expression-element | target=Bag<int> | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ResultDependsOnSlot_IsComputedForDelegateAndTypeOwners() {
        let source = `public delegate T Echo<T>(T value);

public sealed class Box<T>
{
    public T Store(T value) => value;
}

public static class C
{
    public static string Both(Echo<string> echo, Box<string> box) => echo(Branch("x")) + box.Store(Branch("y"));
` + MaybeNullHelper + "\n}"
        let (_, sites) = Translate(source)
        Assert.Equal(
            []string{
                "kind=delegate-invoke | target=Echo<string>.Invoke(string) parameter 'value' | slot-type=string (None) | result-depends-on-slot=yes",
                "kind=constructed-generic-member | target=Box<string>.Store(string) parameter 'value' | slot-type=string (None) | result-depends-on-slot=yes"
            },
            sites.Select(
                (site TranslationDiagnostic) -> site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" | value=", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func ResultDependsOnSlot_SeesTheContainingTypesTypeParameter() {
        let source = `public sealed class Box<T>
{
    public sealed class Result { }

    public Result Store(T value) => new Result();
}

public static class C
{
    public static object Stored(Box<string> box) => box.Store(Branch("x"));
` + MaybeNullHelper + "\n}"
        let (_, sites) = Translate(source)
        let site = Assert.Single(sites)
        Assert.StartsWith(
            "kind=constructed-generic-member | target=Box<string>.Store(string) parameter 'value' | slot-type=string (None) | result-depends-on-slot=yes",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func BareArrayInitializerElement_IsReportedAsAnArrayElement() {
        let source = `using System.Linq;

public static class C
{
    public static int Kept()
    {
        string[] items = { Branch("x"), Branch("yy") };
        return items.OfType<string>().Count();
    }
` + MaybeNullHelper + "\n}"
        let (printed, sites) = Translate(source)
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        Assert.Equal(2, sites.Count)
        Assert.All(
            sites,
            (site TranslationDiagnostic) -> Assert.StartsWith(
                "kind=array-element | target=string[] | slot-type=string",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(sites[0]))
    }

    @Fact
    func ForgivenValue_InsideATupleArgument_SeesTheExplicitTypeArgument() {
        let source = `#nullable enable
public static class C
{
    public static T Identity<T>(T value) => value;

    public static (string, string) Pair(string key, string? action) =>
        Identity<(string, string)>((key, action!));
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("action!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "action!"), Position(site))
        Assert.StartsWith("kind=forgiven,explicit-type-argument | target=", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func ValueNestedInAConditional_IntoExpandedParams_IsAParamsElement() {
        // Not the direct argument, so the fail-safe treats it as an expanded
        // element instead of classifying it against the whole `T[]`.
        let source = `#nullable enable
using System.Collections.Generic;

public static class C
{
    public static List<T> Of<T>(params T[] items) => new List<T>(items);

    public static List<string> Pick(bool flag, string? action) => Of(flag ? action! : "z", "y");
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("action!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "action!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,inferred-method-type-parameter,params-element | target=C.Of<string>(params string[]) parameter 'items' | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ForgivenConcreteValue_IntoElementStores_IsReported() {
        let source = `#nullable enable
using System.Collections.Generic;

public static class C
{
    public static string[] Created(string? a) => new[] { a! };

    public static void Written(string[] items, string? b) { items[0] = b!; }

    public static List<string> Collected(string? c) => [c!];
}`
        let (printed, sites) = Translate(source)
        Assert.Equal(
            []string{
                Expected(source, "a!") + " kind=forgiven,array-element | target=string[] | slot-type=string",
                Expected(source, "b!") + " kind=forgiven,array-element | target=string[] | slot-type=string",
                Expected(source, "c!") +
                    " kind=forgiven,collection-expression-element | target=List<string> | slot-type=string"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
        Assert.Contains("a!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func ForgivenValue_ThroughSwitchArmsAndCasts_ResolvesItsElementStore() {
        let source = `#nullable enable
public static class C
{
    public static object[] Made(bool flag, string? x) => new object[] { (object)(flag switch { true => x!, false => "ok" }) };
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "x!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,array-element | target=object[] | slot-type=object",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ForgivenCollectionElement_UsesTheBoundElementType() {
        let source = `#nullable enable
using System.Collections;
using System.Collections.Generic;

public class Bag<T> : IEnumerable<string>
{
    public void Add(string item) { }
    public IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public static class C
{
    public static Bag<int> Make(string? x) => [x!];
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "x!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,collection-expression-element | target=Bag<int> | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func DirectParamsArray_InsideAConditional_IsNotAnElement() {
        let source = `#nullable enable
public static class C
{
    public static int Count<T>(params T[] items) => items.Length;

    public static int Counted(bool flag, string[]? items, string[] other) => Count(flag ? items! : other);
}`
        let (_, sites) = Translate(source)
        Assert.DoesNotContain(
            sites,
            (site TranslationDiagnostic) -> site.Message!!.Contains("params-element", StringComparison.Ordinal)
        )
    }

    @Theory
    @InlineData("T[]", "string[]")
    @InlineData("System.Collections.Generic.List<T>", "System.Collections.Generic.List<string>")
    func DirectParamsIndexerCarriers_AreNotReportedAsExpandedElements(parameterType string, carrierType string) {
        let source = (`#nullable enable
public class Bag<T>
{
    public int this[params ` + "$parameterType" + ` items] => 0;
}

public static class C
{
    public static int Direct(Bag<string> bag, ` + "$carrierType" + `? items) => bag[items!];
    public static int Conditional(Bag<string> bag, bool flag, ` + "$carrierType" + `? items, ` + "$carrierType" + ` other) =>
        bag[flag ? items! : other];
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("bag[items!!]", printed, StringComparison.Ordinal)
        Assert.Equal(2, printed.Split("items!!", StringSplitOptions.None).Length - 1)
        Assert.Empty(sites)
    }

    @Fact
    func RankThreeArrayInitializerElements_AreArrayElements() {
        let source = `#nullable enable
public static class C
{
    public static string[,,] Cube(string? x, string? y) => new string[,,] { { { Branch2(x), y! } } };

    private static string? Branch2(string? value) => value;
}`
        let (printed, sites) = Translate(source)
        Assert.Equal(
            []string{
                Expected(source, "Branch2(x)") + " kind=array-element | target=string[*,*,*]",
                Expected(source, "y!") + " kind=forgiven,array-element | target=string[*,*,*]"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" | slot-type", StringComparison.Ordinal)
                )
            )
        )
        Assert.Contains("y!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func TypeParameterLocalAndReturn_AreReported() {
        let source = `#nullable enable
public static class C
{
    public static T Pick<T>(T? maybe)
        where T : class
    {
        T copy = maybe;
        return maybe;
    }
}`
        let (printed, sites) = Translate(source)
        Assert.Equal(
            []string{
                Expected(source, "maybe;") + " kind=type-parameter-local | target=copy | slot-type=T",
                Expected(source, "maybe;\n    }") + " kind=type-parameter-return | target=C.Pick<T>(T?) | slot-type=T"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func ExpandedConcreteParamsElement_IsReported_AndADirectArrayIsNot() {
        let source = `public static class C
{
    public static string Joined(string[] parts) => System.IO.Path.Combine(Branch("x"), "a", "b", "c", "d") + System.IO.Path.Combine(parts);
` + MaybeNullHelper + "\n}"
        let (printed, sites) = Translate(source)
        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(site))
        // .NET binds the params overload (an array or a ReadOnlySpan<string>,
        // depending on the runtime); either way the element slot is `string`.
        Assert.StartsWith("kind=params-element | target=Path.Combine(params ", site.Message, StringComparison.Ordinal)
        Assert.Contains("| slot-type=string (", site.Message, StringComparison.Ordinal)
    }

    @Fact
    func ForgivenCollectionInitializerArguments_ResolveTheirAddParameters() {
        let source = `#nullable enable
using System.Collections;
using System.Collections.Generic;

public class Rows<T> : IEnumerable
{
    public void Add(int key, T value, bool enabled) { }
    public IEnumerator GetEnumerator() => throw new System.NotImplementedException();
}

public static class C
{
    public static List<string> List(string? a) => new List<string> { a! };
    public static Dictionary<string, string> Map(string? b, string? c) =>
        new Dictionary<string, string> { { b!, c! } };
    public static Rows<string> Row(bool flag, string? d) =>
        new Rows<string> { { 1, flag ? d! : "ok", true } };
}`
        let (printed, sites) = Translate(source)
        Assert.Equal(
            []string{
                Expected(source, "a!") +
                    " kind=forgiven,constructed-generic-member | target=List<string>.Add(string) parameter 'item'",
                Expected(source, "b!") +
                    " kind=forgiven,constructed-generic-member | target=Dictionary<string, string>.Add(string, string) parameter 'key'",
                Expected(source, "c!") +
                    " kind=forgiven,constructed-generic-member | target=Dictionary<string, string>.Add(string, string) parameter 'value'",
                Expected(source, "d!") +
                    " kind=forgiven,constructed-generic-member | target=Rows<string>.Add(int, string, bool) parameter 'value'"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" | slot-type", StringComparison.Ordinal)
                )
            )
        )
        for value in[]string{"a", "b", "c", "d"} {
            Assert.Contains(value + "!!", printed, StringComparison.Ordinal)
        }
    }

    @Theory
    @InlineData("IEnumerable<string>", "", "")
    @InlineData("IEnumerator<string>", "", "")
    @InlineData("IAsyncEnumerable<string>", "async ", "await System.Threading.Tasks.Task.Yield();")
    @InlineData("IAsyncEnumerator<string>", "async ", "await System.Threading.Tasks.Task.Yield();")
    func ForgivenIteratorElementBridges_AreReported(returnType string, modifier string, awaitStatement string) {
        let source = (`#nullable enable
using System.Collections.Generic;

public static class C
{
    public static ` + "$modifier" + "$returnType" + ` Read(string? forgiven)
    {
        ` + "$awaitStatement" + `
        yield return forgiven!;
    }
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("yield forgiven!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "forgiven!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,iterator-element | target=C.Read(string?) | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Theory
    @InlineData("IEnumerable<(string, bool)>", "", "")
    @InlineData("IEnumerator<(string, bool)>", "", "")
    @InlineData("IAsyncEnumerable<(string, bool)>", "async ", "await System.Threading.Tasks.Task.Yield();")
    @InlineData("IAsyncEnumerator<(string, bool)>", "async ", "await System.Threading.Tasks.Task.Yield();")
    func TupleIteratorElementBridges_ReportTheBridgedElementType(
        returnType string,
        modifier string,
        awaitStatement string
    ) {
        let source = (`#nullable enable
using System.Collections.Generic;

public static class C
{
    public static ` + "$modifier" + "$returnType" + ` Read(string? line)
    {
        ` + "$awaitStatement" + `
        yield return (line, true);
    }
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("yield (line!!, true)", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "line, true"), Position(site))
        Assert.StartsWith(
            "kind=iterator-element | target=C.Read(string?) | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ForgivenCollectionInitializerParams_OnlyExpandedValuesAreElements() {
        let source = `#nullable enable
using System.Collections;

public class Bag<T> : IEnumerable
{
    public void Add(int key, params T[] values) { }
    public IEnumerator GetEnumerator() => throw new System.NotImplementedException();
}

public static class C
{
    public static Bag<string> Make(string? a, string? b, string[]? items) =>
        new Bag<string> { { 1, a!, b! }, { 2, items! } };
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("a!!", printed, StringComparison.Ordinal)
        Assert.Contains("b!!", printed, StringComparison.Ordinal)
        Assert.Contains("items!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "a!") +
                    " kind=forgiven,constructed-generic-member,params-element | target=Bag<string>.Add(int, params string[]) parameter 'values' | slot-type=string",
                Expected(source, "b!") +
                    " kind=forgiven,constructed-generic-member,params-element | target=Bag<string>.Add(int, params string[]) parameter 'values' | slot-type=string"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func ForgivenValues_ThroughNullPreservingOperators_ReachNullableArrayElements() {
        let source = `#nullable enable
public static class C
{
    public static string?[] Cast(object? cast) => new string?[] { cast! as string };
    public static object?[] Coalesce(object? coalesced) => new object?[] { coalesced! ?? null };
    public static string?[] Fallback(string? fallback) => new string?[] { null ?? fallback! };
    public static string?[] Checked(string? checkedValue) => new string?[] { checked(checkedValue!) };
    public static string?[] Unchecked(string? uncheckedValue) => new string?[] { unchecked(uncheckedValue!) };
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("cast!!", printed, StringComparison.Ordinal)
        Assert.Contains("coalesced!!", printed, StringComparison.Ordinal)
        Assert.Contains("fallback!!", printed, StringComparison.Ordinal)
        Assert.Contains("checkedValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("uncheckedValue!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "cast!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "coalesced!") + " kind=forgiven,array-element | target=object?[] | slot-type=object?",
                Expected(source, "fallback!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "checkedValue!") +
                    " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "uncheckedValue!") +
                    " kind=forgiven,array-element | target=string?[] | slot-type=string?"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func ForgivenWrappedIteratorValues_ReportTheirDestinationSlots() {
        let source = `#nullable enable
using System.Collections.Generic;

public static class C
{
    public static IEnumerable<string?> Scalar(object? x) { yield return x! as string; }
    public static IEnumerable<(string?, bool)> Tuple(object? y) { yield return (y! as string, true); }
    public static IEnumerable<object?> Cast(string? z) { yield return (object?)z!; }
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        Assert.Contains("y!!", printed, StringComparison.Ordinal)
        Assert.Contains("z!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "x!") +
                    " kind=forgiven,iterator-element | target=C.Scalar(object?) | slot-type=string?",
                Expected(source, "y!") +
                    " kind=forgiven,iterator-element | target=C.Tuple(object?) | slot-type=string?",
                Expected(source, "z!") + " kind=forgiven,iterator-element | target=C.Cast(string?) | slot-type=object?"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func CollectionInitializerDirectParamsCarrier_IsNotReportedAsAnElement() {
        let source = `#nullable enable
using System.Collections;

public class Bag<T> : IEnumerable
{
    public void Add(int key, params T[] values) { }
    public IEnumerator GetEnumerator() => throw new System.NotImplementedException();
}

public static class C
{
    public static Bag<string> Make() => new Bag<string> { { 1, MaybeArray() } };
    private static string[]? MaybeArray() => null;
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("MaybeArray()!!", printed, StringComparison.Ordinal)
        Assert.Empty(sites)
    }

    @Fact
    func ParameterClassification_DependencyWalkIncludesPointersAndFunctionPointers() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", `public static unsafe class C
{
    public static T* Pointer<T>(T value) where T : unmanaged => null;
    public static delegate*<T, void> Parameter<T>(T value) => null;
    public static delegate*<int, T> Return<T>(T value) => null;
    public static delegate*<int, int> Independent<T>(T value) => null;
}`)})
        let compilation = project.Compilation.WithOptions(project.Compilation.Options.WithAllowUnsafe(true))
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        let tree = Assert.Single(compilation.SyntaxTrees)
        let model = compilation.GetSemanticModel(tree)
        let dependencies = List[bool]()
        for methodSyntax in tree.GetRoot().DescendantNodes().OfType[MethodDeclarationSyntax]() {
            let method IMethodSymbol? = cast[IMethodSymbol](model.GetDeclaredSymbol(methodSyntax))
            let kind = CSharpToGSharpTranslator.ClassifyParameterSlotForTests(
                method!!.Parameters[0],
                SyntaxFactory.IdentifierName("value"),
                expandedParams: false,
                out _,
                out var resultDependsOnSlot
            )!!
            Assert.Equal("inferred-method-type-parameter", kind)
            dependencies.Add(resultDependsOnSlot)
        }
        Assert.Equal([]bool{true, true, true, false}, dependencies)
    }

    @Fact
    func ForgivenNullableSpanAndBuilderElements_AreReportedBeforeTheFastPath() {
        let source = `#nullable enable
using System;
using System.Collections.Immutable;

public static class C
{
    public static int Count(object? x, object? y, object? z, object? unasserted)
    {
        ReadOnlySpan<string?> readOnly = [x! as string];
        Span<string?> writable = [y! as string];
        ImmutableArray<string?> built = [z! as string];
        ReadOnlySpan<string?> safe = [unasserted as string];
        return readOnly.Length + writable.Length + built.Length + safe.Length;
    }
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        Assert.Contains("y!!", printed, StringComparison.Ordinal)
        Assert.Contains("z!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("unasserted!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "x!") +
                    " kind=forgiven,collection-expression-element | target=ReadOnlySpan<string?> | slot-type=string?",
                Expected(source, "y!") +
                    " kind=forgiven,collection-expression-element | target=Span<string?> | slot-type=string?",
                Expected(source, "z!") +
                    " kind=forgiven,collection-expression-element | target=ImmutableArray<string?> | slot-type=string?"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func ForgivenNullConditionalReceiver_ResolvesTheNullableElementStore() {
        let source = `#nullable enable
public static class C
{
    public static object?[] Values(string? value) => new object?[] { value!?.Length };
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("value!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "value!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,array-element | target=object?[] | slot-type=object?",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ForgivenAssignmentResults_ResolveTheirFinalGenericStores() {
        let source = `#nullable enable
public static class C
{
    private static T Id<T>(T value) => value;
    public static string Argument(string? x)
    {
        string tmp;
        return Id<string>(tmp = x!);
    }

    public static string?[] Array(string? y)
    {
        string tmp;
        return new string?[] { tmp = y! };
    }

    public static string Coalesced(string tmp, string? z) => Id<string>(tmp ??= z!);

    public static System.Uri Intermediate(System.Collections.Generic.Dictionary<string, string> map, string? inner) =>
        new System.Uri(map["key"] = inner!);

    public static System.Uri Concrete(string? negative)
    {
        string tmp;
        return new System.Uri(tmp = negative!);
    }
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("x!!", printed, StringComparison.Ordinal)
        Assert.Contains("y!!", printed, StringComparison.Ordinal)
        Assert.Contains("z!!", printed, StringComparison.Ordinal)
        Assert.Contains("inner!!", printed, StringComparison.Ordinal)
        Assert.Contains("negative!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "x!") +
                    " kind=forgiven,explicit-type-argument | target=C.Id<string>(string) parameter 'value' | slot-type=string",
                Expected(source, "y!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "z!") +
                    " kind=forgiven,explicit-type-argument | target=C.Id<string>(string) parameter 'value' | slot-type=string",
                Expected(source, "inner!") +
                    " kind=forgiven,constructed-generic-member | target=Dictionary<string, string>.this[string] | slot-type=string"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
    }

    @Theory
    @InlineData("=")
    @InlineData("??=")
    func OrdinaryAssignmentResults_ResolveOuterGenericStoresAndPreserveConcreteControls(assignment string) {
        // Coalescing locals widen to nullable; a fixed CLR property keeps the inner bridge real.
        let target = if assignment == "=" {
            "tmp"
        } else {
            "holder.Path"
        }
        let declaration = if assignment == "=" {
            "string tmp = \"\";"
        } else {
            "var holder = new System.UriBuilder();"
        }
        let Store = func (target string, value string) string {
            return if assignment == "=" {
                "$target = $value"
            } else {
                "$target ??= ($target = $value)"
            }
        }
        let source = (`#nullable enable
public static class C
{
    private static T Id<T>(T value) => value;
    public static string Argument()
    {
        ` + "$declaration" + `
        return Id<string>(` + "${Store(target, "MaybeArgument()")}" + `);
    }

    public static string?[] Array()
    {
        ` + "$declaration" + `
        return new string?[] { ` + "${Store(target, "MaybeArray()")}" + ` };
    }

    public static System.Uri Intermediate(System.Collections.Generic.Dictionary<string, string> map) =>
        new System.Uri(` + "${Store("map[\"key\"]", "MaybeIntermediate()")}" + `);

    public static System.Uri Concrete()
    {
        ` + "$declaration" + `
        return new System.Uri(` + "${Store(target, "MaybeNegative()")}" + `);
    }

    public static string NonNull()
    {
        ` + "$declaration" + `
        return Id<string>(` + "${Store(target, "\"safe\"")}" + `);
    }

    private static string? MaybeArgument() => null;
    private static string? MaybeArray() => null;
    private static string? MaybeIntermediate() => null;
    private static string? MaybeNegative() => null;
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.True(printed.Contains("MaybeArgument()!!", StringComparison.Ordinal), printed)
        Assert.Contains("MaybeArray()!!", printed, StringComparison.Ordinal)
        Assert.Contains("MaybeIntermediate()!!", printed, StringComparison.Ordinal)
        Assert.Contains("MaybeNegative()!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("\"safe\"!!", printed, StringComparison.Ordinal)
        let expected = List[string]{
            Expected(source, "MaybeArgument()") +
                " kind=explicit-type-argument | target=C.Id<string>(string) parameter 'value' | slot-type=string"
        }
        if assignment == "??=" {
            expected.Add(
                Expected(source, "holder.Path ??=") +
                    " kind=explicit-type-argument | target=C.Id<string>(string) parameter 'value' | slot-type=string"
            )
        }
        expected.Add(Expected(source, "MaybeArray()") + " kind=array-element | target=string?[] | slot-type=string?")
        expected.Add(
            Expected(source, "MaybeIntermediate()") +
                " kind=constructed-generic-member | target=Dictionary<string, string>.this[string] | slot-type=string"
        )
        Assert.Equal(
            expected,
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
        let argumentSites = if assignment == "=" {
            1
        } else {
            2
        }
        Assert.All(
            sites.Take(argumentSites),
            (site TranslationDiagnostic) -> Assert.Contains(
                "result-depends-on-slot=yes",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.All(
            sites.Skip(argumentSites),
            (site TranslationDiagnostic) -> Assert.Contains(
                "result-depends-on-slot=no",
                site.Message,
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func WholeParamsVariableAssignments_AreNotExpandedElementStores() {
        let source = `#nullable enable
public static class C
{
    public static void Concrete(string[]? concrete, params string[] items) => items = concrete!;
    public static void Generic<T>(T[]? generic, params T[] items) => items = generic!;
    public static void Collection(System.Collections.Generic.List<string>? collection, params System.Collections.Generic.List<string> items) =>
        items = collection!;
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("concrete!!", printed, StringComparison.Ordinal)
        Assert.Contains("generic!!", printed, StringComparison.Ordinal)
        Assert.Contains("collection!!", printed, StringComparison.Ordinal)
        Assert.Empty(sites)
    }

    @Fact
    func GenericParameterVariableAssignments_UseAssignmentMetadataAndPreserveFinalArguments() {
        let source = `#nullable enable
public static class C
{
    private static T Id<T>(T value) => value;
    public static T Method<T>(T copy, T? maybe) where T : class
    {
        copy = maybe;
        return copy;
    }

    public static string[] Result(string[]? source, params string[] items) => Id<string[]>(items = source!);
}

public class Box<T> where T : class
{
    public T Member(T copy, T? other)
    {
        copy = other;
        return copy;
    }
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal)
        Assert.Contains("other!!", printed, StringComparison.Ordinal)
        Assert.Contains("source!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "maybe;") +
                    " kind=type-parameter-assignment | target=C.Method<T>(T, T?) parameter 'copy' | slot-type=T",
                Expected(source, "source!") +
                    " kind=forgiven,explicit-type-argument | target=C.Id<string[]>(string[]) parameter 'value' | slot-type=string[]",
                Expected(source, "other;") +
                    " kind=type-parameter-assignment | target=Box<T>.Member(T, T?) parameter 'copy' | slot-type=T"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
        Assert.All(
            sites.Where(
                (site TranslationDiagnostic) -> site.Message!!.StartsWith(
                    "kind=type-parameter-assignment",
                    StringComparison.Ordinal
                )
            ),
            (site TranslationDiagnostic) -> Assert.Contains(
                "result-depends-on-slot=no",
                site.Message,
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func WrappedForgivenValues_ResolveNullableDeclarationAndResultStores() {
        let source = `#nullable enable
public class Box<T> where T : class
{
    private static string? FieldSource;
    private static string? PropertySource;
    private static string? ArrowSource;
    public static T? Field = FieldSource! as T;
    public static T? Initialized { get; } = PropertySource! as T;
    public static T? Property => ArrowSource! as T;
    public static T? Local(string? localValue)
    {
        T? result = localValue! as T;
        return result;
    }

    public static T? Block(string? blockValue) { return blockValue! as T; }
    public static T? Arrow(string? arrowValue) => arrowValue! as T;
    public static System.Func<T?> Lambda(string? lambdaValue) => () => lambdaValue! as T;
    public static System.Func<T?> BlockLambda(string? blockLambdaValue) => () => { return blockLambdaValue! as T; };
    public static async System.Threading.Tasks.Task<T?> Async(string? asyncValue)
    {
        await System.Threading.Tasks.Task.Yield();
        return asyncValue! as T;
    }

    public static System.Func<System.Threading.Tasks.Task<T?>> AsyncLambda(string? asyncLambdaValue) => async () =>
    {
        await System.Threading.Tasks.Task.Yield();
        return asyncLambdaValue! as T;
    };
    public static System.Func<System.Threading.Tasks.Task<T?>> AsyncExpression(string? expressionValue) => async () => expressionValue! as T;
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("FieldSource!!", printed, StringComparison.Ordinal)
        Assert.Contains("PropertySource!!", printed, StringComparison.Ordinal)
        Assert.Contains("ArrowSource!!", printed, StringComparison.Ordinal)
        Assert.Contains("localValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("blockValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("arrowValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("lambdaValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("blockLambdaValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("asyncValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("asyncLambdaValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("expressionValue!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "FieldSource!") + " kind=forgiven,constructed-generic-member | slot-type=T?",
                Expected(source, "PropertySource!") + " kind=forgiven,constructed-generic-member | slot-type=T?",
                Expected(source, "ArrowSource!") + " kind=forgiven,constructed-generic-member | slot-type=T?",
                Expected(source, "localValue!") + " kind=forgiven,type-parameter-local | slot-type=T?",
                Expected(source, "blockValue!") + " kind=forgiven,type-parameter-return | slot-type=T?",
                Expected(source, "arrowValue!") + " kind=forgiven,type-parameter-return | slot-type=T?",
                Expected(source, "lambdaValue!") + " kind=forgiven,delegate-result | slot-type=T?",
                Expected(source, "blockLambdaValue!") + " kind=forgiven,delegate-result | slot-type=T?",
                Expected(source, "asyncValue!") + " kind=forgiven,type-parameter-return | slot-type=T?",
                Expected(source, "asyncLambdaValue!") + " kind=forgiven,delegate-result | slot-type=T?",
                Expected(source, "expressionValue!") + " kind=forgiven,delegate-result | slot-type=T?"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" | target=", StringComparison.Ordinal)
                ) +
                    site.Message!!
                    .Substring(site.Message!!.IndexOf(" | slot-type=", StringComparison.Ordinal)).Split(" (")[0]
            )
        )
    }

    @Fact
    func TypeParameterTupleLeaves_AreReportedForDeclarationsReturnsAndArguments() {
        let source = `#nullable enable
public class Box<T> where T : class
{
    private static T? FieldSource;
    private static T? PropertySource;
    public static ((T, int), string) Field = ((FieldSource, 1), "");
    public static (T, string) Property => (PropertySource, "");
    public static (T, string) Result(T? returned) => (returned, "");
    public static (T, string) Local(T? localValue)
    {
        (T, string) local = (localValue, "");
        return local;
    }
    private static U Echo<U>((U, string) pair) => pair.Item1;
    public static T Argument(T? argument) => Echo<T>((argument, ""));
    public static string Closed(string? closed) => Echo<string>((closed, ""));
    public static (string, string) Concrete(string? negative) => (negative, "");
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("FieldSource!!", printed, StringComparison.Ordinal)
        Assert.Contains("PropertySource!!", printed, StringComparison.Ordinal)
        Assert.Contains("returned!!", printed, StringComparison.Ordinal)
        Assert.Contains("localValue!!", printed, StringComparison.Ordinal)
        Assert.Contains("argument!!", printed, StringComparison.Ordinal)
        Assert.Contains("closed!!", printed, StringComparison.Ordinal)
        Assert.Contains("negative!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "FieldSource,") +
                    " kind=type-parameter-tuple-element | target=Box<T>.Field | slot-type=T",
                Expected(source, "PropertySource,") +
                    " kind=type-parameter-tuple-element | target=Box<T>.Property | slot-type=T",
                Expected(source, "returned,") +
                    " kind=type-parameter-tuple-element | target=Box<T>.Result(T?) | slot-type=T",
                Expected(source, "localValue,") + " kind=type-parameter-tuple-element | target=local | slot-type=T",
                Expected(source, "argument,") +
                    " kind=type-parameter-tuple-element | target=Box<T>.Echo<T>((T, string)) parameter 'pair' | slot-type=T",
                Expected(source, "closed,") +
                    " kind=type-parameter-tuple-element | target=Box<T>.Echo<string>((string, string)) parameter 'pair' | slot-type=string"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
        Assert.All(
            sites.Take(5),
            (site TranslationDiagnostic) -> Assert.Contains(
                " | slot-type=T (NotAnnotated)",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.Contains("result-depends-on-slot=yes", sites[4].Message, StringComparison.Ordinal)
        Assert.Contains("result-depends-on-slot=yes", sites[5].Message, StringComparison.Ordinal)
    }

    @Fact
    func WrappedForgivenTupleLeaf_ReportsItsNullableTypeParameterDestination() {
        let source = `#nullable enable
public static class C
{
    public static (T?, string) Result<T>(string? value) where T : class => (value! as T, "");
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("value!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "value!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,type-parameter-tuple-element | target=C.Result<T>(string?) | slot-type=T? (Annotated)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NullableTupleDestinations_ProjectEachDeclaredAndConstructedLeaf(nested bool) {
        let Tuple = func (name string) string {
            return if nested {
                "(($name!, 1), \"\")"
            } else {
                "($name!, \"\")"
            }
        }
        let declaredTuple = if nested {
            "((T, int)?, string)?"
        } else {
            "(T, string)?"
        }
        let closedTuple = declaredTuple.Replace("T", "string", StringComparison.Ordinal)
        let source = (`#nullable enable
using System.Collections.Generic;
using System.Threading.Tasks;
public class Box<T>
{
    public ` + "$declaredTuple" + ` Field;
    public ` + "$declaredTuple" + ` Property { get; set; }
}
public delegate ` + "$declaredTuple" + ` Factory<T>();
public delegate Task<` + "$declaredTuple" + `> AsyncFactory<T>();
public delegate ` + "$closedTuple" + ` ConcreteFactory();
public static class C
{
    private static T Echo<T>(` + "$declaredTuple" + ` pair, T fallback) => fallback;
    private static T Pick<T>(T fallback, params ` + "$declaredTuple" + `[] values) => fallback;
    public static void Stores(
        string? field, string? property, string? argument, string? expanded, string? array,
        string? expression, string? block, string? asynchronous, string? concrete,
        string safe)
    {
        var box = new Box<string>();
        box.Field = ` + "${Tuple("field")}" + `;
        box.Property = ` + "${Tuple("property")}" + `;
        Echo<string>(` + "${Tuple("argument")}" + `, "");
        Pick<string>("", ` + "${Tuple("expanded")}" + `);
        var values = new ` + "$closedTuple" + `[] { ` + "${Tuple("array")}" + ` };
        Factory<string> callback = () => ` + "${Tuple("expression")}" + `;
        Factory<string> blocked = () => { return ` + "${Tuple("block")}" + `; };
        AsyncFactory<string> awaited = async () =>
        {
            await Task.Yield();
            return ` + "${Tuple("asynchronous")}" + `;
        };
        ConcreteFactory ignored = () => ` + "${Tuple("concrete")}" + `;
        box.Field = ` + "${(if nested { "((safe, 1), \"\")" } else { "(safe, \"\")" })}" + `;
    }
    public static IEnumerable<` + "$closedTuple" + `> Values(string? iterator)
    {
        yield return ` + "${Tuple("iterator")}" + `;
    }
}`)
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        let reported[]string = []string{
            "argument",
            "expanded",
            "array",
            "expression",
            "block",
            "asynchronous",
            "iterator"
        }
        for name in reported.Append("concrete") {
            Assert.Contains(name + "!!", printed, StringComparison.Ordinal)
        }
        Assert.DoesNotContain("field!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("property!!", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("safe!!", printed, StringComparison.Ordinal)
        Assert.Equal(reported.Select((name string) -> Expected(source, name + "!")), sites.Select(Position))
        Assert.All(
            sites,
            (site TranslationDiagnostic) -> Assert.Contains(
                " | slot-type=string (NotAnnotated) | ",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.All(
            sites.Take(1).Concat(sites.Skip(3).Take(3)),
            (site TranslationDiagnostic) -> Assert.StartsWith(
                "kind=forgiven,type-parameter-tuple-element | ",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.StartsWith(
            "kind=forgiven,explicit-type-argument,params-element | ",
            sites[1].Message,
            StringComparison.Ordinal
        )
        Assert.StartsWith("kind=forgiven,array-element | ", sites[2].Message, StringComparison.Ordinal)
        Assert.StartsWith("kind=forgiven,iterator-element | ", sites[6].Message, StringComparison.Ordinal)
        Assert.All(
            sites.Take(2),
            (site TranslationDiagnostic) -> Assert.Contains(
                " | result-depends-on-slot=yes | ",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.All(
            sites.Skip(2),
            (site TranslationDiagnostic) -> Assert.Contains(
                " | result-depends-on-slot=no | ",
                site.Message,
                StringComparison.Ordinal
            )
        )
        Assert.DoesNotContain(
            sites,
            (site TranslationDiagnostic) -> site.Message!!.Contains("value=concrete!", StringComparison.Ordinal)
        )
    }

    @Fact
    func TupleLeaves_InSubstitutedParameterFieldAndDelegateSlots_ReportLeafMetadata() {
        let source = `#nullable enable
public class Box<T> { public T Value; }
public static class C
{
    private static T Id<T>(T value) => value;
    public static void Stores(string key, string? argument, string? field, string? result)
    {
        Id<(string, string)>((key, argument!));
        var box = new Box<(string, string)>();
        box.Value = (key, field!);
        System.Func<(string, string)> callback = () => (key, result!);
    }
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("argument!!", printed, StringComparison.Ordinal)
        Assert.Contains("field!!", printed, StringComparison.Ordinal)
        Assert.Contains("result!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "argument!") +
                    " kind=forgiven,explicit-type-argument | target=C.Id<(string, string)>((string, string)) parameter 'value' | slot-type=string",
                Expected(source, "field!") +
                    " kind=forgiven,constructed-generic-member | target=Box<(string, string)>.Value | slot-type=string",
                Expected(source, "result!") +
                    " kind=forgiven,delegate-result | target=Func<(string, string)>.Invoke() | slot-type=string"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" (", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func ForgivenTypeParameterValues_PreserveTheirCallResultDependency() {
        let source = `#nullable enable
public static class C
{
    private static T Id<T>(T value) => value;
    private static void Consume<T>(T value) { }
    public static T Result<T>(T through) => Id<T>(through!);
    public static void Ignored<T>(T ignored) => Consume<T>(ignored!);
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("through!!", printed, StringComparison.Ordinal)
        Assert.Contains("ignored!!", printed, StringComparison.Ordinal)
        Assert.Equal(
            []string{
                Expected(source, "through!") +
                    " kind=forgiven-type-parameter-value | target=C.Id<T>(T) parameter 'value' | slot-type=T (NotAnnotated) | result-depends-on-slot=yes",
                Expected(source, "ignored!") +
                    " kind=forgiven-type-parameter-value | target=C.Consume<T>(T) parameter 'value' | slot-type=T (NotAnnotated) | result-depends-on-slot=no"
            },
            sites.Select(
                (site TranslationDiagnostic) -> Position(site) + " " + site.Message!!.Substring(
                    0,
                    site.Message!!.IndexOf(" | value=", StringComparison.Ordinal)
                )
            )
        )
    }

    @Fact
    func RebuiltTupleIndexKey_ReportsTheBoundSyntheticLeafSlot() {
        let source = `using System.Collections.Generic;
public class Node { }
public static class C
{
    private static string Branch() => null;
    public static bool Lookup(Node node)
    {
        var key = (Branch(), node);
        return new Dictionary<(string, Node), bool>()[key];
    }
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("key.Item1!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "key];"), Position(site))
        Assert.StartsWith(
            "kind=constructed-generic-member | target=Dictionary<(string, Node), bool>.this[(string, Node)] parameter 'key' | slot-type=string",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func BoxedNestedTupleBridge_RetainsTheResolvedObjectDestination() {
        let source = `#nullable enable
public static class C
{
    private static T Id<T>(T value) => value;
    public static object Result(string? maybe) => Id<(object, object)>(((maybe!, "nested"), "tail"));
}`
        let (printed, sites) = Translate(source, nullableContext: NullableContextOptions.Enable)
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal)
        let site = Assert.Single(sites)
        Assert.Equal(Expected(source, "maybe!"), Position(site))
        Assert.StartsWith(
            "kind=forgiven,explicit-type-argument | target=C.Id<(object, object)>((object, object)) parameter 'value' | slot-type=object (NotAnnotated)",
            site.Message,
            StringComparison.Ordinal
        )
    }

    @Fact
    func RebuiltTupleIndexKey_ReportsEachDistinctAssertedLeaf() {
        let source = `using System.Collections.Generic;
public static class C
{
    private static string Branch() => null;
    public static bool Lookup()
    {
        var key = (Branch(), Branch());
        return new Dictionary<(string, string), bool>()[key];
    }
}`
        let (printed, sites) = Translate(source)
        Assert.Contains("key.Item1!!", printed, StringComparison.Ordinal)
        Assert.Contains("key.Item2!!", printed, StringComparison.Ordinal)
        Assert.Equal(2, sites.Count)
        Assert.All(sites, (site TranslationDiagnostic) -> Assert.Equal(Expected(source, "key];"), Position(site)))
        Assert.Equal(
            []string{"key.Item1", "key.Item2"},
            sites.Select(
                (site TranslationDiagnostic) -> site.Message!!.Substring(
                    site.Message!!.IndexOf(" | value=", StringComparison.Ordinal) + " | value=".Length
                )
            )
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TruncatedTupleIndexKeys_RetainEachAssertedLeaf(multiline bool) {
        let keyName = String('k', 180)
        let keyExpression = if multiline {
            "C.\n" + keyName
        } else {
            "C." + keyName
        }
        let source = (`using System.Collections.Generic;
public static class C
{
    private static readonly (string, string) ` + "$keyName" + ` = (Branch(), Branch());
    private static string Branch() => null;
    public static bool Lookup()
    {
        return new Dictionary<(string, string), bool>()[` + "$keyExpression" + `];
    }
}`)
        let (printed, sites) = Translate(source)
        Assert.Contains(".Item1!!", printed, StringComparison.Ordinal)
        Assert.Contains(".Item2!!", printed, StringComparison.Ordinal)
        Assert.Equal(2, sites.Count)
        Assert.All(
            sites,
            (site TranslationDiagnostic) -> Assert.Equal(Expected(source, keyExpression + "];"), Position(site))
        )
        let prefix = if multiline {
            "C...."
        } else {
            "C." + String('k', 149) + "..."
        }
        Assert.Equal(
            []string{prefix + ".Item1", prefix + ".Item2"},
            sites.Select(
                (site TranslationDiagnostic) -> site.Message!!.Substring(
                    site.Message!!.IndexOf(" | value=", StringComparison.Ordinal) + " | value=".Length
                )
            )
        )
    }

    @Fact
    func ReportOnce_GenericStoresRetainDistinctMessagesAndProjections() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", "class C { }")})
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let location = document.GetRoot().GetLocation()
        let id = CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        context.ReportOnce(
            TranslationDiagnostic("GenericStoreBridge", "first store", location, TranslationSeverity.Warning){
                DiagnosticId = id
            }
        )
        context.ReportOnce(
            TranslationDiagnostic("GenericStoreBridge", "second store", location, TranslationSeverity.Warning){
                DiagnosticId = id
            }
        )
        context.ReportOnce(
            TranslationDiagnostic("GenericStoreBridge", "first store", location, TranslationSeverity.Warning){
                DiagnosticId = id
            }
        )
        context.ReportOnce(
            TranslationDiagnostic("GenericStoreBridge", "leaf store", location, TranslationSeverity.Warning){
                DiagnosticId = id
            },
            ".Item1"
        )
        context.ReportOnce(
            TranslationDiagnostic("GenericStoreBridge", "leaf store", location, TranslationSeverity.Warning){
                DiagnosticId = id
            },
            ".Item2"
        )
        context.ReportOnce(
            TranslationDiagnostic("GenericStoreBridge", "leaf store", location, TranslationSeverity.Warning){
                DiagnosticId = id
            },
            ".Item1"
        )
        Assert.Equal(
            []string{"first store", "second store", "leaf store", "leaf store"},
            context.Diagnostics.Select((site TranslationDiagnostic) -> site.Message)
        )
    }

    @Fact
    func ReportOnce_DistinguishesSyntheticLeavesAndCollapsesRepeatedLeaves() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", "class C { }")})
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let location = document.GetRoot().GetLocation()
        context.ReportOnce(
            TranslationDiagnostic("k", "first", location, TranslationSeverity.Warning){DiagnosticId = "X"},
            ".Item1"
        )
        context.ReportOnce(
            TranslationDiagnostic("k", "repeat", location, TranslationSeverity.Warning){DiagnosticId = "X"},
            ".Item1"
        )
        context.ReportOnce(
            TranslationDiagnostic("k", "second", location, TranslationSeverity.Warning){DiagnosticId = "X"},
            ".Item2"
        )
        Assert.Equal(
            []string{"first", "second"},
            context.Diagnostics.Select((diagnostic TranslationDiagnostic) -> diagnostic.Message)
        )
    }

    @Fact
    func ReportOnce_KeepsOneDiagnosticPerIdAndPosition() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Probe.cs", "class C { }")})
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let location = document.GetRoot().GetLocation()
        context.ReportOnce(
            TranslationDiagnostic("k", "first", location, TranslationSeverity.Warning){DiagnosticId = "X"}
        )
        context.ReportOnce(
            TranslationDiagnostic("k", "again", location, TranslationSeverity.Warning){DiagnosticId = "X"}
        )
        context.ReportOnce(
            TranslationDiagnostic("k", "other id", location, TranslationSeverity.Warning){DiagnosticId = "Y"}
        )
        // Without a source location or an id there is nothing to compare, so
        // nothing is deduplicated.
        context.ReportOnce(TranslationDiagnostic("k", "no id 1", location, TranslationSeverity.Warning))
        context.ReportOnce(TranslationDiagnostic("k", "no id 2", location, TranslationSeverity.Warning))
        context.ReportOnce(
            TranslationDiagnostic("k", "no location 1", nil, TranslationSeverity.Warning){DiagnosticId = "X"}
        )
        context.ReportOnce(
            TranslationDiagnostic("k", "no location 2", nil, TranslationSeverity.Warning){DiagnosticId = "X"}
        )
        Assert.Equal(
            []string{"first", "other id", "no id 1", "no id 2", "no location 1", "no location 2"},
            context.Diagnostics.Select((d TranslationDiagnostic) -> d.Message)
        )
    }

    @Fact
    async func TranslateStage_WritesEverySiteToTranslateLog_AndTheAppPasses() {
        let projectDir = Path.Combine(
            AppContext.BaseDirectory,
            "loader-tests",
            "typeparam-slot-bridge",
            Guid.NewGuid().ToString("N")
        )
        let outRoot = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "typeparam-slot-bridge",
            Guid.NewGuid().ToString("N")
        )
        try {
            Directory.CreateDirectory(projectDir)
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
            let projectPath = Path.Combine(projectDir, "Bridges.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup>
        <OutputType>Library</OutputType>
        <TargetFramework>net10.0</TargetFramework>
      </PropertyGroup>
    </Project>
    `)
            File.WriteAllText(Path.Combine(projectDir, "Probe.cs"), `using System.Collections.Generic;

public static class C
{
    public static int Added(List<string> list)
    {
        list.Add(Branch("x"));
        return list.Count;
    }

#nullable enable
    private static string? Branch(string value) => value.Length > 1 ? value : null;
#nullable restore
}`)
            Directory.CreateDirectory(outRoot)
            let pipeline = MigrationPipeline(PipelineOptions{OutputRoot: outRoot}, []IMigrationStage{TranslateStage()})
            let result = await pipeline.RunAsync(
                []CorpusApp{CorpusApp("test/TypeParamSlotBridge", projectPath, TargetKind.Library)}
            )
            let app = Assert.Single(result.Apps)
            Assert.True(app.Succeeded, app.FailureCategory)
            let translateLog = File.ReadAllText(
                Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories))
            )
            Assert.Contains(
                CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId + " (non-fatal): ",
                translateLog,
                StringComparison.Ordinal
            )
            Assert.Contains(
                "Probe.cs(7,18): GenericStoreBridge: kind=constructed-generic-member",
                translateLog,
                StringComparison.Ordinal
            )
        } finally {
            DeleteDirectory(projectDir)
            DeleteDirectory(outRoot)
        }
    }

    @Fact
    async func TranslateStage_AppSummaryAggregatesOwnDocumentsWithoutChargingReferencedProjects() {
        let root = Path.Combine(
            AppContext.BaseDirectory,
            "loader-tests",
            "generic-store-app-summary",
            Guid.NewGuid().ToString("N")
        )
        let projectDir = Path.Combine(root, "App")
        let siblingDir = Path.Combine(root, "Sibling")
        let outRoot = Path.Combine(root, "migration")
        try {
            Directory.CreateDirectory(projectDir)
            Directory.CreateDirectory(siblingDir)
            File.WriteAllText(Path.Combine(root, "Directory.Build.props"), "<Project />")
            let projectPath = Path.Combine(projectDir, "App.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><ProjectReference Include="../Sibling/Sibling.csproj" /></ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(siblingDir, "Sibling.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(projectDir, "AppProbe.cs"), `#nullable enable
using System.Collections.Generic;
public static class AppBridge
{
    public static void Add(List<string> values)
    {
        values.Add(Maybe());
        SiblingBridge.Add(values);
        values.Add("safe");
    }
    private static string? Maybe() => null;
}`)
            File.WriteAllText(Path.Combine(siblingDir, "SiblingProbe.cs"), `#nullable enable
using System.Collections.Generic;
public static class SiblingBridge
{
    public static void Add(List<string> values)
    {
        values.Add(Maybe());
        values.Add(Maybe());
        values.Add("safe");
    }
    private static string? Maybe() => null;
}`)
            File.WriteAllText(Path.Combine(projectDir, "ExtraProbe.cs"), `#nullable enable
using System.Collections.Generic;
public static class ExtraBridge
{
    public static void Add(List<string> values)
    {
        values.Add(Maybe());
        values.Add(Maybe());
        values.Add("safe");
    }
    private static string? Maybe() => null;
}`)
            let pipeline = MigrationPipeline(
                PipelineOptions{OutputRoot: outRoot, CompileViaSdk: false},
                []IMigrationStage{TranslateStage()}
            )
            let originalError = Console.Error
            using let capturedError = StringWriter()
            var result RunResult
            Console.SetError(capturedError)
            try {
                result = await pipeline.RunAsync(
                    []CorpusApp{CorpusApp("test/AppWideBridges", projectPath, TargetKind.Library)}
                )
            } finally {
                Console.SetError(originalError)
            }
            let app = Assert.Single(result.Apps)
            Assert.True(app.Succeeded, app.FailureCategory)
            let emitted = Directory.GetFiles(outRoot, "*.gs", SearchOption.AllDirectories)
            Assert.Equal(3, emitted.Length)
            Assert.Equal(5, emitted.Sum((path string) -> Regex.Matches(File.ReadAllText(path), "Maybe\\(\\)!!").Count))
            let log = File.ReadAllText(
                Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories))
            )
            let id = CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            let sites = log
                .Split('\n')
                .Where((line string) -> line.StartsWith(id + " (non-fatal): ", StringComparison.Ordinal))
                .ToArray()
            Assert.Equal(3, sites.Length)
            Assert.Equal(3, sites.Distinct(StringComparer.Ordinal).Count())
            Assert.Single(sites, (site string) -> site.Contains("AppProbe.cs(", StringComparison.Ordinal))
            Assert.Equal(2, sites.Count((site string) -> site.Contains("ExtraProbe.cs(", StringComparison.Ordinal)))
            Assert.DoesNotContain(sites, (site string) -> site.Contains("SiblingProbe.cs(", StringComparison.Ordinal))
            let summary = Assert.Single(
                capturedError.ToString().Split('\n'),
                (line string) -> line.Contains(id, StringComparison.Ordinal)
            )
            Assert.Contains("test/AppWideBridges: 3 " + id + " site(s):", summary, StringComparison.Ordinal)
        } finally {
            DeleteDirectory(root)
        }
    }

    shared {
        private const MaybeNullHelper string = `#nullable enable
    private static string? Branch(string value) => value.Length > 1 ? value : null;
#nullable restore`

        private func Translate(
            source string,
            references IReadOnlyList[MetadataReference]? = nil,
            nullableContext NullableContextOptions = NullableContextOptions.Disable
        )(Printed string, Sites List[TranslationDiagnostic]) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Probe.cs", source)}, references)
            Assert.True(
                project.BoundWithoutErrors,
                "Source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let originalDocument = Assert.Single(project.Documents)
            let compilation = project.Compilation.WithOptions(
                project.Compilation.Options.WithNullableContextOptions(nullableContext)
            )
            let document = LoadedDocument(
                originalDocument.FilePath,
                originalDocument.SyntaxTree,
                compilation.GetSemanticModel(originalDocument.SyntaxTree)
            )
            let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            let sites = context
                .Diagnostics
                .Where(
                (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
                .ToList()
            return (printed, sites)
        }

        private func DeleteDirectory(path string) {
            try {
                if Directory.Exists(path) {
                    Directory.Delete(path, recursive: true)
                }
            } catch (exception Exception) when exception is IOException || exception is UnauthorizedAccessException {
                // Best effort: a locked or protected file must not fail the test.
                // DirectoryNotFoundException and PathTooLongException are IOExceptions.

            }
        }

        // The 1-based line:column of the first occurrence of `marker` in `source`.
        private func Expected(source string, marker string) string {
            let offset = source.IndexOf(marker, StringComparison.Ordinal)
            Assert.True(offset >= 0, marker)
            let before = source.Substring(0, offset)
            let line = before.Count((c char) -> c == '\n') + 1
            let column = offset - (before.LastIndexOf('\n') + 1) + 1
            return "$line:$column"
        }

        private func Position(diagnostic TranslationDiagnostic) string {
            let span = diagnostic.Location!!.GetLineSpan()
            return "${span.StartLinePosition.Line + 1}:${span.StartLinePosition.Character + 1}"
        }
    }
}
