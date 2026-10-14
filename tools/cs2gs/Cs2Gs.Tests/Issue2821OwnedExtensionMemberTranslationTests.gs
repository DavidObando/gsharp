// <copyright file="Issue2821OwnedExtensionMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

open class Issue2821OwnedExtensionMemberTranslationTests {
    @Fact
    func OwnedStructInstanceMethods_StayInsideTypeBody() {
        let printed = TranslateFiles(("Value.cs", `
namespace Demo;

public readonly record struct Value(int Number)
{
    public int Double() => Number * 2;

    public override string ToString() => Number.ToString();
}`))["Value.cs"]
        Assert.Contains("data struct Value", printed)
        Assert.Contains("    func Double()", printed)
        Assert.Contains("    func ToString()", printed)
        Assert.DoesNotContain("override func ToString()", printed)
        Assert.DoesNotContain("func (self Value)", printed)
        Assert.DoesNotContain("func (self Value) ToString", printed)
        let diagnostics = BindDiagnostics([]string{printed})
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func SamePackageExtension_OnSplitPartialType_MovesIntoOwnedType() {
        let printed = TranslateFiles(("A.Target.cs", `
namespace Demo;

public partial class Meter
{
    public int Value;
}`), ("B.Target.cs", `
namespace Demo;

public partial class Meter
{
    public int Double() => Value * 2;
}`), ("Extensions.cs", `
using System;

namespace Demo;

public static class MeterExtensions
{
    public static int Adjust(this Meter meter) =>
        meter.Value >= 0 ? meter.Value : throw new InvalidOperationException();
}`))
        let combined = string.Join(Environment.NewLine, printed.Values)
        let holder = printed["Extensions.cs"]
        Assert.Equal(2, CountOccurrences(combined, "partial class Meter {"))
        Assert.Equal(1, CountOccurrences(combined, " Adjust()"))
        Assert.Contains("import System", holder)
        Assert.Contains("func (meter Meter) Adjust()", holder)
        Assert.Contains("class MeterExtensions", holder)
        Assert.Contains("@ExtensionOwner(typeof(MeterExtensions))", combined)
    }

    @Fact
    func OwnedExtensionLiftedHelpers_UseOriginalHolderNameRegistry() {
        let printed = TranslateFiles(("Target.cs", `namespace Demo;

public partial class C
{
    public int Helper(int value) => -value;
}`), ("Extensions.cs", `namespace Demo;

public static class Extensions
{
    public static int Extra(this C receiver, int value)
    {
        return Helper(value);
        static int Helper(int n) => n == 0 ? 0 : Other<int>(n - 1);
        static int Other<T>(int n) => Helper(n);
    }

    public static int Other(this C receiver, string value) => value.Length;

    public static int Count(this C receiver, int value)
    {
        int offset = 1;
        return First(value);
        int First(int n) => n == 0 ? offset : Second(n - 1);
        int Second(int n) => First(n);
    }
}`))
        let combined = string.Join(Environment.NewLine, printed.Values)
        Assert.Contains("func Helper(value int32)", combined, StringComparison.Ordinal)
        Assert.Contains("func Helper(", combined, StringComparison.Ordinal)
        Assert.Contains("func Other_2[", combined, StringComparison.Ordinal)
        Assert.Contains("class Extensions", combined, StringComparison.Ordinal)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ArityDisjointInstanceOverload_DoesNotBlockOwnedLowering() {
        let printed = TranslateFiles(("Host.cs", `
namespace Demo;

public sealed class Host
{
    public int M() => 1;
}`), ("Extensions.cs", `
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, int value) => value;
}`))
        let combined = string.Join(Environment.NewLine, printed.Values)
        let host = printed["Host.cs"]
        Assert.Contains("func M()", host)
        Assert.DoesNotContain("func M(value int32)", host)
        Assert.Contains("func (host Host) M(value int32)", combined)
        Assert.Contains("@ExtensionOwner(typeof(HostExtensions))", combined)
        Assert.Contains("class HostExtensions", combined)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> (diagnostic.Id is "GS0264" or "GS0314")
        )
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ApplicableInstanceOverload_RetainsReceiverClause() {
        let printed = TranslateFiles(("Host.cs", `
namespace Demo;

public sealed class Host
{
    public int M(object value) => 1;
}`), ("Extensions.cs", `
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, string value) => value.Length;
}`))
        Assert.DoesNotContain("func M(value string)", printed["Host.cs"])
        Assert.Contains("func (host Host) M(value string)", printed["Extensions.cs"])
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0314"
        )
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0264"
        )
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func InterfaceInstanceAndExtensionOverloads_RetainReceiverClause() {
        let printed = TranslateFiles(("Host.cs", `
namespace Demo;

public interface IA
{
}

public interface IB
{
}

public sealed class Both : IA, IB
{
}

public sealed class Host
{
    public int M(IA value) => 1;
}`), ("Extensions.cs", `
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, IB value) => 2;
}`), ("User.cs", `
namespace Demo;

public static class User
{
    public static int Run(Host host, Both value) => host.M(value);
}`))
        Assert.Contains("func M(value IA)", printed["Host.cs"])
        Assert.DoesNotContain("func M(value IB)", printed["Host.cs"])
        Assert.Contains("func (host Host) M(value IB)", printed["Extensions.cs"])
        Assert.Contains("host.M(value)", printed["User.cs"])
    }

    @Fact
    func ExactReducedSignatureCollision_StaysStatic() {
        let printed = TranslateFiles(("Host.cs", `
namespace Demo;

public sealed class Host
{
    public int M(int value) => value;
}`), ("Extensions.cs", `
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, int value) => value + 1;
}`), ("User.cs", `
namespace Demo;

public static class User
{
    public static int Run(Host host) => HostExtensions.M(host, 1);
}`))
        let combined = string.Join(Environment.NewLine, printed.Values)
        Assert.Contains("class HostExtensions", combined)
        Assert.Contains("func M(host Host, value int32)", printed["Extensions.cs"])
        Assert.DoesNotContain("func (host Host) M", combined)
        Assert.Contains("HostExtensions.M(host, 1)", printed["User.cs"])
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> (diagnostic.Id is "GS0264" or "GS0314")
        )
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func DistinctOverloads_FromDifferentStaticClasses_StayStatic() {
        let printed = TranslateFiles(("Host.cs", `
namespace Demo;

public sealed class Host
{
}`), ("FirstExtensions.cs", `
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host, object value) => "object";
}`), ("SecondExtensions.cs", `
namespace Demo;

public static class SecondExtensions
{
    public static string Describe(this Host host, string value) => "string";
}`), ("User.cs", `
namespace Demo;

public static class User
{
    public static string Run(Host host, string value) =>
        FirstExtensions.Describe(host, value) +
        SecondExtensions.Describe(host, value) +
        host.Describe(value);
}`))
        let combined = string.Join(Environment.NewLine, printed.Values)
        Assert.Contains("class FirstExtensions", combined)
        Assert.Contains("class SecondExtensions", combined)
        Assert.Contains("func Describe(host Host, value object)", printed["FirstExtensions.cs"])
        Assert.Contains("func Describe(host Host, value string)", printed["SecondExtensions.cs"])
        Assert.Contains("func (host Host) Describe(value object)", printed["FirstExtensions.cs"])
        Assert.Contains("func (host Host) Describe(value string)", printed["SecondExtensions.cs"])
        Assert.DoesNotContain("func Describe(value ", printed["Host.cs"])
        Assert.Contains("FirstExtensions.Describe(host, value)", printed["User.cs"])
        Assert.Contains("SecondExtensions.Describe(host, value)", printed["User.cs"])
        Assert.Contains("host.Describe(value)", printed["User.cs"])
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> (diagnostic.Id is "GS0264" or "GS0314")
        )
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func DuplicateReducedSignatures_FromDifferentStaticClasses_StayStatic() {
        let printed = TranslateFiles(("Host.cs", `
namespace Demo;

public sealed class Host
{
}`), ("FirstExtensions.cs", `
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host, int value) => "first";
}`), ("SecondExtensions.cs", `
namespace Demo;

public static class SecondExtensions
{
    public static string Describe(this Host host, int value) => "second";
}`), ("User.cs", `
namespace Demo;

public static class User
{
    public static string Run(Host host) =>
        FirstExtensions.Describe(host, 1) + SecondExtensions.Describe(host, 2);
}`))
        let combined = string.Join(Environment.NewLine, printed.Values)
        Assert.Contains("class FirstExtensions", combined)
        Assert.Contains("class SecondExtensions", combined)
        Assert.Equal(2, CountOccurrences(combined, "func Describe(host Host, value int32)"))
        Assert.DoesNotContain("func (host Host) Describe", combined)
        Assert.DoesNotContain("func Describe(value int32)", printed["Host.cs"])
        Assert.Contains("FirstExtensions.Describe(host, 1)", printed["User.cs"])
        Assert.Contains("SecondExtensions.Describe(host, 2)", printed["User.cs"])
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(
            diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> (diagnostic.Id is "GS0264" or "GS0314")
        )
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func CrossProjectStaticHelpers_PreserveInvocationStaticAndMethodGroupForms() {
        let producer = CSharpProjectLoader.LoadInMemory([](string, string){("Producer.cs", `
namespace Demo;

public sealed class Host
{
}

public static class FirstExtensions
{
    public static string Describe(this Host host, object value) => "object";
}

public static class SecondExtensions
{
    public static string Describe(this Host host, string value) => "string";
}`)}, CSharpProjectLoader.RuntimeReferences(), "Producer")
        using let image = MemoryStream()
        let emit = producer.Compilation.Emit(image)
        Assert.True(
            emit.Success,
            "Producer should emit with no C# errors: " + string.Join(Environment.NewLine, emit.Diagnostics)
        )
        let producerReference MetadataReference = MetadataReference.CreateFromImage(image.ToArray())
        let consumer = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", `
using System;
using Demo;

namespace Client;

public static class User
{
    public static string Invoke(Host host, string value) => host.Describe(value);

    public static string Static(Host host, string value) =>
        SecondExtensions.Describe(host, value);

    public static Func<string, string> BindString(Host host) => host.Describe;

    public static Func<object, string> BindObject(Host host) => host.Describe;
}`)}, CSharpProjectLoader.RuntimeReferences().Append(producerReference).ToList(), "Consumer")
        Assert.True(
            consumer.BoundWithoutErrors,
            "Consumer should bind with no C# errors: " + string.Join(Environment.NewLine, consumer.ErrorDiagnostics)
        )
        let siblings = []CSharpCompilation{producer.Compilation, consumer.Compilation}
        let printedProducer = TranslateProject(producer, siblings)
        let printedConsumer = TranslateProject(consumer, siblings)
        let compactConsumer = Compact(printedConsumer)
        Assert.Contains("func (host Host) Describe(value object)", printedProducer)
        Assert.Contains("func (host Host) Describe(value string)", printedProducer)
        Assert.Contains("SecondExtensions.Describe(host, value)", compactConsumer)
        Assert.Contains("host.Describe(value)", compactConsumer)
        Assert.Contains("host.Describe", compactConsumer)
        Assert.DoesNotContain("__spill", compactConsumer)
        let diagnostics = BindDiagnostics([]string{printedProducer, printedConsumer})
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalStaticHelper_EvaluatesReceiverOnce() {
        let printed = TranslateFiles(("Host.cs", `
#nullable enable
namespace Demo;

public sealed class Host
{
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host) => "first";
}

public static class SecondExtensions
{
    public static string Describe(this Host host, int value) => "second";
}`), ("User.cs", `
#nullable enable
namespace Demo;

public static class User
{
    public static Host? GetHost() => null;

    public static string Run() => GetHost()?.Describe() ?? "none";
}`))
        let user = Compact(printed["User.cs"])
        Assert.Equal(1, CountOccurrences(user, "GetHost()?"))
        Assert.Contains("GetHost()?.Describe()", user)
        Assert.DoesNotContain("__spill", user)
        Assert.DoesNotContain("FirstExtensions.Describe", user)
        Assert.DoesNotContain("if GetHost() != nil", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalVoidStaticHelper_UsesStatementGuard() {
        let printed = TranslateFiles(("Host.cs", `
#nullable enable
namespace Demo;

public sealed class Host
{
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static void Touch(this Host host)
    {
    }
}

public static class SecondExtensions
{
    public static void Touch(this Host host, int value)
    {
    }
}`), ("User.cs", `
#nullable enable
namespace Demo;

public static class User
{
    public static void Run(Host? host) => host?.Touch();
}`))
        let user = Compact(printed["User.cs"])
        Assert.Contains("host?.Touch()", user)
        Assert.DoesNotContain("else { nil }", user)
        Assert.DoesNotContain("default(void", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalVoidStaticHelper_InSyncActionLambda_UsesStatementGuard() {
        let printed = TranslateFiles(("Host.cs", `
#nullable enable
namespace Demo;

public sealed class Host
{
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static void Touch(this Host host)
    {
    }
}

public static class SecondExtensions
{
    public static void Touch(this Host host, int value)
    {
    }
}`), ("User.cs", `
#nullable enable
using System;

namespace Demo;

public static class User
{
    public static Host? GetHost() => null;

    public static Action Bind() => () => GetHost()?.Touch();
}`))
        let user = Compact(printed["User.cs"])
        Assert.Equal(1, CountOccurrences(user, "GetHost()?"))
        Assert.Contains("() -> GetHost()?.Touch()", user)
        Assert.DoesNotContain("__spill", user)
        Assert.DoesNotContain("FirstExtensions.Touch", user)
        Assert.DoesNotContain("default(void", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalStaticHelper_UsesTypedDefaultsForCompositeResults() {
        let printed = TranslateFiles(("Host.cs", `
#nullable enable
namespace Demo;

public sealed class Host
{
}`), ("Extensions.cs", `
#nullable enable
using System;
using System.Collections.Generic;

namespace Demo;

public static class FirstExtensions
{
    public static List<int> Items(this Host host) => throw new InvalidOperationException();

    public static int[] Values(this Host host) => throw new InvalidOperationException();

    public static (int, string) Pair(this Host host) => throw new InvalidOperationException();

    public static Func<int, string> Formatter(this Host host) =>
        throw new InvalidOperationException();
}

public static class SecondExtensions
{
    public static List<int> Items(this Host host, int value) => throw new InvalidOperationException();

    public static int[] Values(this Host host, int value) => throw new InvalidOperationException();

    public static (int, string) Pair(this Host host, int value) => throw new InvalidOperationException();

    public static Func<int, string> Formatter(this Host host, int value) =>
        throw new InvalidOperationException();
}`), ("User.cs", `
#nullable enable
using System;
using System.Collections.Generic;

namespace Demo;

public static class User
{
    public static List<int>? Items(Host? host) => host?.Items();

    public static int[]? Values(Host? host) => host?.Values();

    public static (int, string)? Pair(Host? host) => host?.Pair();

    public static Func<int, string>? Formatter(Host? host) => host?.Formatter();
}`))
        let user = Compact(printed["User.cs"])
        Assert.Contains("host?.Items()", user)
        Assert.Contains("host?.Values()", user)
        Assert.Contains("host?.Pair()", user)
        Assert.Contains("host?.Formatter()", user)
        Assert.DoesNotContain("default(", user)
        Assert.DoesNotContain("FirstExtensions.", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalStaticHelper_ChainedReceiverKeepsWholePrefix() {
        let printed = TranslateFiles(("Config.cs", `
#nullable enable
namespace Demo;

public sealed class Config
{
    public Options Options = new Options();
}

public sealed class Options
{
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Options options) => "first";
}

public static class SecondExtensions
{
    public static string Describe(this Options options, int value) => "second";
}`), ("User.cs", `
#nullable enable
namespace Demo;

public static class User
{
    public static Config? GetConfig() => null;

    public static string Run() => GetConfig()?.Options.Describe() ?? "none";
}`))
        let user = Compact(printed["User.cs"])
        Assert.Equal(1, CountOccurrences(user, "GetConfig()?"))
        Assert.Contains("GetConfig()?.Options.Describe()", user)
        Assert.DoesNotContain("__spill", user)
        Assert.DoesNotContain("FirstExtensions.Describe", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalStaticHelper_NestedConditionalChain_BailsWithoutBareSpill() {
        let printed = TranslateFiles(("Host.cs", `
#nullable enable
namespace Demo;

public sealed class Root
{
    public Host? Host;

    public Host? GetHost() => Host;
}

public sealed class Host
{
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host) => "first";
}

public static class SecondExtensions
{
    public static string Describe(this Host host, int value) => "second";
}`), ("User.cs", `
#nullable enable
namespace Demo;

public static class User
{
    public static string Field(Root? root) => root?.Host?.Describe() ?? "none";

    public static string Call(Root? root) => root?.GetHost()?.Describe() ?? "none";
}`))
        let user = Compact(printed["User.cs"])
        Assert.Contains(".Host?.Describe()", user)
        Assert.Contains(".GetHost()?.Describe()", user)
        Assert.DoesNotContain("let __spill = .", user)
        Assert.DoesNotContain("FirstExtensions.Describe(.", user)
    }

    @Fact
    func NullConditionalStaticHelper_ChainedPrefixUsesNormalMemberTranslation() {
        let printed = TranslateFiles(("Types.cs", `
#nullable enable
namespace Demo;

public readonly struct Node
{
}

public sealed class Holder
{
    public Node Value;
}

public sealed class Config
{
    public (Node Node, int Other) Pair;

    public Node? Maybe;

    public Holder Holder = new Holder();
}

public static class HolderExtensions
{
    extension(Holder holder)
    {
        public Node Current => holder.Value;
    }
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Node node) => "first";
}

public static class SecondExtensions
{
    public static string Describe(this Node node, int value) => "second";
}`), ("User.cs", `
#nullable enable
namespace Demo;

public static class User
{
    public static string Tuple(Config? config) =>
        config?.Pair.Node.Describe() ?? "none";

    public static string Nullable(Config? config) =>
        config?.Maybe.Value.Describe() ?? "none";

    public static string ExtensionProperty(Config? config) =>
        config?.Holder.Current.Describe() ?? "none";
}`))
        let user = Compact(printed["User.cs"])
        Assert.Equal(3, CountOccurrences(user, ".Describe()"))
        // ADR-0172: the named element access stays by-name.
        Assert.Contains(".Pair.Node.Describe()", user)
        Assert.Contains(".Maybe!!.Describe()", user)
        Assert.Contains(".Holder.Current().Describe()", user)
        Assert.DoesNotContain("FirstExtensions.Describe", user)
        Assert.DoesNotContain(".Pair.Item1", user)
        Assert.DoesNotContain(".Maybe.Value", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullConditionalStaticHelper_ChainedPrefixPreservesPointerAccess() {
        let printed = TranslateFilesRoundTripOnly(
            "Managed pointer member chains remain outside current G# binding support.",
            ("Types.cs", `
#nullable enable
namespace Demo;

public struct Node
{
}

public struct PointerHolder
{
    public Node Value;
}

public sealed unsafe class Config
{
    public PointerHolder* Pointer;
}`),
            ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Node node) => "first";
}

public static class SecondExtensions
{
    public static string Describe(this Node node, int value) => "second";
}`),
            ("User.cs", `
#nullable enable
namespace Demo;

public static class User
{
    public static unsafe string Run(Config? config) =>
        config?.Pointer->Value.Describe() ?? "none";
}`)
        )
        let user = Compact(printed["User.cs"])
        Assert.Contains(".Pointer->Value.Describe()", user)
        Assert.DoesNotContain("FirstExtensions.Describe", user)
        Assert.DoesNotContain(".Pointer.Value", user)
    }

    @Fact
    func RefReceiverStaticHelper_PassesReceiverAddress() {
        let printed = TranslateFiles(("Counter.cs", `
namespace Demo;

public struct Counter
{
    public int Value;
}`), ("Extensions.cs", `
namespace Demo;

public static class FirstExtensions
{
    public static void Increment(this ref Counter counter) => counter.Value++;
}

public static class SecondExtensions
{
    public static void Increment(this ref Counter counter, int amount) =>
        counter.Value += amount;
}`), ("User.cs", `
namespace Demo;

public static class User
{
    public static void Run(ref Counter counter) => counter.Increment();
}`))
        Assert.Contains("FirstExtensions.Increment(&counter)", Compact(printed["User.cs"]))
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func NullableStaticHelperReceivers_PreserveNullForgiveness() {
        let printed = TranslateFiles(("Host.cs", `
#nullable enable
namespace Demo;

public sealed class Host
{
}`), ("Extensions.cs", `
#nullable enable
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host, object value) => "object";
}

public static class SecondExtensions
{
    public static string Describe(this Host host, string value) => "string";
}`), ("User.cs", `
#nullable enable
using System;

namespace Demo;

public sealed class User
{
    public Host? Current;

    public string Invoke(string value) => Current.Describe(value);

    public Func<string, string> Bind() => Current.Describe;
}`))
        let user = Compact(printed["User.cs"])
        Assert.Contains("Current!!.Describe(value)", user)
        Assert.Contains("Current!!.Describe", user)
        Assert.DoesNotContain("__spill", user)
        Assert.DoesNotContain("SecondExtensions.Describe(Current", user)
        let diagnostics = BindDiagnostics(printed.Values)
        Assert.DoesNotContain(diagnostics, (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
    }

    @Fact
    func ExternalReceiver_RetainsReceiverClause() {
        let printed = TranslateFiles(("Extensions.cs", `
namespace Demo;

public static class TextExtensions
{
    public static int TwiceLength(this string value) => value.Length * 2;
}`))["Extensions.cs"]
        Assert.Contains("func (value string) TwiceLength()", printed)
    }

    @Fact
    func OpenGenericOwnedReceiver_RetainsReceiverClause() {
        let printed = TranslateFiles(("Box.cs", `
namespace Demo;

public sealed class Box<T>
{
    public T Value;
}`), ("Extensions.cs", `
namespace Demo;

public static class BoxExtensions
{
    public static T Read<T>(this Box<T> box) => box.Value;
}`))
        Assert.Contains("func (box Box[T]) Read[T]()", printed["Extensions.cs"])
        Assert.DoesNotContain("func Read", printed["Box.cs"])
    }

    @Fact
    func ClosedGenericOwnedReceiver_RetainsReceiverClause() {
        let printed = TranslateFiles(("Box.cs", `
namespace Demo;

public sealed class Box<T>
{
    public T Value;
}`), ("Extensions.cs", `
namespace Demo;

public static class BoxExtensions
{
    public static int Read(this Box<int> box) => box.Value;
}`))
        Assert.Contains("func (box Box[int32]) Read()", printed["Extensions.cs"])
        Assert.DoesNotContain("func Read", printed["Box.cs"])
    }

    @Fact
    func ExcludedGeneratedExtension_DoesNotMoveIntoRetainedTarget() {
        let printed = TranslateFiles(CSharpToGSharpTranslator(retainedFilePaths: []string{"Target.cs"}), ("Target.cs", `
namespace Demo;

public partial class Meter
{
    public int Value;
}`), ("GeneratedExtensions.cs", `
namespace Demo;

public static class MeterExtensions
{
    public static int Adjust(this Meter meter) => meter.Value;
}`))
        Assert.DoesNotContain("func Adjust(", printed["Target.cs"])
    }

    shared {
        private func TranslateFiles(files ...(FileName string, Source string)) IReadOnlyDictionary[string, string] {
            return TranslateFiles(CSharpToGSharpTranslator(), roundTripOnlyReason: nil, files)
        }

        private func TranslateFilesRoundTripOnly(
            reason string,
            files ...(FileName string, Source string)
        ) IReadOnlyDictionary[string, string] {
            return TranslateFiles(CSharpToGSharpTranslator(), reason, files)
        }

        private func TranslateFiles(
            translator CSharpToGSharpTranslator,
            files ...(FileName string, Source string)
        ) IReadOnlyDictionary[string, string] {
            return TranslateFiles(translator, roundTripOnlyReason: nil, files)
        }

        private func TranslateFiles(
            translator CSharpToGSharpTranslator,
            roundTripOnlyReason string?,
            files ...(FileName string, Source string)
        ) IReadOnlyDictionary[string, string] {
            let project = CSharpProjectLoader.LoadInMemory(files)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let result = Dictionary[string, string](StringComparer.Ordinal)
            for document in project.Documents {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = translator.TranslateDocument(document, context)
                let printed = GSharpPrinter.Print(unit)
                result.Add(document.FilePath, printed)
            }
            if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(result.Values.ToArray())
            } else {
                for source in result.Values {
                    let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(source, roundTripOnlyReason)
                    Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
                }
            }
            return result
        }

        private func BindDiagnostics(sources IEnumerable[string]) ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic] {
            let trees = sources.Select(
                (source string) -> GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))
            )
                .ToImmutableArray()
            let scope_ = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(previous: nil, trees)
            return scope_
                .Diagnostics
                .Concat(GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(scope_).Diagnostics)
                .ToImmutableArray()
        }

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let translator = CSharpToGSharpTranslator()
            let output = List[string]()
            for document in project.Documents {
                let context = TranslationContext(
                    project.Compilation,
                    document.SemanticModel,
                    document.FilePath,
                    siblingCompilations
                )
                output.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)))
            }
            return string.Join(Environment.NewLine, output)
        }

        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }
    }
}
