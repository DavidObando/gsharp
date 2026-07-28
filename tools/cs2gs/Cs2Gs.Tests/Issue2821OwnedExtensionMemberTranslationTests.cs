// <copyright file="Issue2821OwnedExtensionMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

public class Issue2821OwnedExtensionMemberTranslationTests
{
    [Fact]
    public void OwnedStructInstanceMethods_StayInsideTypeBody()
    {
        string printed = TranslateFiles(
            ("Value.cs", @"
namespace Demo;

public readonly record struct Value(int Number)
{
    public int Double() => Number * 2;

    public override string ToString() => Number.ToString();
}"))["Value.cs"];

        Assert.Contains("data struct Value", printed);
        Assert.Contains("    func Double()", printed);
        Assert.Contains("    func ToString()", printed);
        Assert.DoesNotContain("override func ToString()", printed);
        Assert.DoesNotContain("func (self Value)", printed);
        Assert.DoesNotContain("func (self Value) ToString", printed);

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(new[] { printed });
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void SamePackageExtension_OnSplitPartialType_MovesIntoOwnedType()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("A.Target.cs", @"
namespace Demo;

public partial class Meter
{
    public int Value;
}"),
            ("B.Target.cs", @"
namespace Demo;

public partial class Meter
{
    public int Double() => Value * 2;
}"),
            ("Extensions.cs", @"
using System;

namespace Demo;

public static class MeterExtensions
{
    public static int Adjust(this Meter meter) =>
        meter.Value >= 0 ? meter.Value : throw new InvalidOperationException();
}"));

        string combined = string.Join(Environment.NewLine, printed.Values);
        string target = Assert.Single(printed.Values, text => text.Contains("class Meter", StringComparison.Ordinal));

        Assert.Equal(1, CountOccurrences(combined, "func Adjust("));
        Assert.Contains("import System", target);
        Assert.Contains("    func Adjust()", target);
        Assert.Contains("var meter = this", target);
        Assert.DoesNotContain("func (meter Meter) Adjust", combined);
        Assert.DoesNotContain("class MeterExtensions", combined);
    }

    [Fact]
    public void ArityDisjointInstanceOverload_DoesNotBlockOwnedLowering()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Host.cs", @"
namespace Demo;

public sealed class Host
{
    public int M() => 1;
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, int value) => value;
}"));

        string combined = string.Join(Environment.NewLine, printed.Values);
        string host = printed["Host.cs"];

        Assert.Contains("func M()", host);
        Assert.Contains("func M(value int32)", host);
        Assert.DoesNotContain("func (host Host) M", combined);
        Assert.DoesNotContain("class HostExtensions", combined);

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(printed.Values);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id is "GS0264" or "GS0314");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ApplicableInstanceOverload_RetainsReceiverClause()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Host.cs", @"
namespace Demo;

public sealed class Host
{
    public int M(object value) => 1;
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, string value) => value.Length;
}"));

        Assert.DoesNotContain("func M(value string)", printed["Host.cs"]);
        Assert.Contains("func (host Host) M(value string)", printed["Extensions.cs"]);

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(printed.Values);
        Assert.Single(diagnostics.Where(diagnostic => diagnostic.Id == "GS0314"));
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0264");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void InterfaceInstanceAndExtensionOverloads_RetainReceiverClause()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Host.cs", @"
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
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, IB value) => 2;
}"),
            ("User.cs", @"
namespace Demo;

public static class User
{
    public static int Run(Host host, Both value) => host.M(value);
}"));

        Assert.Contains("func M(value IA)", printed["Host.cs"]);
        Assert.DoesNotContain("func M(value IB)", printed["Host.cs"]);
        Assert.Contains("func (host Host) M(value IB)", printed["Extensions.cs"]);
        Assert.Contains("host.M(value)", printed["User.cs"]);
    }

    [Fact]
    public void ExactReducedSignatureCollision_StaysStatic()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Host.cs", @"
namespace Demo;

public sealed class Host
{
    public int M(int value) => value;
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class HostExtensions
{
    public static int M(this Host host, int value) => value + 1;
}"),
            ("User.cs", @"
namespace Demo;

public static class User
{
    public static int Run(Host host) => HostExtensions.M(host, 1);
}"));

        string combined = string.Join(Environment.NewLine, printed.Values);

        Assert.Contains("class HostExtensions", combined);
        Assert.Contains("func M(host Host, value int32)", printed["Extensions.cs"]);
        Assert.DoesNotContain("func (host Host) M", combined);
        Assert.Contains("HostExtensions.M(host, 1)", printed["User.cs"]);

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(printed.Values);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id is "GS0264" or "GS0314");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void DistinctOverloads_FromDifferentStaticClasses_StayStatic()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Host.cs", @"
namespace Demo;

public sealed class Host
{
}"),
            ("FirstExtensions.cs", @"
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host, object value) => ""object"";
}"),
            ("SecondExtensions.cs", @"
namespace Demo;

public static class SecondExtensions
{
    public static string Describe(this Host host, string value) => ""string"";
}"),
            ("User.cs", @"
namespace Demo;

public static class User
{
    public static string Run(Host host, string value) =>
        FirstExtensions.Describe(host, value) +
        SecondExtensions.Describe(host, value) +
        host.Describe(value);
}"));

        string combined = string.Join(Environment.NewLine, printed.Values);

        Assert.Contains("class FirstExtensions", combined);
        Assert.Contains("class SecondExtensions", combined);
        Assert.Contains("func Describe(host Host, value object)", printed["FirstExtensions.cs"]);
        Assert.Contains("func Describe(host Host, value string)", printed["SecondExtensions.cs"]);
        Assert.DoesNotContain("func Describe(value ", printed["Host.cs"]);
        Assert.DoesNotContain("func (host Host) Describe", combined);
        Assert.Contains("FirstExtensions.Describe(host, value)", printed["User.cs"]);
        Assert.Equal(
            2,
            CountOccurrences(printed["User.cs"], "SecondExtensions.Describe(host, value)"));

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(printed.Values);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id is "GS0264" or "GS0314");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void DuplicateReducedSignatures_FromDifferentStaticClasses_StayStatic()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Host.cs", @"
namespace Demo;

public sealed class Host
{
}"),
            ("FirstExtensions.cs", @"
namespace Demo;

public static class FirstExtensions
{
    public static string Describe(this Host host, int value) => ""first"";
}"),
            ("SecondExtensions.cs", @"
namespace Demo;

public static class SecondExtensions
{
    public static string Describe(this Host host, int value) => ""second"";
}"),
            ("User.cs", @"
namespace Demo;

public static class User
{
    public static string Run(Host host) =>
        FirstExtensions.Describe(host, 1) + SecondExtensions.Describe(host, 2);
}"));

        string combined = string.Join(Environment.NewLine, printed.Values);

        Assert.Contains("class FirstExtensions", combined);
        Assert.Contains("class SecondExtensions", combined);
        Assert.Equal(2, CountOccurrences(combined, "func Describe(host Host, value int32)"));
        Assert.DoesNotContain("func (host Host) Describe", combined);
        Assert.DoesNotContain("func Describe(value int32)", printed["Host.cs"]);
        Assert.Contains("FirstExtensions.Describe(host, 1)", printed["User.cs"]);
        Assert.Contains("SecondExtensions.Describe(host, 2)", printed["User.cs"]);

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(printed.Values);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id is "GS0264" or "GS0314");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void CrossProjectStaticHelpers_PreserveInvocationStaticAndMethodGroupForms()
    {
        LoadedCSharpProject producer = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Producer.cs", @"
namespace Demo;

public sealed class Host
{
}

public static class FirstExtensions
{
    public static string Describe(this Host host, object value) => ""object"";
}

public static class SecondExtensions
{
    public static string Describe(this Host host, string value) => ""string"";
}"),
            },
            CSharpProjectLoader.RuntimeReferences(),
            "Producer");

        using var image = new MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = producer.Compilation.Emit(image);
        Assert.True(
            emit.Success,
            "Producer should emit with no C# errors: " +
                string.Join(Environment.NewLine, emit.Diagnostics));

        MetadataReference producerReference = MetadataReference.CreateFromImage(image.ToArray());
        LoadedCSharpProject consumer = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Consumer.cs", @"
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
}"),
            },
            CSharpProjectLoader.RuntimeReferences().Append(producerReference).ToList(),
            "Consumer");

        Assert.True(
            consumer.BoundWithoutErrors,
            "Consumer should bind with no C# errors: " +
                string.Join(Environment.NewLine, consumer.ErrorDiagnostics));

        var siblings = new[] { producer.Compilation, consumer.Compilation };
        string printedProducer = TranslateProject(producer, siblings);
        string printedConsumer = TranslateProject(consumer, siblings);
        string compactConsumer = Compact(printedConsumer);

        Assert.Contains("func Describe(host Host, value object)", printedProducer);
        Assert.Contains("func Describe(host Host, value string)", printedProducer);
        Assert.Equal(
            2,
            CountOccurrences(compactConsumer, "SecondExtensions.Describe(host, value)"));
        Assert.Contains("SecondExtensions.Describe(__spill", compactConsumer);
        Assert.Contains("FirstExtensions.Describe(__spill", compactConsumer);
        Assert.DoesNotContain("host.Describe", compactConsumer);

        ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> diagnostics =
            BindDiagnostics(new[] { printedProducer, printedConsumer });
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void ExternalReceiver_RetainsReceiverClause()
    {
        string printed = TranslateFiles(
            ("Extensions.cs", @"
namespace Demo;

public static class TextExtensions
{
    public static int TwiceLength(this string value) => value.Length * 2;
}"))["Extensions.cs"];

        Assert.Contains("func (value string) TwiceLength()", printed);
    }

    [Fact]
    public void OpenGenericOwnedReceiver_RetainsReceiverClause()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Box.cs", @"
namespace Demo;

public sealed class Box<T>
{
    public T Value;
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class BoxExtensions
{
    public static T Read<T>(this Box<T> box) => box.Value;
}"));

        Assert.Contains("func (box Box[T]) Read[T]()", printed["Extensions.cs"]);
        Assert.DoesNotContain("func Read", printed["Box.cs"]);
    }

    [Fact]
    public void ClosedGenericOwnedReceiver_RetainsReceiverClause()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Box.cs", @"
namespace Demo;

public sealed class Box<T>
{
    public T Value;
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class BoxExtensions
{
    public static int Read(this Box<int> box) => box.Value;
}"));

        Assert.Contains("func (box Box[int32]) Read()", printed["Extensions.cs"]);
        Assert.DoesNotContain("func Read", printed["Box.cs"]);
    }

    [Fact]
    public void ExcludedGeneratedExtension_DoesNotMoveIntoRetainedTarget()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            new CSharpToGSharpTranslator(retainedFilePaths: new[] { "Target.cs" }),
            ("Target.cs", @"
namespace Demo;

public partial class Meter
{
    public int Value;
}"),
            ("GeneratedExtensions.cs", @"
namespace Demo;

public static class MeterExtensions
{
    public static int Adjust(this Meter meter) => meter.Value;
}"));

        Assert.DoesNotContain("func Adjust(", printed["Target.cs"]);
    }

    private static IReadOnlyDictionary<string, string> TranslateFiles(
        params (string FileName, string Source)[] files)
    {
        return TranslateFiles(new CSharpToGSharpTranslator(), files);
    }

    private static IReadOnlyDictionary<string, string> TranslateFiles(
        CSharpToGSharpTranslator translator,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            string printed = GSharpPrinter.Print(unit);
            RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
            Assert.True(
                roundTrip.Success,
                "Translated G# must round-trip. Errors:\n" +
                    string.Join("\n", roundTrip.Errors) + "\n\nPrinted:\n" + printed);
            result.Add(document.FilePath, printed);
        }

        return result;
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> BindDiagnostics(
        IEnumerable<string> sources)
    {
        ImmutableArray<GSharp.Core.CodeAnalysis.Syntax.SyntaxTree> trees = sources
            .Select(source => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source)))
            .ToImmutableArray();
        BoundGlobalScope scope = Binder.BindGlobalScope(previous: null, trees);
        return scope.Diagnostics
            .Concat(Binder.BindProgram(scope).Diagnostics)
            .ToImmutableArray();
    }

    private static string TranslateProject(
        LoadedCSharpProject project,
        IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        var translator = new CSharpToGSharpTranslator();
        var output = new List<string>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations);
            output.Add(GSharpPrinter.Print(translator.TranslateDocument(document, context)));
        }

        return string.Join(Environment.NewLine, output);
    }

    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' },
            StringSplitOptions.RemoveEmptyEntries));

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }
}
