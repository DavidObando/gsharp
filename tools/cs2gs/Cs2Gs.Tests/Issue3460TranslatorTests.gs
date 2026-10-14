// <copyright file="Issue3460TranslatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Linq
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import Cs2Gs.Tests.Fixtures
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System.IO
import System.Text.Json

class Issue3460TranslatorTests {
    @Fact
    func ImportedClrObjectInitializer_UsesCanonicalCompositeLiteralAndBinds() {
        let printed = Translate(`using System.Text.Json;
using System.Text.Json.Serialization;

public static class Obj
{
    public static JsonSerializerOptions Make() =>
        new JsonSerializerOptions
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
}`, MetadataReference.CreateFromFile(typeof(JsonSerializerOptions).Assembly.Location))
        Assert.Contains(
            "JsonSerializerOptions{DefaultIgnoreCondition: JsonIgnoreCondition.WhenWritingNull}",
            printed,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("JsonSerializerOptions(){", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func ImportedClrObjectInitializer_InArgumentPosition_Binds() {
        let printed = Translate(`using System.Threading.Tasks;

public static class Obj
{
    private static int Read(ParallelOptions options) =>
        options.MaxDegreeOfParallelism;

    public static int Make() =>
        Read(new ParallelOptions { MaxDegreeOfParallelism = 4 });
}`)
        Assert.Contains("Read(ParallelOptions{MaxDegreeOfParallelism: 4})", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("ParallelOptions(){", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func SystemObjectEmptyInitializer_RemainsClrObjectConstruction() {
        let printed = Translate(`using SystemObject = System.Text.StringBuilder;

namespace Demo
{
    public sealed class SystemObject_2
    {
    }

    public static class Obj
    {
        public static string Run() =>
            new object { }.GetType().FullName!;
    }
}`)
        Assert.Contains("import SystemObject = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("import SystemObject_3 = System.Object", printed, StringComparison.Ordinal)
        Assert.Contains("SystemObject_3()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("object{}", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Demo.Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Object", result.Value)
    }

    @Fact
    func SystemObjectAlias_ReservesPartialSiblingImports() {
        let printed = TranslateFile("A.Primary.cs", preservePartialParts: false, ("A.Primary.cs", `namespace Demo;

public partial class PartialOwner
{
    public static string Run() =>
        new object { }.GetType().FullName!;
}`), ("B.Partial.cs", `using SystemObject = System.Text.StringBuilder;

namespace Demo;

public partial class PartialOwner
{
    public int Value;
}`))
        Assert.Contains("import SystemObject = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("import SystemObject_2 = System.Object", printed, StringComparison.Ordinal)
        Assert.Contains("SystemObject_2()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Demo.PartialOwner.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Object", result.Value)
    }

    @Fact
    func SystemObjectAlias_ReservesOwnedExtensionImports() {
        let files = TranslateFiles(preservePartialParts: true, ("A.Host.cs", `namespace Demo;

public sealed class Host
{
    public static string Run() =>
        new object { }.GetType().FullName!;
}`), ("B.Extensions.cs", `using SystemObject = System.Text.StringBuilder;

namespace Demo;

public static class HostExtensions
{
    public static int Measure(this Host host) => 1;
}`))
        let printed = files["A.Host.cs"]
        Assert.Contains("import SystemObject = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("import SystemObject_2 = System.Object", printed, StringComparison.Ordinal)
        Assert.Contains("SystemObject_2()", printed, StringComparison.Ordinal)
        Assert.Contains("shared class HostExtensions", files["B.Extensions.cs"], StringComparison.Ordinal)
        Assert.Contains("func (host Host) Measure()", files["B.Extensions.cs"], StringComparison.Ordinal)
        Assert.Contains("ExtensionOwner(typeof(HostExtensions))", files["B.Extensions.cs"], StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(files.Values.ToArray())
        let result = EmittedOracle.Evaluate(
            files
                .Values
                .Append("package Demo\nHost.Run() + \":\" + HostExtensions.Measure(Host()).ToString()")
                .ToArray()
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Object:1", result.Value)
    }

    @Fact
    func SystemObjectAlias_ReservesTransitivePartialOwnedExtensionImports() {
        let files = TranslateFiles(preservePartialParts: false, ("A.Primary.cs", `namespace Demo;

public partial class Outer
{
    public static string Run() =>
        new object { }.GetType().FullName!;
}`), ("B.Partial.cs", `namespace Demo;

public partial class Outer
{
    public sealed class Nested
    {
    }
}`), ("C.Extensions.cs", `using SystemObject = System.Text.StringBuilder;

namespace Demo;

public static class NestedExtensions
{
    public static int Measure(this Outer.Nested value) => 1;
}`))
        let printed = files["A.Primary.cs"]
        Assert.Contains("import SystemObject = System.Text.StringBuilder", printed, StringComparison.Ordinal)
        Assert.Contains("import SystemObject_2 = System.Object", printed, StringComparison.Ordinal)
        Assert.Contains("SystemObject_2()", printed, StringComparison.Ordinal)
        Assert.Contains("class Nested", printed, StringComparison.Ordinal)
        Assert.Contains("shared class NestedExtensions", files["C.Extensions.cs"], StringComparison.Ordinal)
        Assert.Contains("func (value Outer.Nested) Measure()", files["C.Extensions.cs"], StringComparison.Ordinal)
        Assert.Contains("ExtensionOwner(typeof(NestedExtensions))", files["C.Extensions.cs"], StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(files.Values.ToArray())
        let result = EmittedOracle.Evaluate(
            files
                .Values
                .Append("package Demo\nOuter.Run() + \":\" + NestedExtensions.Measure(Outer.Nested()).ToString()")
                .ToArray()
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Object:1", result.Value)
    }

    @Fact
    func ContributingDeclarationGraph_DoesNotFollowUnrelatedSameTreeExtensions() {
        let printed = TranslateFile("A.Primary.cs", preservePartialParts: false, ("A.Primary.cs", `namespace Demo;

public partial class Root
{
    public static string Run() =>
        typeof(System.Threading.Timer).FullName!;
}`), ("B.PartialAndUnrelated.cs", `namespace Demo;

public partial class Root
{
    public int Value;
}

public sealed class Unrelated
{
}`), ("C.UnrelatedExtensions.cs", `using System.Timers;

namespace Demo;

public static class UnrelatedExtensions
{
    public static int Measure(this Unrelated value) => 1;
}`))
        Assert.Contains("import System.Threading", printed, StringComparison.Ordinal)
        Assert.True(!printed.Contains("import System.Timers", StringComparison.Ordinal), printed)
        Assert.Contains("typeof(Timer)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Measure()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Demo.Root.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Threading.Timer", result.Value)
    }

    @Fact
    func ContributingDeclarationGraph_SkipsNonPrimaryPartialSeeds() {
        let printed = TranslateFile("B.RootAndNonPrimary.cs", preservePartialParts: false, ("A.CarrierPrimary.cs", `namespace Demo;

public partial class Carrier
{
}`), ("B.RootAndNonPrimary.cs", `namespace Demo;

public sealed class Root
{
    public static string Run() =>
        typeof(System.Threading.Timer).FullName!;
}

public partial class Carrier
{
    public sealed class Nested
    {
    }
}`), ("C.NestedExtensions.cs", `using System.Timers;

namespace Demo;

public static class NestedExtensions
{
    public static int Measure(this Carrier.Nested value) => 1;
}`))
        Assert.Contains("import System.Threading", printed, StringComparison.Ordinal)
        Assert.True(!printed.Contains("import System.Timers", StringComparison.Ordinal), printed)
        Assert.Contains("class Root", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("class Carrier", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Measure()", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Demo.Root.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Threading.Timer", result.Value)
    }

    @Fact
    func ContributingDeclarationGraph_FlattenedEntrySkipsPartialSiblings() {
        let printed = TranslateEntryFile("A.Entry.cs", ("A.Entry.cs", (`using System.Threading;

namespace Demo;

public static partial class Program
{
    // Issue #3837: ` + "`" + `private` + "`" + ` keeps this entry class on the
    // FLATTENING path — a ` + "`" + `public` + "`" + `/` + "`" + `internal` + "`" + ` non-entry
    // member is consumable surface the hoist would erase,
    // so it now preserves the class instead. The subject
    // here is the contributing-declaration graph, not the
    // preserve/flatten choice, so keep it flattened.
    private static string Probe() => typeof(Timer).FullName!;

    public static void Main()
    {
    }
}`)), ("B.EntrySibling.cs", `using System.Timers;

namespace Demo;

public static partial class Program
{
    private static int Unemitted() => 1;
}`))
        Assert.Contains("import System.Threading", printed, StringComparison.Ordinal)
        Assert.True(!printed.Contains("import System.Timers", StringComparison.Ordinal), printed)
        Assert.Contains("func Probe()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("func Unemitted()", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("class Program", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal("System.Threading.Timer", result.Value)
    }

    @Fact
    func ImportedParameterlessInitializer_PreservesOrderedMembersNestedInitializersAndRuntime() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    private static Issue3460ImportedOptions Capture(
        Issue3460ImportedOptions options) => options;

    private static int Mark(int digit)
    {
        Issue3460ImportedOptions.Trace =
            (Issue3460ImportedOptions.Trace * 10) + digit;
        return digit;
    }

    private static string MarkText(string value, int digit)
    {
        Mark(digit);
        return value;
    }

    public static int Run()
    {
        Issue3460ImportedOptions.Trace = 0;
        var options = Capture(
            new Issue3460ImportedOptions
            {
                Required = MarkText("ok", 2),
                InitOnly = Mark(3),
                Value = Mark(4),
                Nested = new Issue3460NestedOptions { Value = Mark(5) },
                Values = { Mark(6), Mark(7) },
            });
        return Issue3460ImportedOptions.Trace
            + options.Required.Length
            + options.InitOnly
            + options.Value
            + options.Nested.Value
            + options.Values[0]
            + options.Values[1];
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460ImportedOptions).Assembly.Location))
        Assert.Contains("Issue3460ImportedOptions{", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Issue3460ImportedOptions(){", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460ImportedOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(1234594, result.Value)
    }

    @Fact
    func ImportedConstructorArguments_RunBeforeOrderedMemberAssignments() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    private static int MarkArgument()
    {
        Issue3460ImportedOptions.Trace =
            (Issue3460ImportedOptions.Trace * 10) + 1;
        return 2;
    }

    private static int Mark(int digit)
    {
        Issue3460ImportedOptions.Trace =
            (Issue3460ImportedOptions.Trace * 10) + digit;
        return digit;
    }

    private static string MarkText(string value, int digit)
    {
        Mark(digit);
        return value;
    }

    public static int Run()
    {
        Issue3460ImportedOptions.Trace = 0;
        var options = new Issue3460ImportedOptions(MarkArgument())
        {
            Required = MarkText("ok", 3),
            InitOnly = Mark(4),
        };
        return Issue3460ImportedOptions.Trace + options.Required.Length;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460ImportedOptions).Assembly.Location))
        Assert.Contains("Issue3460ImportedOptions(MarkArgument())", printed, StringComparison.Ordinal)
        Assert.Contains("Required = MarkText(\"ok\", 3)", printed, StringComparison.Ordinal)
        Assert.Contains("InitOnly = Mark(4)", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460ImportedOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(1236, result.Value)
    }

    @Fact
    func ImportedNestedMemberInitializer_UnwrapsNullableReceiverAndPreservesNullThrow() {
        let printed = Translate(`using System;
using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    private static int trace;

    private static int Mark(int digit)
    {
        trace = (trace * 10) + digit;
        return digit;
    }

    public static int Run()
    {
        trace = 0;
        var initialized = new Issue3460NonNullNestedHolder
        {
            Nested = { Value = 5 },
        };

        try
        {
            _ = new Issue3460NullNestedHolder
            {
                Nested = { Value = Mark(1) },
            };
            return -1;
        }
        catch (NullReferenceException)
        {
        }

        try
        {
            _ = new Issue3460NullCollectionHolder
            {
                Values = { Mark(2) },
            };
            return -2;
        }
        catch (NullReferenceException)
        {
            return trace + initialized.Nested!.Value;
        }
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460NestedOptions).Assembly.Location))
        Assert.Contains("Nested: { Value = 5 }", printed, StringComparison.Ordinal)
        Assert.Contains("Nested: { Value = Mark(1) }", printed, StringComparison.Ordinal)
        Assert.Contains("Values: { Mark(2) }", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460NestedOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(17, result.Value)
    }

    @Fact
    func SourceCompositeInitializer_BracedMembersPreserveTextualEvaluationOrder() {
        let printed = Translate(`using System.Collections.Generic;

public sealed class Nested
{
    public int Value { get; set; }
}

public sealed class Options
{
    public int First { get; set; }
    public Nested Nested { get; } = new();
    public int Middle { get; set; }
    public List<int> Values { get; } = new();
    public int Last { get; set; }
}

public static class Obj
{
    private static int trace;

    private static int Mark(int digit)
    {
        trace = (trace * 10) + digit;
        return digit;
    }

    public static int Run()
    {
        trace = 0;
        _ = new Options
        {
            First = Mark(1),
            Nested = { Value = Mark(2) },
            Middle = Mark(3),
            Values = { Mark(4) },
            Last = Mark(5),
        };
        return trace;
    }
}`)
        Assert.Contains("Options{", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Options(){", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(12345, result.Value)
    }

    @Fact
    func ImportedOptionalConstructor_DefaultIsMaterializedBeforeInitializer() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460OptionalOptions { Value = 3 };
        return (options.Marker * 10) + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460OptionalOptions).Assembly.Location))
        Assert.Contains("Issue3460OptionalOptions(int32(7)){Value = 3}", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("Issue3460OptionalOptions(){", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460OptionalOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(73, result.Value)
    }

    @Fact
    func ImportedOptionalConstructor_DefaultKeepsSelectedNarrowOverload() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460OverloadedOptionalOptions { Value = 3 };
        return (options.Selected * 10) + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460OverloadedOptionalOptions).Assembly.Location))
        Assert.Contains("Issue3460OverloadedOptionalOptions(int16(7)){Value = 3}", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460OverloadedOptionalOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func ImportedParamsCollectionConstructor_NoParenthesesBuildsEmptyListArgument() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460ParamsCollectionOptions { Value = 3 };
        return (options.Count * 10) + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460ParamsCollectionOptions).Assembly.Location))
        Assert.Contains("Issue3460ParamsCollectionOptions(List[int32]()){Value = 3}", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460ParamsCollectionOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func ImportedOptionalBeforeParamsCollection_MaterializesEveryOperationSlot() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460OptionalParamsCollectionOptions { Value = 3 };
        return (options.Marker * 100) + (options.Count * 10) + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460OptionalParamsCollectionOptions).Assembly.Location))
        Assert.Contains(
            "Issue3460OptionalParamsCollectionOptions(int32(7), List[int32]()){Value = 3}",
            printed,
            StringComparison.Ordinal
        )
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460OptionalParamsCollectionOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(703, result.Value)
    }

    @Fact
    func ImportedParamsInterfaceCollection_CoercesToSelectedParameterType() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460ParamsInterfaceOverloadOptions { Value = 3 };
        return (options.Selected * 100)
            + (options.Count * 10)
            + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460ParamsInterfaceOverloadOptions).Assembly.Location))
        Assert.Contains(
            "Issue3460ParamsInterfaceOverloadOptions(cast[IEnumerable[int32]](List[int32]())){Value = 3}",
            printed,
            StringComparison.Ordinal
        )
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460ParamsInterfaceOverloadOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(103, result.Value)
    }

    @Fact
    func ImportedSpanParamsCollection_ExpandedObjectCreationUsesArrayConversion() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460SpanParamsOptions(1, 2) { Value = 3 };
        return (options.Count * 10) + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460SpanParamsOptions).Assembly.Location))
        Assert.Contains(
            "Issue3460SpanParamsOptions(ReadOnlySpan[int32]([]int32{1, 2})){Value = 3}",
            printed,
            StringComparison.Ordinal
        )
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460SpanParamsOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(23, result.Value)
    }

    @Fact
    func ImportedUnsupportedParamsCollection_NonemptyExpansionReportsDiagnostic() {
        let (_, context) = TranslateWithContext(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static object Run() =>
        new Issue3460UnsupportedParamsOptions(1, 2) { Value = 3 };
}`, CompileUnsupportedParamsLibrary())
        Assert.Contains(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message!!.Contains("HashSet", StringComparison.Ordinal)
        )
    }

    @Fact
    func ImportedStringOptionalDefault_PreservesSelectedReferenceOverload() {
        let printed = Translate(`using Cs2Gs.Tests.Fixtures;

public static class Obj
{
    public static int Run()
    {
        var options = new Issue3460StringDefaultOptions { Value = 3 };
        return (options.Selected * 100)
            + (options.Marker.Length * 10)
            + options.Value;
    }
}`, MetadataReference.CreateFromFile(typeof(Issue3460StringDefaultOptions).Assembly.Location))
        Assert.Contains("Issue3460StringDefaultOptions(\"selected\"){Value = 3}", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("\"selected\" as string", printed, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            []string{typeof(Issue3460StringDefaultOptions).Assembly.Location}
        )
        Assert.DoesNotContain(
            result.Diagnostics,
            (diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(183, result.Value)
    }

    shared {
        private func CompileUnsupportedParamsLibrary() MetadataReference {
            // Compiled in memory (not project source) so Cs2Gs.Tests itself
            // never carries an untranslatable `params HashSet<int>` member.
            let tree = CSharpSyntaxTree.ParseText(`namespace Cs2Gs.Tests.Fixtures
{
    public sealed class Issue3460UnsupportedParamsOptions
    {
        public Issue3460UnsupportedParamsOptions(params System.Collections.Generic.HashSet<int> values)
        {
            Count = values.Count;
        }

        public int Count { get; }

        public int Value { get; init; }
    }
}`, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                "Issue3460UnsupportedParamsLib",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let peStream = MemoryStream()
            let emit = compilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            return MetadataReference.CreateFromStream(peStream)
        }

        private func Translate(source string, additionalReferences ...MetadataReference) string {
            return TranslateWithContext(source, additionalReferences).Printed
        }

        private func TranslateWithContext(source string, additionalReferences ...MetadataReference)(
            Printed string,
            Context TranslationContext
        ) {
            let references IReadOnlyList[MetadataReference]? = if additionalReferences.Length == 0 {
                default(List[MetadataReference]?)
            } else {
                CSharpProjectLoader
                    .RuntimeReferences()
                    .Concat(additionalReferences)
                    .GroupBy((reference MetadataReference) -> reference.Display!!, StringComparer.Ordinal)
                    .Select((group IGrouping[string, MetadataReference]) -> group.First())
                    .ToList()
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                references
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (GSharpPrinter.Print(unit), context)
        }

        private func TranslateFile(
            targetPath string,
            preservePartialParts bool,
            sources ...(Path string, Source string)
        ) string {
            return TranslateFileCore(targetPath, preservePartialParts, OutputKind.DynamicallyLinkedLibrary, sources)
        }

        private func TranslateEntryFile(targetPath string, sources ...(Path string, Source string)) string {
            return TranslateFileCore(targetPath, preservePartialParts: false, OutputKind.ConsoleApplication, sources)
        }

        private func TranslateFileCore(
            targetPath string,
            preservePartialParts bool,
            outputKind OutputKind,
            sources ...(Path string, Source string)
        ) string {
            return TranslateFilesCore(targetPath, preservePartialParts, outputKind, sources)[targetPath]
        }

        private func TranslateFiles(
            preservePartialParts bool,
            sources ...(Path string, Source string)
        ) IReadOnlyDictionary[string, string] {
            return TranslateFilesCore(nil, preservePartialParts, OutputKind.DynamicallyLinkedLibrary, sources)
        }

        private func TranslateFilesCore(
            targetPath string?,
            preservePartialParts bool,
            outputKind OutputKind,
            sources ...(Path string, Source string)
        ) IReadOnlyDictionary[string, string] {
            let project = CSharpProjectLoader.LoadInMemory(sources, outputKind: outputKind)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippets should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let translated = Dictionary[string, string](StringComparer.Ordinal)
            let translator = CSharpToGSharpTranslator(preservePartialParts: preservePartialParts)
            for document in project.Documents.Where(
                (candidate LoadedDocument) -> targetPath == nil || candidate.FilePath.EndsWith(
                    targetPath,
                    StringComparison.Ordinal
                )
            ) {
                let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                let unit = translator.TranslateDocument(document, context)
                translated.Add(
                    sources.Single(
                        (source(Path string, Source string)) -> document.FilePath.EndsWith(
                            source.Path,
                            StringComparison.Ordinal
                        )
                    )
                        .Path,
                    GSharpPrinter.Print(unit)
                )
            }
            return translated
        }
    }
}
