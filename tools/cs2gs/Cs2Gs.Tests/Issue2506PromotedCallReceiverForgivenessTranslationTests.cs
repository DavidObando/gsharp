// <copyright file="Issue2506PromotedCallReceiverForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for issue #2506: in a nullable-oblivious compilation,
/// a same-project method or local-function return promoted to <c>T?</c> must be
/// forgiven when its call is used as an ordinary receiver. The assertion
/// preserves C#'s throw-on-null behavior and must not spread into null-tolerant
/// or expression-tree contexts.
/// </summary>
public sealed class Issue2506PromotedCallReceiverForgivenessTranslationTests
{
    [Fact]
    public void PromotedCalls_OrdinaryReceiverShapes_AssertAtEachReceiver()
    {
        string printed = Translate("""
            using System;
            using System.Collections.Generic;

            namespace Demo;

            public class Item
            {
                public string Name => "item";
                public string Read() => Name;
                public string this[int index] => Name;
                public Item Next() => null;
            }

            public static class ItemExtensions
            {
                public static string ExtensionName(this Item item) => item.Name;
                public static Item NextExtension(this Item item) => null;
            }

            public sealed class Holder
            {
                public Item Child => null;
                public Item this[int index] => null;
            }

            public static class Repro
            {
                private static Item Find() => null;
                private static Item Always() => new();
                private static IEnumerable<Item> FindMany() => null;
                private static Func<Item> FindFactory() => null;
                private static Holder GetHolder() => new();
                private static T FindGeneric<T>() where T : class => null;

                public static string Property() => Find().Name;
                public static string Method() => Find().Read();
                public static string Indexer() => Find()[0];
                public static string Extension() => Find().ExtensionName();
                public static string ExtensionResult() => Find().NextExtension().Name;
                public static string Chain() => Find().Next().Name;
                public static string PropertyResult() => GetHolder().Child.Name;
                public static string IndexerResult() => GetHolder()[0].Name;
                public static string GenericResult() => FindGeneric<Item>().Name;
                public static string DelegateInvoke() => FindFactory().Invoke().Name;
                public static string DirectDelegateInvoke() => FindFactory()().Name;
                public static string Parenthesized() => (Find()).Name;
                public static string Cast() => ((Item)Find()).Name;
                public static string Conditional(bool condition) =>
                    (condition ? Find() : Always()).Name;

                public static string LocalFunction()
                {
                    Item LocalFind() => null;
                    return LocalFind().Name;
                }

                public static int Enumerate()
                {
                    var count = 0;
                    foreach (var item in FindMany())
                        count++;
                    return count;
                }
            }
            """);

        Assert.Contains("Repro.Find()!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Find()!!.Read()", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Find()!![0]", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Find().ExtensionName()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Repro.Find()!!.ExtensionName()", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Find().NextExtension()!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.Find()!!.Next()!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.GetHolder().Child!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.GetHolder()[0]!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("FindGeneric[Item]()!!.Name", printed, StringComparison.Ordinal);
        Assert.Equal(2, CountOccurrences(printed, "Repro.FindFactory()!!().Name"));
        Assert.Contains("(Repro.Find())!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("(Item(Repro.Find()!!)).Name", printed, StringComparison.Ordinal);
        Assert.Contains(
            "(if condition { Repro.Find() } else { Repro.Always() })!!.Name",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("LocalFind()!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("for item in Repro.FindMany()!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void PromotedDirectCall_AssertsAndEvaluatesOnce()
    {
        string printed = Translate("""
            namespace Demo;

            public sealed class Item
            {
                public string Name => "item";
            }

            public static class Repro
            {
                private static Item Find() => null;

                public static string Direct() => Find().Name;
            }
            """);

        Assert.Contains("Repro.Find()!!.Name", printed, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(printed, "Repro.Find()"));
    }

    [Fact]
    public void PromotedLocal_ControlExistingLocalReceiverForgiveness()
    {
        string printed = Translate("""
            namespace Demo;

            public sealed class Item
            {
                public string Name => "item";
            }

            public static class Repro
            {
                private static Item Find() => null;

                public static string ThroughLocal()
                {
                    var item = Find();
                    return item.Name;
                }
            }
            """);

        Assert.Contains("item!!.Name", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void AwaitedPromotedResult_AssertsBeforeMemberAccess()
    {
        string printed = Translate("""
            using System.Threading.Tasks;

            namespace Demo;

            public sealed class Item
            {
                public string Name => "item";
            }

            public static class Repro
            {
                private static async Task<Item> FindAsync() => null;

                public static async Task<string> Awaited() => (await FindAsync()).Name;
                public static string Envelope() => FindAsync().ToString();
            }
            """);

        Assert.Contains("(await Repro.FindAsync())!!.Name", printed, StringComparison.Ordinal);
        Assert.Contains("Repro.FindAsync().ToString()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Repro.FindAsync()!!.ToString()", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void UsingPromotedResource_ControlRemainsNullTolerant()
    {
        string printed = Translate("""
            using System;

            namespace Demo;

            public sealed class Resource : IDisposable
            {
                public void Dispose() { }
            }

            public static class Repro
            {
                private static Resource Open() => null;

                public static void Use()
                {
                    using (Open())
                    {
                    }
                }
            }
            """);

        Assert.Contains("using let __using = Repro.Open()", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Repro.Open()!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ConditionalAccessNullableEnabledFlowAndExpressionTrees_AvoidObliviousOverAssertion()
    {
        string oblivious = Translate("""
            using System;
            using System.Linq.Expressions;

            namespace Demo;

            public sealed class Item
            {
                public string Name => "item";
            }

            public static class Repro
            {
                private static Item Find() => null;

                public static string Conditional() => Find()?.Name;
                public static Expression<Func<string>> Tree() => () => Find().Name;
            }
            """);

        Assert.Contains("Repro.Find()?.Name", oblivious, StringComparison.Ordinal);
        Assert.DoesNotContain("Repro.Find()!!?.Name", oblivious, StringComparison.Ordinal);
        Assert.Contains("Repro.Find().Name", oblivious, StringComparison.Ordinal);
        Assert.DoesNotContain("() -> Repro.Find()!!.Name", oblivious, StringComparison.Ordinal);

        string enabled = Translate("""
            #nullable enable
            namespace Demo;

            public sealed class Item
            {
                public string Name => "item";
            }

            public static class Repro
            {
                private static Item? ExplicitMaybe() => null;
                private static Item Always() => new();

                public static string ExplicitContract() => ExplicitMaybe().Name;
                public static string SuppressedContract() => ExplicitMaybe()!.Name;
                public static string NonNullContract() => Always().Name;

                public static string Guarded()
                {
                    var item = ExplicitMaybe();
                    if (item is null)
                        return "";
                    return item.Name;
                }
            }
            """);

        Assert.Contains("Repro.ExplicitMaybe().Name", enabled, StringComparison.Ordinal);
        Assert.Contains("Repro.ExplicitMaybe()!!.Name", enabled, StringComparison.Ordinal);
        Assert.Contains("Repro.Always().Name", enabled, StringComparison.Ordinal);
        Assert.DoesNotContain("Repro.Always()!!.Name", enabled, StringComparison.Ordinal);
        Assert.Contains("item!!.Name", enabled, StringComparison.Ordinal);
    }

    [Fact]
    public void InterfaceBaseAndGenericContracts_ForgivePromotedCallResults()
    {
        string printed = Translate("""
            namespace Demo;

            public class Item
            {
                public string Name => "item";
            }

            public interface IProvider
            {
                Item Find();
            }

            public abstract class ProviderBase
            {
                public abstract Item Find();
            }

            public sealed class Provider : ProviderBase, IProvider
            {
                public override Item Find() => null;
            }

            public static class Repro
            {
                public static string ViaInterface(IProvider provider) => provider.Find().Name;
                public static string ViaBase(ProviderBase provider) => provider.Find().Name;
                public static string ViaGeneric<T>(T provider) where T : IProvider => provider.Find().Name;
            }
            """);

        Assert.Equal(3, CountOccurrences(printed, "provider.Find()!!.Name"));
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int index = text.IndexOf(value, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
