// <copyright file="Issue4612GenericStoreBridgeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4612 (option 1): cs2gs keeps its fail-fast <c>!!</c> when a maybe-null
/// value is stored into a type-parameter or array-element slot, and now reports each such site
/// as <c>CS2GS-GENERIC-STORE-BRIDGE</c>, so the runtime change is visible at
/// translate time. The generated code is unchanged.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): with <c>ReportStoreBridge</c> returning
/// before it reports, every test that expects a site fails, and the output
/// assertions still pass, which shows the report does not change the code.
/// </remarks>
public class Issue4612GenericStoreBridgeTests
{
    private const string MaybeNullHelper = """
        #nullable enable
            private static string? Branch(string value) => value.Length > 1 ? value : null;
        #nullable restore
        """;

    [Fact]
    public void InferredMethodTypeParameter_Append_IsReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            using System.Linq;

            public static class C
            {
                public static int Appended(string[] items) =>
                    items.Append(Branch("x")).Where(s => s != null).Count();

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains(".Append(Branch(\"x\")!!)", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(TranslationSeverity.Warning, site.Severity);
        Assert.Equal("6:22", Position(site));
        Assert.StartsWith("kind=inferred-method-type-parameter | target=", site.Message, StringComparison.Ordinal);
        Assert.Contains("| result-depends-on-slot=yes | value=Branch(\"x\")", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConstructedGenericMember_ListAdd_IsReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            using System.Collections.Generic;

            public static class C
            {
                public static int Added()
                {
                    var list = new List<string>();
                    list.Add(Branch("x"));
                    return list.Count;
                }

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains(".Add(Branch(\"x\")!!)", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal("8:18", Position(site));
        Assert.StartsWith("kind=constructed-generic-member | target=List<string>.Add(string)", site.Message, StringComparison.Ordinal);
        Assert.Contains("| result-depends-on-slot=no |", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DelegateInvoke_IsReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            using System;

            public static class C
            {
                public static void Called(Action<string> callback) => callback(Branch("x"));

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains("callback(Branch(\"x\")!!)", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.StartsWith("kind=delegate-invoke | target=Action<string>.Invoke(string)", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitTypeArgument_IsReportedWithItsOwnKind()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            public static class C
            {
                public static T Identity<T>(T value) => value;

                public static string Explicit() => Identity<string>(Branch("x"));

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.StartsWith("kind=explicit-type-argument | target=", site.Message, StringComparison.Ordinal);
        Assert.Contains("| result-depends-on-slot=yes |", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ConcreteImportedParameter_KeepsItsBridge_AndIsNotReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            public static class C
            {
                public static System.Uri Concrete() => new System.Uri(Branch("x"));

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains("Uri(Branch(\"x\")!!)", printed, StringComparison.Ordinal);
        Assert.Empty(sites);
    }

    [Fact]
    public void IndexerAssignment_IntoTypeParameterSlot_IsReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            using System.Collections.Generic;

            public static class C
            {
                public static int Stored()
                {
                    var map = new Dictionary<string, string>();
                    map["k"] = Branch("x");
                    return map.Count;
                }

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.StartsWith("kind=constructed-generic-member | target=Dictionary<string, string>.this[string]", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CollectionExpressionElement_IntoAGenericCollection_IsReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            #nullable enable
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
            }
            """);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.StartsWith("kind=collection-expression-element | target=Bag<string> | slot-type=string", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayInitializerElement_FilteredByOfType_IsReported()
    {
        // The #4628 shape: C# stores the null in the array and OfType drops it.
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            using System.Linq;

            public static class C
            {
                public static int Kept() => new[] { Branch("x"), Branch("yy") }.OfType<string>().Count();

            """ + MaybeNullHelper + """

            }
            """);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        Assert.Equal(2, sites.Count);
        Assert.All(sites, site => Assert.StartsWith("kind=array-element | target=string[] | slot-type=string", site.Message, StringComparison.Ordinal));
        Assert.Equal("5:41", Position(sites[0]));
    }

    /// <summary>
    /// The #4681 shape (Gsharp.Runtime.Channels): C# writes <c>value!</c> on an
    /// unconstrained <c>T</c> that may hold null. C# erases the operator; the
    /// migrated <c>value!!</c> throws for a channel of a nullable reference type.
    /// </summary>
    [Fact]
    public void ForgivenUnconstrainedTypeParameterValue_IsReported()
    {
        (string printed, List<TranslationDiagnostic> sites) = Translate("""
            #nullable enable
            using System.Threading.Tasks;

            public sealed class Chan<T>
            {
                private T? value;

                public ValueTask<T> ReceiveValueAsync() => new ValueTask<T>(this.value!);
            }
            """);

        Assert.Contains("value!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal("8:65", Position(site));
        Assert.StartsWith("kind=forgiven-type-parameter-value | target=", site.Message, StringComparison.Ordinal);
        Assert.Contains("| slot-type=T", site.Message, StringComparison.Ordinal);
        Assert.EndsWith("| value=this.value!", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DelegateResult_SelectLambdaResult_IsReported()
    {
        string source = """
            using System.Linq;

            public static class C
            {
                public static string[] Mapped(string[] items) => items.Select(item => Branch(item)).ToArray();

            """ + MaybeNullHelper + """

            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("Branch(item)!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "Branch(item)"), Position(site));
        Assert.StartsWith(
            "kind=delegate-result | target=Func<string, string>.Invoke(string) | slot-type=string (None) | result-depends-on-slot=no",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void DelegateResult_BlockLambdaReturn_IsReported()
    {
        string source = """
            using System;

            public static class C
            {
                public static Func<string> Make() => () => { return Branch("x"); };

            """ + MaybeNullHelper + """

            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(site));
        Assert.StartsWith("kind=delegate-result | target=lambda expression | slot-type=string (None)", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnresolvedTarget_IsReportedAsUnknownTarget()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static int Length(string? x)
                {
                    var tfm = string.IsNullOrEmpty(x) ? "d" : x;
                    return tfm.Length;
                }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("else { x!! }", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "x;"), Position(site));
        Assert.Equal("kind=unknown-target | target=? | slot-type=? | result-depends-on-slot=no | value=x", site.Message);
    }

    [Fact]
    public void ForgivenValue_IntoAGenericMember_IsReportedWithTheForgivenPrefix()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("hints.Add((key, action!!))", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "action!"), Position(site));
        Assert.StartsWith(
            "kind=forgiven,constructed-generic-member | target=List<(string Key, string Action)>.Add((string Key, string Action)) parameter 'item'",
            site.Message,
            StringComparison.Ordinal);
        Assert.EndsWith("| value=action!", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenValue_IntoADelegateResult_IsReportedWithTheForgivenPrefix()
    {
        string source = """
            using System.Linq;

            public static class C
            {
                public static string[] Kept() => Items().Select(x => x!).ToArray();

            #nullable enable
                private static string?[] Items() => new string?[] { "a" };
            #nullable restore
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("-> x!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "x!"), Position(site));
        Assert.StartsWith(
            "kind=forgiven,delegate-result | target=Func<string, string>.Invoke(string) | slot-type=string (None)",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void InferredParamsElement_FromAnObliviousImport_IsReported()
    {
        CSharpCompilation library = CSharpCompilation.Create(
            "ObliviousLibrary",
            new[] { CSharpSyntaxTree.ParseText("public static class Lib { public static string Make(string v) => v; }") },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));
        using var image = new MemoryStream();
        Assert.True(library.Emit(image).Success);
        string source = """
            using System.Collections.Generic;

            public static class C
            {
                public static List<T> Of<T>(params T[] items) => new List<T>(items);

                public static List<string> Built() => Of(Lib.Make("x"), "y");
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(
            source,
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(image.ToArray())).ToList());

        Assert.Contains("Of(Lib.Make(\"x\")!!, \"y\")", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "Lib.Make"), Position(site));
        Assert.StartsWith(
            "kind=inferred-method-type-parameter,params-element | target=C.Of<string>(params string[]) parameter 'items' | slot-type=string (None) | result-depends-on-slot=yes",
            site.Message,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// An explicit-type-argument params bridge appears in the corpus only through
    /// cross-project promotion state (GNodeSamples' <c>List&lt;GExpression&gt;(...)</c>
    /// over Cs2Gs.CodeModel), which no self-contained translation reproduces.
    /// The classifier itself is pinned here on both params variants.
    /// </summary>
    [Fact]
    public void ParamsElement_ClassifiesExpandedElementsOnly()
    {
        const string source = """
            using System;
            using System.Collections.Generic;

            public static class C
            {
                public static List<T> Of<T>(params T[] items) => new List<T>(items);

                public static int Span<T>(params ReadOnlySpan<T> items) => items.Length;

                public static List<string> Explicit(string s) => Of<string>(s, "y");

                public static List<string> Inferred(string s) => Of(s, "y");

                public static int Collection(string s) => Span(s, "y");

                public static List<string> Direct(string[] s) => Of(s);
            }
            """;
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        List<ArgumentSyntax> arguments = document.GetRoot().DescendantNodes().OfType<ArgumentSyntax>()
            .Where(argument => argument.Expression.ToString() == "s")
            .ToList();
        Assert.Equal(4, arguments.Count);

        var kinds = new List<string>();
        foreach (ArgumentSyntax argument in arguments)
        {
            // An expanded params argument has no argument operation of its
            // own; its slot is the invoked method's params parameter.
            bool expanded = document.SemanticModel.GetOperation(argument) is not IArgumentOperation;
            var invocation = (InvocationExpressionSyntax)argument.Parent.Parent;
            var method = (IMethodSymbol)document.SemanticModel.GetSymbolInfo(invocation).Symbol;
            string kind = CSharpToGSharpTranslator.ClassifyParameterSlotForTests(
                method.Parameters[0],
                argument.Expression,
                expanded,
                out ITypeSymbol slotType,
                out bool resultDependsOnSlot);
            kinds.Add((kind ?? "not-reported") + " " + slotType.ToDisplayString() + " " + resultDependsOnSlot);
        }

        Assert.Equal(
            new[]
            {
                "explicit-type-argument,params-element string True",
                "inferred-method-type-parameter,params-element string True",
                "inferred-method-type-parameter,params-element string False",
                "not-reported string[] False",
            },
            kinds);
    }

    [Fact]
    public void AsyncLambdaResult_ReportsTheValueInsideTheTask()
    {
        string source = """
            using System;
            using System.Threading.Tasks;

            public static class C
            {
                public static Func<Task<string>> Make() => async () => { await Task.Yield(); return Branch("x"); };

            """ + MaybeNullHelper + """

            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(site));
        Assert.StartsWith("kind=delegate-result | target=lambda expression | slot-type=string (None)", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CollectionExpressionElement_UsesTheResolvedElementType()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "x];"), Position(site));
        Assert.StartsWith("kind=collection-expression-element | target=Bag<int> | slot-type=string", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResultDependsOnSlot_IsComputedForDelegateAndTypeOwners()
    {
        string source = """
            public delegate T Echo<T>(T value);

            public sealed class Box<T>
            {
                public T Store(T value) => value;
            }

            public static class C
            {
                public static string Both(Echo<string> echo, Box<string> box) => echo(Branch("x")) + box.Store(Branch("y"));

            """ + MaybeNullHelper + """

            }
            """;
        (_, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Equal(
            new[]
            {
                "kind=delegate-invoke | target=Echo<string>.Invoke(string) parameter 'value' | slot-type=string (None) | result-depends-on-slot=yes",
                "kind=constructed-generic-member | target=Box<string>.Store(string) parameter 'value' | slot-type=string (None) | result-depends-on-slot=yes",
            },
            sites.Select(site => site.Message.Substring(0, site.Message.IndexOf(" | value=", StringComparison.Ordinal))));
    }

    [Fact]
    public void ResultDependsOnSlot_SeesTheContainingTypesTypeParameter()
    {
        string source = """
            public sealed class Box<T>
            {
                public sealed class Result { }

                public Result Store(T value) => new Result();
            }

            public static class C
            {
                public static object Stored(Box<string> box) => box.Store(Branch("x"));

            """ + MaybeNullHelper + """

            }
            """;
        (_, List<TranslationDiagnostic> sites) = Translate(source);

        TranslationDiagnostic site = Assert.Single(sites);
        Assert.StartsWith(
            "kind=constructed-generic-member | target=Box<string>.Store(string) parameter 'value' | slot-type=string (None) | result-depends-on-slot=yes",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void BareArrayInitializerElement_IsReportedAsAnArrayElement()
    {
        string source = """
            using System.Linq;

            public static class C
            {
                public static int Kept()
                {
                    string[] items = { Branch("x"), Branch("yy") };
                    return items.OfType<string>().Count();
                }

            """ + MaybeNullHelper + """

            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        Assert.Equal(2, sites.Count);
        Assert.All(sites, site => Assert.StartsWith("kind=array-element | target=string[] | slot-type=string", site.Message, StringComparison.Ordinal));
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(sites[0]));
    }

    [Fact]
    public void ForgivenValue_InsideATupleArgument_SeesTheExplicitTypeArgument()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static T Identity<T>(T value) => value;

                public static (string, string) Pair(string key, string? action) =>
                    Identity<(string, string)>((key, action!));
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("action!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "action!"), Position(site));
        Assert.StartsWith("kind=forgiven,explicit-type-argument | target=", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ValueNestedInAConditional_IntoExpandedParams_IsAParamsElement()
    {
        // Not the direct argument, so the fail-safe treats it as an expanded
        // element instead of classifying it against the whole `T[]`.
        string source = """
            #nullable enable
            using System.Collections.Generic;

            public static class C
            {
                public static List<T> Of<T>(params T[] items) => new List<T>(items);

                public static List<string> Pick(bool flag, string? action) => Of(flag ? action! : "z", "y");
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("action!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "action!"), Position(site));
        Assert.StartsWith(
            "kind=forgiven,inferred-method-type-parameter,params-element | target=C.Of<string>(params string[]) parameter 'items' | slot-type=string",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenConcreteValue_IntoElementStores_IsReported()
    {
        string source = """
            #nullable enable
            using System.Collections.Generic;

            public static class C
            {
                public static string[] Created(string? a) => new[] { a! };

                public static void Written(string[] items, string? b) { items[0] = b!; }

                public static List<string> Collected(string? c) => [c!];
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Equal(
            new[]
            {
                Expected(source, "a!") + " kind=forgiven,array-element | target=string[] | slot-type=string",
                Expected(source, "b!") + " kind=forgiven,array-element | target=string[] | slot-type=string",
                Expected(source, "c!") + " kind=forgiven,collection-expression-element | target=List<string> | slot-type=string",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
        Assert.Contains("a!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenValue_ThroughSwitchArmsAndCasts_ResolvesItsElementStore()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static object[] Made(bool flag, string? x) => new object[] { (object)(flag switch { true => x!, false => "ok" }) };
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "x!"), Position(site));
        Assert.StartsWith("kind=forgiven,array-element | target=object[] | slot-type=object", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenCollectionElement_UsesTheBoundElementType()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "x!"), Position(site));
        Assert.StartsWith("kind=forgiven,collection-expression-element | target=Bag<int> | slot-type=string", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DirectParamsArray_InsideAConditional_IsNotAnElement()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static int Count<T>(params T[] items) => items.Length;

                public static int Counted(bool flag, string[]? items, string[] other) => Count(flag ? items! : other);
            }
            """;
        (_, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.DoesNotContain(sites, site => site.Message.Contains("params-element", StringComparison.Ordinal));
    }

    [Fact]
    public void RankThreeArrayInitializerElements_AreArrayElements()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static string[,,] Cube(string? x, string? y) => new string[,,] { { { Branch2(x), y! } } };

                private static string? Branch2(string? value) => value;
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Equal(
            new[]
            {
                Expected(source, "Branch2(x)") + " kind=array-element | target=string[*,*,*]",
                Expected(source, "y!") + " kind=forgiven,array-element | target=string[*,*,*]",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" | slot-type", StringComparison.Ordinal))));
        Assert.Contains("y!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void TypeParameterLocalAndReturn_AreReported()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static T Pick<T>(T? maybe)
                    where T : class
                {
                    T copy = maybe;
                    return maybe;
                }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Equal(
            new[]
            {
                Expected(source, "maybe;") + " kind=type-parameter-local | target=copy | slot-type=T",
                Expected(source, "maybe;\n    }") + " kind=type-parameter-return | target=C.Pick<T>(T?) | slot-type=T",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
        Assert.Contains("maybe!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpandedConcreteParamsElement_IsReported_AndADirectArrayIsNot()
    {
        string source = """
            public static class C
            {
                public static string Joined(string[] parts) => System.IO.Path.Combine(Branch("x"), "a", "b", "c", "d") + System.IO.Path.Combine(parts);

            """ + MaybeNullHelper + """

            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("Branch(\"x\")!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "Branch(\"x\")"), Position(site));
        // .NET binds the params overload (an array or a ReadOnlySpan<string>,
        // depending on the runtime); either way the element slot is `string`.
        Assert.StartsWith("kind=params-element | target=Path.Combine(params ", site.Message, StringComparison.Ordinal);
        Assert.Contains("| slot-type=string (", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenCollectionInitializerArguments_ResolveTheirAddParameters()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Equal(
            new[]
            {
                Expected(source, "a!") + " kind=forgiven,constructed-generic-member | target=List<string>.Add(string) parameter 'item'",
                Expected(source, "b!") + " kind=forgiven,constructed-generic-member | target=Dictionary<string, string>.Add(string, string) parameter 'key'",
                Expected(source, "c!") + " kind=forgiven,constructed-generic-member | target=Dictionary<string, string>.Add(string, string) parameter 'value'",
                Expected(source, "d!") + " kind=forgiven,constructed-generic-member | target=Rows<string>.Add(int, string, bool) parameter 'value'",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" | slot-type", StringComparison.Ordinal))));
        foreach (string value in new[] { "a", "b", "c", "d" })
        {
            Assert.Contains(value + "!!", printed, StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("IEnumerable<string>", "", "")]
    [InlineData("IEnumerator<string>", "", "")]
    [InlineData("IAsyncEnumerable<string>", "async ", "await System.Threading.Tasks.Task.Yield();")]
    [InlineData("IAsyncEnumerator<string>", "async ", "await System.Threading.Tasks.Task.Yield();")]
    public void ForgivenIteratorElementBridges_AreReported(
        string returnType,
        string modifier,
        string awaitStatement)
    {
        string source = $$"""
            #nullable enable
            using System.Collections.Generic;

            public static class C
            {
                public static {{modifier}}{{returnType}} Read(string? forgiven)
                {
                    {{awaitStatement}}
                    yield return forgiven!;
                }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("yield forgiven!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "forgiven!"), Position(site));
        Assert.StartsWith(
            "kind=forgiven,iterator-element | target=C.Read(string?) | slot-type=string",
            site.Message,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("IEnumerable<(string, bool)>", "", "")]
    [InlineData("IEnumerator<(string, bool)>", "", "")]
    [InlineData("IAsyncEnumerable<(string, bool)>", "async ", "await System.Threading.Tasks.Task.Yield();")]
    [InlineData("IAsyncEnumerator<(string, bool)>", "async ", "await System.Threading.Tasks.Task.Yield();")]
    public void TupleIteratorElementBridges_ReportTheBridgedElementType(
        string returnType,
        string modifier,
        string awaitStatement)
    {
        string source = $$"""
            #nullable enable
            using System.Collections.Generic;

            public static class C
            {
                public static {{modifier}}{{returnType}} Read(string? line)
                {
                    {{awaitStatement}}
                    yield return (line, true);
                }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("yield (line!!, true)", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "line, true"), Position(site));
        Assert.StartsWith(
            "kind=iterator-element | target=C.Read(string?) | slot-type=string",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenCollectionInitializerParams_OnlyExpandedValuesAreElements()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("a!!", printed, StringComparison.Ordinal);
        Assert.Contains("b!!", printed, StringComparison.Ordinal);
        Assert.Contains("items!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "a!") + " kind=forgiven,constructed-generic-member,params-element | target=Bag<string>.Add(int, params string[]) parameter 'values' | slot-type=string",
                Expected(source, "b!") + " kind=forgiven,constructed-generic-member,params-element | target=Bag<string>.Add(int, params string[]) parameter 'values' | slot-type=string",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
    }

    [Fact]
    public void ForgivenValues_ThroughNullPreservingOperators_ReachNullableArrayElements()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static string?[] Cast(object? cast) => new string?[] { cast! as string };
                public static object?[] Coalesce(object? coalesced) => new object?[] { coalesced! ?? null };
                public static string?[] Fallback(string? fallback) => new string?[] { null ?? fallback! };
                public static string?[] Checked(string? checkedValue) => new string?[] { checked(checkedValue!) };
                public static string?[] Unchecked(string? uncheckedValue) => new string?[] { unchecked(uncheckedValue!) };
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("cast!!", printed, StringComparison.Ordinal);
        Assert.Contains("coalesced!!", printed, StringComparison.Ordinal);
        Assert.Contains("fallback!!", printed, StringComparison.Ordinal);
        Assert.Contains("checkedValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("uncheckedValue!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "cast!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "coalesced!") + " kind=forgiven,array-element | target=object?[] | slot-type=object?",
                Expected(source, "fallback!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "checkedValue!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "uncheckedValue!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
    }

    [Fact]
    public void ForgivenWrappedIteratorValues_ReportTheirDestinationSlots()
    {
        string source = """
            #nullable enable
            using System.Collections.Generic;

            public static class C
            {
                public static IEnumerable<string?> Scalar(object? x) { yield return x! as string; }
                public static IEnumerable<(string?, bool)> Tuple(object? y) { yield return (y! as string, true); }
                public static IEnumerable<object?> Cast(string? z) { yield return (object?)z!; }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        Assert.Contains("y!!", printed, StringComparison.Ordinal);
        Assert.Contains("z!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "x!") + " kind=forgiven,iterator-element | target=C.Scalar(object?) | slot-type=string?",
                Expected(source, "y!") + " kind=forgiven,iterator-element | target=C.Tuple(object?) | slot-type=string?",
                Expected(source, "z!") + " kind=forgiven,iterator-element | target=C.Cast(string?) | slot-type=object?",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
    }

    [Fact]
    public void CollectionInitializerDirectParamsCarrier_IsNotReportedAsAnElement()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("MaybeArray()!!", printed, StringComparison.Ordinal);
        Assert.Empty(sites);
    }

    [Fact]
    public void ParameterClassification_DependencyWalkIncludesPointersAndFunctionPointers()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", """
            public static unsafe class C
            {
                public static T* Pointer<T>(T value) where T : unmanaged => null;
                public static delegate*<T, void> Parameter<T>(T value) => null;
                public static delegate*<int, T> Return<T>(T value) => null;
                public static delegate*<int, int> Independent<T>(T value) => null;
            }
            """) });
        CSharpCompilation compilation = project.Compilation.WithOptions(project.Compilation.Options.WithAllowUnsafe(true));
        Assert.DoesNotContain(compilation.GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        SyntaxTree tree = Assert.Single(compilation.SyntaxTrees);
        SemanticModel model = compilation.GetSemanticModel(tree);
        var dependencies = new List<bool>();
        foreach (MethodDeclarationSyntax methodSyntax in tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            var method = (IMethodSymbol)model.GetDeclaredSymbol(methodSyntax);
            string kind = CSharpToGSharpTranslator.ClassifyParameterSlotForTests(
                method.Parameters[0],
                SyntaxFactory.IdentifierName("value"),
                expandedParams: false,
                out _,
                out bool resultDependsOnSlot);
            Assert.Equal("inferred-method-type-parameter", kind);
            dependencies.Add(resultDependsOnSlot);
        }

        Assert.Equal(new[] { true, true, true, false }, dependencies);
    }

    [Fact]
    public void ForgivenNullableSpanAndBuilderElements_AreReportedBeforeTheFastPath()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        Assert.Contains("y!!", printed, StringComparison.Ordinal);
        Assert.Contains("z!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("unasserted!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "x!") + " kind=forgiven,collection-expression-element | target=ReadOnlySpan<string?> | slot-type=string?",
                Expected(source, "y!") + " kind=forgiven,collection-expression-element | target=Span<string?> | slot-type=string?",
                Expected(source, "z!") + " kind=forgiven,collection-expression-element | target=ImmutableArray<string?> | slot-type=string?",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
    }

    [Fact]
    public void ForgivenNullConditionalReceiver_ResolvesTheNullableElementStore()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static object?[] Values(string? value) => new object?[] { value!?.Length };
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("value!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "value!"), Position(site));
        Assert.StartsWith("kind=forgiven,array-element | target=object?[] | slot-type=object?", site.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ForgivenAssignmentResults_ResolveTheirFinalGenericStores()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("x!!", printed, StringComparison.Ordinal);
        Assert.Contains("y!!", printed, StringComparison.Ordinal);
        Assert.Contains("z!!", printed, StringComparison.Ordinal);
        Assert.Contains("inner!!", printed, StringComparison.Ordinal);
        Assert.Contains("negative!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "x!") + " kind=forgiven,explicit-type-argument | target=C.Id<string>(string) parameter 'value' | slot-type=string",
                Expected(source, "y!") + " kind=forgiven,array-element | target=string?[] | slot-type=string?",
                Expected(source, "z!") + " kind=forgiven,explicit-type-argument | target=C.Id<string>(string) parameter 'value' | slot-type=string",
                Expected(source, "inner!") + " kind=forgiven,constructed-generic-member | target=Dictionary<string, string>.this[string] | slot-type=string",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
    }

    [Fact]
    public void WholeParamsVariableAssignments_AreNotExpandedElementStores()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static void Concrete(string[]? concrete, params string[] items) => items = concrete!;
                public static void Generic<T>(T[]? generic, params T[] items) => items = generic!;
                public static void Collection(System.Collections.Generic.List<string>? collection, params System.Collections.Generic.List<string> items) =>
                    items = collection!;
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("concrete!!", printed, StringComparison.Ordinal);
        Assert.Contains("generic!!", printed, StringComparison.Ordinal);
        Assert.Contains("collection!!", printed, StringComparison.Ordinal);
        Assert.Empty(sites);
    }

    [Fact]
    public void GenericParameterVariableAssignments_UseAssignmentMetadataAndPreserveFinalArguments()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("maybe!!", printed, StringComparison.Ordinal);
        Assert.Contains("other!!", printed, StringComparison.Ordinal);
        Assert.Contains("source!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "maybe;") + " kind=type-parameter-assignment | target=C.Method<T>(T, T?) parameter 'copy' | slot-type=T",
                Expected(source, "source!") + " kind=forgiven,explicit-type-argument | target=C.Id<string[]>(string[]) parameter 'value' | slot-type=string[]",
                Expected(source, "other;") + " kind=type-parameter-assignment | target=Box<T>.Member(T, T?) parameter 'copy' | slot-type=T",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
        Assert.All(
            sites.Where(site => site.Message.StartsWith("kind=type-parameter-assignment", StringComparison.Ordinal)),
            site => Assert.Contains("result-depends-on-slot=no", site.Message, StringComparison.Ordinal));
    }

    [Fact]
    public void WrappedForgivenValues_ResolveNullableDeclarationAndResultStores()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("FieldSource!!", printed, StringComparison.Ordinal);
        Assert.Contains("PropertySource!!", printed, StringComparison.Ordinal);
        Assert.Contains("ArrowSource!!", printed, StringComparison.Ordinal);
        Assert.Contains("localValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("blockValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("arrowValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("lambdaValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("blockLambdaValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("asyncValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("asyncLambdaValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("expressionValue!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
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
                Expected(source, "expressionValue!") + " kind=forgiven,delegate-result | slot-type=T?",
            },
            sites.Select(site => Position(site)
                + " " + site.Message.Substring(0, site.Message.IndexOf(" | target=", StringComparison.Ordinal))
                + site.Message.Substring(site.Message.IndexOf(" | slot-type=", StringComparison.Ordinal)).Split(" (")[0]));
    }

    [Fact]
    public void TypeParameterTupleLeaves_AreReportedForDeclarationsReturnsAndArguments()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("FieldSource!!", printed, StringComparison.Ordinal);
        Assert.Contains("PropertySource!!", printed, StringComparison.Ordinal);
        Assert.Contains("returned!!", printed, StringComparison.Ordinal);
        Assert.Contains("localValue!!", printed, StringComparison.Ordinal);
        Assert.Contains("argument!!", printed, StringComparison.Ordinal);
        Assert.Contains("closed!!", printed, StringComparison.Ordinal);
        Assert.Contains("negative!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "FieldSource,") + " kind=type-parameter-tuple-element | target=Box<T>.Field | slot-type=T",
                Expected(source, "PropertySource,") + " kind=type-parameter-tuple-element | target=Box<T>.Property | slot-type=T",
                Expected(source, "returned,") + " kind=type-parameter-tuple-element | target=Box<T>.Result(T?) | slot-type=T",
                Expected(source, "localValue,") + " kind=type-parameter-tuple-element | target=local | slot-type=T",
                Expected(source, "argument,") + " kind=type-parameter-tuple-element | target=Box<T>.Echo<T>((T, string)) parameter 'pair' | slot-type=T",
                Expected(source, "closed,") + " kind=type-parameter-tuple-element | target=Box<T>.Echo<string>((string, string)) parameter 'pair' | slot-type=string",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
        Assert.All(sites.Take(5), site => Assert.Contains(" | slot-type=T (NotAnnotated)", site.Message, StringComparison.Ordinal));
        Assert.Contains("result-depends-on-slot=yes", sites[4].Message, StringComparison.Ordinal);
        Assert.Contains("result-depends-on-slot=yes", sites[5].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WrappedForgivenTupleLeaf_ReportsItsNullableTypeParameterDestination()
    {
        string source = """
            #nullable enable
            public static class C
            {
                public static (T?, string) Result<T>(string? value) where T : class => (value! as T, "");
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("value!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "value!"), Position(site));
        Assert.StartsWith(
            "kind=forgiven,type-parameter-tuple-element | target=C.Result<T>(string?) | slot-type=T? (Annotated)",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void TupleLeaves_InSubstitutedParameterFieldAndDelegateSlots_ReportLeafMetadata()
    {
        string source = """
            #nullable enable
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
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("argument!!", printed, StringComparison.Ordinal);
        Assert.Contains("field!!", printed, StringComparison.Ordinal);
        Assert.Contains("result!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "argument!") + " kind=forgiven,explicit-type-argument | target=C.Id<(string, string)>((string, string)) parameter 'value' | slot-type=string",
                Expected(source, "field!") + " kind=forgiven,constructed-generic-member | target=Box<(string, string)>.Value | slot-type=string",
                Expected(source, "result!") + " kind=forgiven,delegate-result | target=Func<(string, string)>.Invoke() | slot-type=string",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" (", StringComparison.Ordinal))));
    }

    [Fact]
    public void ForgivenTypeParameterValues_PreserveTheirCallResultDependency()
    {
        string source = """
            #nullable enable
            public static class C
            {
                private static T Id<T>(T value) => value;
                private static void Consume<T>(T value) { }
                public static T Result<T>(T through) => Id<T>(through!);
                public static void Ignored<T>(T ignored) => Consume<T>(ignored!);
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("through!!", printed, StringComparison.Ordinal);
        Assert.Contains("ignored!!", printed, StringComparison.Ordinal);
        Assert.Equal(
            new[]
            {
                Expected(source, "through!") + " kind=forgiven-type-parameter-value | target=C.Id<T>(T) parameter 'value' | slot-type=T (NotAnnotated) | result-depends-on-slot=yes",
                Expected(source, "ignored!") + " kind=forgiven-type-parameter-value | target=C.Consume<T>(T) parameter 'value' | slot-type=T (NotAnnotated) | result-depends-on-slot=no",
            },
            sites.Select(site => Position(site) + " " + site.Message.Substring(0, site.Message.IndexOf(" | value=", StringComparison.Ordinal))));
    }

    [Fact]
    public void RebuiltTupleIndexKey_ReportsTheBoundSyntheticLeafSlot()
    {
        string source = """
            using System.Collections.Generic;
            public class Node { }
            public static class C
            {
                private static string Branch() => null;
                public static bool Lookup(Node node)
                {
                    var key = (Branch(), node);
                    return new Dictionary<(string, Node), bool>()[key];
                }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("key.Item1!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "key];"), Position(site));
        Assert.StartsWith(
            "kind=constructed-generic-member | target=Dictionary<(string, Node), bool>.this[(string, Node)] parameter 'key' | slot-type=string",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void BoxedNestedTupleBridge_RetainsTheResolvedObjectDestination()
    {
        string source = """
            #nullable enable
            public static class C
            {
                private static T Id<T>(T value) => value;
                public static object Result(string? maybe) => Id<(object, object)>(((maybe!, "nested"), "tail"));
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source, nullableContext: NullableContextOptions.Enable);

        Assert.Contains("maybe!!", printed, StringComparison.Ordinal);
        TranslationDiagnostic site = Assert.Single(sites);
        Assert.Equal(Expected(source, "maybe!"), Position(site));
        Assert.StartsWith(
            "kind=forgiven,explicit-type-argument | target=C.Id<(object, object)>((object, object)) parameter 'value' | slot-type=object (NotAnnotated)",
            site.Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void RebuiltTupleIndexKey_ReportsEachDistinctAssertedLeaf()
    {
        string source = """
            using System.Collections.Generic;
            public static class C
            {
                private static string Branch() => null;
                public static bool Lookup()
                {
                    var key = (Branch(), Branch());
                    return new Dictionary<(string, string), bool>()[key];
                }
            }
            """;
        (string printed, List<TranslationDiagnostic> sites) = Translate(source);

        Assert.Contains("key.Item1!!", printed, StringComparison.Ordinal);
        Assert.Contains("key.Item2!!", printed, StringComparison.Ordinal);
        Assert.Equal(2, sites.Count);
        Assert.All(sites, site => Assert.Equal(Expected(source, "key];"), Position(site)));
        Assert.Equal(new[] { "key.Item1", "key.Item2" }, sites.Select(
            site => site.Message.Substring(site.Message.IndexOf(" | value=", StringComparison.Ordinal) + " | value=".Length)));
    }

    [Fact]
    public void ReportOnce_DistinguishesSyntheticLeavesAndCollapsesRepeatedLeaves()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", "class C { }") });
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Location location = document.GetRoot().GetLocation();

        context.ReportOnce(new TranslationDiagnostic("k", "first", location, TranslationSeverity.Warning) { DiagnosticId = "X" }, ".Item1");
        context.ReportOnce(new TranslationDiagnostic("k", "repeat", location, TranslationSeverity.Warning) { DiagnosticId = "X" }, ".Item1");
        context.ReportOnce(new TranslationDiagnostic("k", "second", location, TranslationSeverity.Warning) { DiagnosticId = "X" }, ".Item2");

        Assert.Equal(new[] { "first", "second" }, context.Diagnostics.Select(diagnostic => diagnostic.Message));
    }

    [Fact]
    public void ReportOnce_KeepsOneDiagnosticPerIdAndPosition()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", "class C { }") });
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Location location = document.GetRoot().GetLocation();

        context.ReportOnce(new TranslationDiagnostic("k", "first", location, TranslationSeverity.Warning) { DiagnosticId = "X" });
        context.ReportOnce(new TranslationDiagnostic("k", "again", location, TranslationSeverity.Warning) { DiagnosticId = "X" });
        context.ReportOnce(new TranslationDiagnostic("k", "other id", location, TranslationSeverity.Warning) { DiagnosticId = "Y" });

        // Without a source location or an id there is nothing to compare, so
        // nothing is deduplicated.
        context.ReportOnce(new TranslationDiagnostic("k", "no id 1", location, TranslationSeverity.Warning));
        context.ReportOnce(new TranslationDiagnostic("k", "no id 2", location, TranslationSeverity.Warning));
        context.ReportOnce(new TranslationDiagnostic("k", "no location 1", null, TranslationSeverity.Warning) { DiagnosticId = "X" });
        context.ReportOnce(new TranslationDiagnostic("k", "no location 2", null, TranslationSeverity.Warning) { DiagnosticId = "X" });

        Assert.Equal(
            new[] { "first", "other id", "no id 1", "no id 2", "no location 1", "no location 2" },
            context.Diagnostics.Select(d => d.Message));
    }

    [Fact]
    public async Task TranslateStage_WritesEverySiteToTranslateLog_AndTheAppPasses()
    {
        string projectDir = Path.Combine(AppContext.BaseDirectory, "loader-tests", "typeparam-slot-bridge", Guid.NewGuid().ToString("N"));
        string outRoot = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "typeparam-slot-bridge", Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(projectDir);
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
            string projectPath = Path.Combine(projectDir, "Bridges.csproj");
            File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
      <PropertyGroup>
        <OutputType>Library</OutputType>
        <TargetFramework>net10.0</TargetFramework>
      </PropertyGroup>
    </Project>
    ");
            File.WriteAllText(Path.Combine(projectDir, "Probe.cs"), """
                using System.Collections.Generic;

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
                }
                """);

            Directory.CreateDirectory(outRoot);
            var pipeline = new MigrationPipeline(
                new PipelineOptions { OutputRoot = outRoot },
                new IMigrationStage[] { new TranslateStage() });
            RunResult result = await pipeline.RunAsync(new[] { new CorpusApp("test/TypeParamSlotBridge", projectPath, TargetKind.Library) });

            AppResult app = Assert.Single(result.Apps);
            Assert.True(app.Succeeded, app.FailureCategory);
            string translateLog = File.ReadAllText(
                Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)));
            Assert.Contains(
                CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId + " (non-fatal): ",
                translateLog,
                StringComparison.Ordinal);
            Assert.Contains("Probe.cs(7,18): GenericStoreBridge: kind=constructed-generic-member", translateLog, StringComparison.Ordinal);
        }
        finally
        {
            DeleteDirectory(projectDir);
            DeleteDirectory(outRoot);
        }
    }

    private static (string Printed, List<TranslationDiagnostic> Sites) Translate(
        string source,
        IReadOnlyList<MetadataReference> references = null,
        NullableContextOptions nullableContext = NullableContextOptions.Disable)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Probe.cs", source) }, references);
        Assert.True(
            project.BoundWithoutErrors,
            "Source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument originalDocument = Assert.Single(project.Documents);
        CSharpCompilation compilation = project.Compilation.WithOptions(
            project.Compilation.Options.WithNullableContextOptions(nullableContext));
        var document = new LoadedDocument(
            originalDocument.FilePath,
            originalDocument.SyntaxTree,
            compilation.GetSemanticModel(originalDocument.SyntaxTree));
        var context = new TranslationContext(compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        List<TranslationDiagnostic> sites = context.Diagnostics
            .Where(d => d.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId)
            .ToList();
        return (printed, sites);
    }

    private static void DeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Best effort: a locked or protected file must not fail the test.
            // DirectoryNotFoundException and PathTooLongException are IOExceptions.
        }
    }

    // The 1-based line:column of the first occurrence of `marker` in `source`.
    private static string Expected(string source, string marker)
    {
        int offset = source.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(offset >= 0, marker);
        string before = source.Substring(0, offset);
        int line = before.Count(c => c == '\n') + 1;
        int column = offset - (before.LastIndexOf('\n') + 1) + 1;
        return $"{line}:{column}";
    }

    private static string Position(TranslationDiagnostic diagnostic)
    {
        FileLinePositionSpan span = diagnostic.Location.GetLineSpan();
        return $"{span.StartLinePosition.Line + 1}:{span.StartLinePosition.Character + 1}";
    }
}
