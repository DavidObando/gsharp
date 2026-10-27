// <copyright file="Issue4776CopyProvenanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Text
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSourceText = GSharp.Core.CodeAnalysis.Text.SourceText
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

class Issue4776CopyProvenanceEmitTests {
    private const ImportedNullableContract5408 string = `#nullable enable
using System.Collections.Generic;
namespace CopyAnnotated5408;
public record struct S<T>(T Value) {
    public readonly object Anchor = Api.Construct();
}
public record R<T>(T Value);
public static class Api {
    public static readonly object Marker = new();
    public static int Calls, Constructions;
    public static object Construct() { Constructions++; return Marker; }
    public static S<string?> Create() { Calls++; return new(null); }
    public static S<string> Required() { Calls++; return new("required"); }
    public static S<int> Value() { Calls++; return new(42); }
    public static S<int?> Optional() { Calls++; return new(null); }
    public static S<List<int>> NestedValue() { Calls++; return new(new() { 42 }); }
    public static S<List<int?>> NestedOptional() { Calls++; return new(new() { null }); }
    public static S<List<string?>> Nested() { Calls++; return new(new() { null }); }
    public static R<string?> Reference() { Calls++; return new(null); }
    public static R<string?>? Maybe() { Calls++; return null; }
    public static S<string?>? Lift() => Create();
}`

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedNullableGenericReturn_PreservesExplicitContracts(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(ImportedNullableContract5408, "Contract", reference)
        const source = `package SameContract5408
import System.Collections.Generic
import CopyAnnotated5408
public class Exports {
    shared {
        public func Direct() S[string?] -> Api.Create()
        public func Local() S[string?] {
            let value S[string?] = Api.Create()
            return value
        }
        private func Receive(value S[string?]) S[string?] -> value
        public func Argument() S[string?] -> Receive(Api.Create())
        public func Required() S[string] -> Api.Required()
        public func Value() S[int32] -> Api.Value()
        public func Optional() S[int32?] -> Api.Optional()
        public func NestedValue() S[List[int32]] -> Api.NestedValue()
        public func NestedOptional() S[List[int32?]] -> Api.NestedOptional()
        public func Nested() S[List[string?]] -> Api.Nested()
        public func Reference() R[string?] -> Api.Reference()
        public func Lift() S[string?]? -> Api.Create()
        public func ReferenceLift() R[string?]? -> Api.Reference()
        public func Maybe() R[string?]? -> Api.Maybe()
    }
}`
        let apiReference = Path.Combine(fixture.Directory, "Api.ref.dll")
        let arguments = []string{
            "/assemblyname:Api",
            "/refout:" + apiReference,
            "/r:" + if useReference {
                reference
            } else {
                contract
            }
        }
        let api = fixture.Compile(source, "Api", executable: false, arguments)
        let firstImage = File.ReadAllBytes(api)
        let firstReference = File.ReadAllBytes(apiReference)
        let _ = fixture.Compile(source, "Api", executable: false, arguments)
        Assert.Equal(firstImage, File.ReadAllBytes(api))
        Assert.Equal(firstReference, File.ReadAllBytes(apiReference))
        let caller = fixture.CompileCSharp(`using System.Collections.Generic;
using CopyAnnotated5408;
using SameContract5408;
using System;
using System.Linq;
using System.Reflection;
public static class Probe {
    private static string Describe(NullabilityInfo info) => info.Type + ":" + info.ReadState + ":" + info.WriteState
        + "[" + string.Join(",", info.GenericTypeArguments.Select(Describe)) + "]";
    public static string Run() {
        foreach (var value in new[] { Exports.Direct(), Exports.Local(), Exports.Argument() }) {
            if (value.Value != null || !ReferenceEquals(value.Anchor, Api.Marker)
                || value.GetType() != typeof(S<string>)) throw new Exception("Nullable storage changed.");
        }
        var required = Exports.Required();
        var number = Exports.Value();
        var optional = Exports.Optional();
        var nestedValue = Exports.NestedValue();
        var nestedOptional = Exports.NestedOptional();
        var nested = Exports.Nested();
        var reference = Exports.Reference();
        var lifted = Exports.Lift();
        var referenceLift = Exports.ReferenceLift();
        if (required.Value != "required" || number.Value != 42 || optional.Value != null
            || optional.GetType() != typeof(S<int?>) || nested.Value.Count != 1
            || nestedValue.Value.Single() != 42 || nestedOptional.Value.Count != 1
            || nestedOptional.Value[0] != null || nestedOptional.GetType() != typeof(S<List<int?>>)
            || nested.Value[0] != null || reference.Value != null
            || reference.GetType() != typeof(R<string>)
            || !lifted.HasValue || lifted.Value.Value != null
            || !ReferenceEquals(lifted.Value.Anchor, Api.Marker)
            || referenceLift == null || referenceLift.Value != null || Exports.Maybe() != null)
            throw new Exception("Control contract changed.");
        if (Api.Calls != 13 || Api.Constructions != 10)
            throw new Exception("Conversion evaluated again or reconstructed a value.");
        var context = new NullabilityInfoContext();
        foreach (var name in new[] { "Direct", "Local", "Argument", "Reference" }) {
            var info = context.Create(typeof(Exports).GetMethod(name)!.ReturnParameter);
            if (info.GenericTypeArguments[0].ReadState != NullabilityState.Nullable)
                throw new Exception("Nullable argument metadata changed: " + name);
        }
        var nonnull = context.Create(typeof(Exports).GetMethod("Required")!.ReturnParameter);
        var nestedInfo = context.Create(typeof(Exports).GetMethod("Nested")!.ReturnParameter);
        var liftedInfo = context.Create(typeof(Exports).GetMethod("Lift")!.ReturnParameter);
        var nativeLiftInfo = context.Create(typeof(Api).GetMethod("Lift")!.ReturnParameter);
        var maybeInfo = context.Create(typeof(Exports).GetMethod("Maybe")!.ReturnParameter);
        if (nonnull.GenericTypeArguments[0].ReadState != NullabilityState.NotNull
            || nestedInfo.GenericTypeArguments[0].ReadState != NullabilityState.NotNull
            || nestedInfo.GenericTypeArguments[0].GenericTypeArguments[0].ReadState != NullabilityState.Nullable
            || Describe(liftedInfo) != Describe(nativeLiftInfo)
            || maybeInfo.ReadState != NullabilityState.Nullable
            || maybeInfo.GenericTypeArguments[0].ReadState != NullabilityState.Nullable)
            throw new Exception("Nested or non-null metadata changed.");
        return "nullable-contract|storage|once|metadata";
    }
}`, "Caller", contract, apiReference)
        IlVerifier.Verify(contract)
        IlVerifier.Verify(api, []string{contract})
        IlVerifier.Verify(caller, []string{contract, api})
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(
            "nullable-contract|storage|once|metadata",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
    }

    @Theory
    @InlineData("S[string]", "Api.Create()", false)
    @InlineData("S[string]", "Api.Create()", true)
    @InlineData("S[string?]", "Api.Required()", false)
    @InlineData("S[string?]", "Api.Required()", true)
    @InlineData("S[object?]", "Api.Create()", false)
    @InlineData("S[object?]", "Api.Create()", true)
    @InlineData("S[List[string]]", "Api.Nested()", false)
    @InlineData("S[List[string]]", "Api.Nested()", true)
    @InlineData("R[string]", "Api.Reference()", false)
    @InlineData("R[string]", "Api.Reference()", true)
    @InlineData("R[string?]", "Api.Maybe()", false)
    @InlineData("R[string?]", "Api.Maybe()", true)
    @InlineData("S[int32]", "Api.Optional()", false)
    @InlineData("S[int32]", "Api.Optional()", true)
    @InlineData("S[int32?]", "Api.Value()", false)
    @InlineData("S[int32?]", "Api.Value()", true)
    @InlineData("S[List[int32]]", "Api.NestedOptional()", false)
    @InlineData("S[List[int32]]", "Api.NestedOptional()", true)
    @InlineData("S[List[int32?]]", "Api.NestedValue()", false)
    @InlineData("S[List[int32?]]", "Api.NestedValue()", true)
    func ImportedNullableGenericReturn_RejectsDifferentInvariantContracts(
        target string,
        expression string,
        useReference bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(ImportedNullableContract5408, "Contract", reference)
        let outputReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let (code, output) = fixture.TryCompile(
            "import System.Collections.Generic\nimport CopyAnnotated5408\npublic func Rejected() " +
                target +
                " -> " +
                expression +
                "\n",
            "Rejected",
            executable: false,
            "/r:" + if useReference {
                reference
            } else {
                contract
            },
            "/refout:" + outputReference
        )
        let start = 28 + target.Length
        let end = start + expression.Length
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("Rejected.gs(3,$start,3,$end): error GS0155", StringComparison.Ordinal), output)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(outputReference))
    }

    @Theory
    @InlineData("source")
    @InlineData("implementation")
    @InlineData("reference")
    func NullableGenericCopy_PreservesArgumentsAcrossSourceAndImportedRepresentations(representation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const declaration = `public data struct S[T](Value T)
public class Factory {
    shared {
        public func NonNull() S[string] -> S[string]{Value: "nonnull"}
        public func Optional() S[int32?] -> S[int32?]{Value: nil}
        public func Nullable() S[string?] -> S[string?]{Value: nil}
    }
}`
        var prefix = declaration
        var references = []string{}
        if representation != "source" {
            let reference = Path.Combine(fixture.Directory, "Producer.ref.dll")
            let producer = fixture.Compile(
                "package NullableCopy5405\n" + declaration,
                "Producer",
                executable: false,
                "/assemblyname:Producer",
                "/refout:" + reference
            )
            IlVerifier.Verify(producer)
            references = []string{
                "/r:" + if representation == "reference" {
                    reference
                } else {
                    producer
                }
            }
            prefix = "import NullableCopy5405"
        }
        let image = fixture.Compile("import System\nimport System.Collections.Generic\n" + prefix + `
let original = S[string?]{Value: nil}
let copy = original with{}
Console.WriteLine(copy.Value == nil)
let changed = original with { Value = "payload" }
Console.WriteLine(changed.Value == "payload")
let cleared = changed.copy(Value: nil)
Console.WriteLine(cleared.Value == nil)
Console.WriteLine(original.Value == nil)
`, "Consumer", executable: true, references)
        let dependencies = if representation == "source" {
            []string{}
        } else {
            []string{Path.Combine(fixture.Directory, "Producer.dll")}
        }
        IlVerifier.Verify(image, dependencies)
        Assert.Equal(
            Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("True" + Environment.NewLine, 4))),
            fixture.RunBytes(image)
        )
        let controls = []string{`let original = Factory.NonNull()
Console.WriteLine(original.copy().Value == "nonnull")`, `let original = S[List[string?]]{Value: List[string?]()}
original.Value.Add(nil)
let copy = original with{}
Console.WriteLine(copy.Value[0] == nil)`, `let original = Factory.Optional()
Console.WriteLine(original.copy().Value == nil)`, `let original = S[(Text string?, Number int32)]{Value: (Text: nil, Number: 7)}
let copy = original with{}
Console.WriteLine(copy.Value.Text == nil && copy.Value.Number == 7)`, `let original = Factory.Nullable()
let copy = original with { Value = nil }
Console.WriteLine(copy.copy().Value == nil)`}
        for var index = 0; index < controls.Length; index++ {
            let control = fixture.Compile(
                "import System\nimport System.Collections.Generic\n" + prefix + "\n" + controls[index],
                "Control" + index.ToString(),
                executable: true,
                references
            )
            IlVerifier.Verify(control, dependencies)
            Assert.Equal(Encoding.UTF8.GetBytes("True" + Environment.NewLine), fixture.RunBytes(control))
        }
    }

    @Theory
    @InlineData("with{}")
    @InlineData(".copy()")
    func NullableGenericCopy_RejectsNarrowingWithoutAnImage(operation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producerReference = Path.Combine(fixture.Directory, "Producer.ref.dll")
        let producer = fixture.Compile(
            "package NullableCopy5405\npublic data struct S[T](Value T)\npublic data class C[T](Value T)",
            "Producer",
            executable: false,
            "/assemblyname:Producer",
            "/refout:" + producerReference
        )
        let reference = Path.Combine(fixture.Directory, "Narrowing.ref.dll")
        let (code, output) = fixture.TryCompile(
            "import NullableCopy5405\nlet original = S[string?]{Value: nil}\nlet copy = original " +
                operation +
                "\nlet required string = copy.Value",
            "Narrowing",
            executable: true,
            "/r:" + producer,
            "/refout:" + reference
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("Narrowing.gs(4,23,4,33): error GS0155", StringComparison.Ordinal), output)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Narrowing.dll")))
        Assert.False(File.Exists(reference))
        for typeName in[]string{"C", "S"} {
            for selected in[]string{producer, producerReference} {
                let rejectedReference = Path.Combine(fixture.Directory, "NullableReceiver.ref.dll")
                let (nullableCode, nullableOutput) = fixture.TryCompile(
                    "import NullableCopy5405\nfunc Copy(value " +
                        typeName +
                        "[string?]?) " +
                        typeName +
                        "[string?]? -> value " +
                        operation +
                        "\nlet unused = Copy(nil)",
                    "NullableReceiver",
                    executable: true,
                    "/r:" + selected,
                    "/refout:" + rejectedReference
                )
                Assert.NotEqual(0, nullableCode)
                let expectedDiagnostic = if operation == "with{}" {
                    "NullableReceiver.gs(2,51,2,55): error GS0161:"
                } else {
                    "NullableReceiver.gs(2,52,2,58): error GS0159:"
                }
                Assert.Contains(expectedDiagnostic, nullableOutput)
                Assert.Equal(1, nullableOutput.Split(": error GS", StringSplitOptions.None).Length - 1)
                Assert.DoesNotContain("GS9998", nullableOutput, StringComparison.Ordinal)
                Assert.False(File.Exists(Path.Combine(fixture.Directory, "NullableReceiver.dll")))
                Assert.False(File.Exists(rejectedReference))
                let control = fixture.Compile(
                    "import System\nimport NullableCopy5405\nfunc Narrow(value " +
                        typeName +
                        "[string?]?) bool {\nif value != nil { let changed = value " +
                        operation +
                        "\nreturn changed.Value == nil }\nreturn true\n}\nlet original = " +
                        typeName +
                        "[string?](nil)\nlet copy = original " +
                        operation +
                        "\nConsole.WriteLine(copy.Value == nil && Narrow(original) && Narrow(nil))",
                    "NonNullableReceiver",
                    executable: true,
                    "/r:" + selected
                )
                IlVerifier.Verify(control, []string{producer})
                Assert.Equal(Encoding.UTF8.GetBytes("True" + Environment.NewLine), fixture.RunBytes(control))
            }
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedNullableGenericCopy_PreservesStorageAndRunsOnlyExplicitUpdates(useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace CopyContract5405;
public static class Trace {
    public static int Constructions, Receivers, Updates;
    public static object Anchor() { Constructions++; return new object(); }
    public static string? Next() { Updates++; return null; }
}
public record struct Box<T>(T Value) {
    public int Extra;
    public object Anchor = Trace.Anchor();
    private readonly object hidden = new object();
    public object Hidden() => hidden;
}
public static class Oracle {
    public static Box<string?> Copy(Box<string?> original) =>
        original with { Value = Trace.Next() };
    public static Box<string?> Original() => new(null);
}`, "Contract", reference)
        let api = fixture.Compile(`package CopyApi5405
import CopyContract5405
public class Api {
    shared {
        public func Receive(original Box[string?]) Box[string?] {
            Trace.Receivers++
            return original
        }
        public func Copy(original Box[string?]) Box[string?] ->
            Receive(original) with { Value = Trace.Next() }
        public func Sugar(original Box[string?]) Box[string?] ->
            Receive(original).copy(Value: Trace.Next())
        public func Empty(original Box[string?]) Box[string?] -> original with{}
        public func Field[T any](original Box[T]) Box[T] -> original with { Extra = 1 }
        public func FieldSugar[T any](original Box[T]) Box[T] -> original.copy(Extra: 1)
        public func FromContract() bool {
            let copy = Oracle.Original() with { Value = nil }
            return copy.Value == nil
        }
    }
}
`, "Api", executable: false, "/assemblyname:Api", "/r:" +
                if useReference {
                reference
            } else {
                contract
            })
        let caller = fixture.CompileCSharp(`using CopyContract5405;
using System;
public static class Probe {
    public static string Run() {
        var original = new Box<string?>("payload");
        var anchor = original.Anchor;
        var hidden = original.Hidden();
        foreach (var copy in new Func<Box<string?>, Box<string?>>[] {
            CopyApi5405.Api.Copy, CopyApi5405.Api.Sugar
        }) {
            Trace.Receivers = Trace.Updates = 0;
            var changed = copy(original);
            if (changed.Value != null || original.Value != "payload"
                || !ReferenceEquals(changed.Anchor, anchor) || !ReferenceEquals(changed.Hidden(), hidden)
                || Trace.Constructions != 1 || Trace.Receivers != 1 || Trace.Updates != 1)
                throw new Exception("Copy changed storage or replayed construction.");
            changed.Anchor = new object();
            if (!ReferenceEquals(original.Anchor, anchor)) throw new Exception("Copy aliases original storage.");
        }
        var empty = CopyApi5405.Api.Empty(original);
        if (empty.Value != "payload" || !ReferenceEquals(empty.Hidden(), hidden)
            || Trace.Constructions != 1) throw new Exception("Empty copy reconstructed storage.");
        foreach (var changed in new[] { CopyApi5405.Api.Field(original), CopyApi5405.Api.FieldSugar(original) })
            if (changed.Extra != 1 || original.Extra != 0 || changed.Value != "payload"
                || !ReferenceEquals(changed.Hidden(), hidden) || Trace.Constructions != 1)
                throw new Exception("Open reference-type field copy changed storage.");
        foreach (var changed in new[] {
            CopyApi5405.Api.Field(default(Box<int>)), CopyApi5405.Api.FieldSugar(default(Box<int>))
        })
            if (changed.Extra != 1 || changed.Value != 0 || Trace.Constructions != 1)
                throw new Exception("Open value-type field copy changed storage.");
        var native = Oracle.Copy(original);
        if (native.Value != null || !ReferenceEquals(native.Anchor, anchor)
            || !ReferenceEquals(native.Hidden(), hidden) || Trace.Constructions != 1)
            throw new Exception("Native copy oracle disagrees.");
        if (!CopyApi5405.Api.FromContract() || Trace.Constructions != 2)
            throw new Exception("Annotated return lost nullability or reconstructed storage.");
        var fresh = new Box<string?>(null);
        if (Trace.Constructions != 3 || ReferenceEquals(fresh.Anchor, anchor))
            throw new Exception("Fresh construction control did not execute.");
        return "copy-only|nullable|identity|once";
    }
}`, "Caller", contract, api)
        IlVerifier.Verify(contract)
        IlVerifier.Verify(api, []string{contract})
        IlVerifier.Verify(caller, []string{contract, api})
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(
            "copy-only|nullable|identity|once",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
    }

    @Theory
    @InlineData("Value", false)
    @InlineData("Value", true)
    @InlineData("Fixed", false)
    @InlineData("Fixed", true)
    func ImportedNullableGenericCopy_PrefersNearestFieldOverInheritedProperty(member string, useReference bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Contract.ref.dll")
        let contract = fixture.CompileCSharpWithReference(`namespace CopyMembers5405;
public record Base {
    public int Value { get; set; } = 41;
    public int Fixed { get; } = 42;
    public int Other = 43;
}
public record Derived<T>(T Payload) : Base {
    public new int Value;
    public new int Fixed;
    public new int Other { get; set; }
}`, "Contract", reference)
        let api = fixture.Compile((`package CopyMembersApi5405
import CopyMembers5405
public class Api {
    shared {
        public func With(value Derived[string?]) Derived[string?] -> value with { MEMBER = 9 }
        public func Sugar(value Derived[string?]) Derived[string?] -> value.copy(MEMBER: 9)
        public func Property(value Derived[string?]) Derived[string?] -> value with { Other = 11 }
        public func PropertySugar(value Derived[string?]) Derived[string?] -> value.copy(Other: 11)
    }
}
`).Replace(
                "MEMBER",
                member
            ), "Api", executable: false, "/assemblyname:Api", "/r:" +
                if useReference {
                reference
            } else {
                contract
            })
        let caller = fixture.CompileCSharp((`using CopyMembers5405;
using CopyMembersApi5405;
using System;
public static class Probe {
    public static bool Run() {
        var original = new Derived<string?>(null);
        var expected = original with { MEMBER = 9 };
        foreach (var changed in new[] { Api.With(original), Api.Sugar(original) }) {
            if (changed.MEMBER != expected.MEMBER || original.MEMBER != 0
                || ((Base)changed).MEMBER != ((Base)original).MEMBER
                || ReferenceEquals(changed, original) || changed.Payload != null)
                throw new Exception("Copy did not select the nearest field.");
        }
        foreach (var changed in new[] { Api.Property(original), Api.PropertySugar(original) }) {
            if (changed.Other != 11 || original.Other != 0 || ((Base)changed).Other != 43)
                throw new Exception("A farther field replaced the nearest property.");
        }
        return true;
    }
}
`).Replace("MEMBER", member), "Caller", contract, api)
        IlVerifier.Verify(contract)
        IlVerifier.Verify(api, []string{contract})
        IlVerifier.Verify(caller, []string{contract, api})
        let assemblies = EmittedFixture.LoadTogether(contract, api, caller)
        Assert.Equal(true, assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Theory
    @InlineData("int", "42")
    @InlineData("string", "\"payload\"")
    func ValueCopy_InitializesOnlyFreshValuesAndPreservesStateAndOrder(csType string, payload string) {
        using let native = CSharpFixture(`namespace NativeCopy4776;
public static class Trace {
    public static int Initializations;
    public static string Events = "";
    public static object Identity() { Initializations++; return new object(); }
    public static int Update(int value) { Events += value + ";"; return value; }
}
public record struct Value<T>(int First, int Second) {
    public object Anchor = Trace.Identity();
    private readonly object saved = new object();
    public T Payload;
    public object Hidden() => saved;
    public Value<T> Copy(int value) => this with { Second = Trace.Update(21), First = Trace.Update(value) };
}`)
        let image = Compile(native.DirectoryPath, `package ValueCopy4776
import NativeCopy4776
public data struct Value[T any](First int32, Second int32) {
    public var Anchor object = Trace.Identity()
    private let Saved object = System.Object()
    public var Payload T
    public func Hidden() object -> Saved
    public func Receive() Value[T] {
        Trace.Events = Trace.Events + "R;"
        return this
    }
    public func Copy(value int32) Value[T] ->
        this.Receive() with { Second = Trace.Update(21), First = Trace.Update(value) }
    public func Sugar(value int32) Value[T] ->
        this.Receive().copy(Second: Trace.Update(21), First: Trace.Update(value))
    public func Empty() Value[T] -> this with { }
}`, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(image, []string{native.AssemblyPath})
        using let caller = CSharpFixture((`using NativeCopy4776;
public static class Probe {
    private static void Check(bool value, string reason) {
        if (!value) throw new System.Exception(reason);
    }
    public static string Run() {
        Trace.Initializations = 0;
        var original = new ValueCopy4776.Value<` + "$csType" + `>(7, 8) { Payload = ` + "$payload" + ` };
        var anchor = original.Anchor;
        var operations = new System.Func<ValueCopy4776.Value<` + "$csType" + `>> [] {
            () => original.Copy(13), () => original.Sugar(13)
        };
        foreach (var operation in operations) {
            Trace.Events = "";
            var copy = operation();
            Check(Trace.Initializations == 1, "copy reran declaration initializer");
            Check(Trace.Events == "R;21;13;", "copy update order");
            Check(copy.First == 13 && copy.Second == 21 && original.First == 7 && original.Second == 8, "copy field values");
            Check(object.ReferenceEquals(anchor, copy.Anchor) && object.ReferenceEquals(anchor, original.Anchor), "copy identity");
            Check(object.ReferenceEquals(original.Hidden(), copy.Hidden()), "private readonly copy identity");
            Check(object.Equals(copy.Payload, original.Payload), "copy payload");
        }
        var empty = original.Empty();
        Check(Trace.Initializations == 1 && object.ReferenceEquals(empty.Anchor, anchor), "empty copy construction");
        Trace.Initializations = 0;
        var native = new NativeCopy4776.Value<` + "$csType" + `>(7, 8) { Payload = ` + "$payload" + ` };
        Trace.Events = "";
        var nativeCopy = native.Copy(13);
        Check(Trace.Initializations == 1 && Trace.Events == "21;13;", "native copy oracle");
        Check(nativeCopy.First == 13 && nativeCopy.Second == 21 && native.First == 7 && native.Second == 8, "native field oracle");
        Check(object.ReferenceEquals(native.Anchor, nativeCopy.Anchor) && object.Equals(native.Payload, nativeCopy.Payload), "native state oracle");
        Check(object.ReferenceEquals(native.Hidden(), nativeCopy.Hidden()), "native private readonly oracle");
        return "fresh-once|receiver-once|ordered|state";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(Path.ChangeExtension(image, ".ref.dll")),
                MetadataReference.CreateFromFile(native.AssemblyPath)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{image, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(image),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        Assert.Equal(
            "fresh-once|receiver-once|ordered|state",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
    }

    @Theory
    @InlineData("int", "42", false)
    @InlineData("string", "\"payload\"", false)
    @InlineData("int", "42", true)
    func ClassCopyTree_CallsVirtualTypedCloneAndPreservesLiveState(csType string, payload string, throughBase bool) {
        using let native = CSharpFixture(`using System;
using System.Linq.Expressions;
namespace NativeCopy4776;
public static class Trace {
    public static int Initializations;
    public static string Events = "";
    public static object Identity() { Initializations++; return new object(); }
    public static int Update(int value) { Events += value + ";"; return value; }
}
public record Root<T>(int First) {
    private readonly object anchor = Trace.Identity();
    public T Payload;
    public int State;
    public object Anchor() => anchor;
    public Root<T> Receive() { Trace.Events += "R;"; return this; }
}
public record Leaf<T>(int Second) : Root<T>(7);
public static class Oracle {
    public static Expression<Func<Root<T>>> Build<T>(Root<T> original) {
        var received = Expression.Variable(typeof(Root<T>), "received");
        var copied = Expression.Variable(typeof(Root<T>), "copied");
        var clone = typeof(Root<T>).GetMethod("<Clone>$", Type.EmptyTypes);
        var update = typeof(Trace).GetMethod(nameof(Trace.Update));
        return Expression.Lambda<Func<Root<T>>>(Expression.Block(new[] { received, copied },
            Expression.Assign(received, Expression.Call(Expression.Constant(original), typeof(Root<T>).GetMethod("Receive"))),
            Expression.Assign(copied, Expression.Call(received, clone)),
            Expression.Assign(Expression.Field(copied, "State"), Expression.Call(update, Expression.Constant(21))),
            Expression.Assign(Expression.Property(copied, "First"), Expression.Call(update, Expression.Constant(13))),
            copied));
    }
}`)
        let image = Compile(native.DirectoryPath, `package ClassCopyTree4776
import System
import System.Linq.Expressions
import NativeCopy4776
public open data class Root[T any](First int32) {
    private let Saved object = Trace.Identity()
    public var Payload T
    public var State int32
    public func Anchor() object -> Saved
    public func Receive() Root[T] {
        Trace.Events = Trace.Events + "R;"
        return this
    }
}
public data class Leaf[T any](Second int32) : Root[T](7) {
    public func ReceiveLeaf() Leaf[T] {
        Trace.Events = Trace.Events + "R;"
        return this
    }
}
public class Api {
    shared {
        public func Build[T any](original Leaf[T]) Expression[Func[Leaf[T]]] ->
            () -> original.ReceiveLeaf() with { State = Trace.Update(21), First = Trace.Update(13) }
        public func Sugar[T any](original Leaf[T]) Expression[Func[Leaf[T]]] ->
            () -> original.ReceiveLeaf().copy(State: Trace.Update(21), First: Trace.Update(13))
        public func Base[T any](original Root[T]) Expression[Func[Root[T]]] ->
            () -> original.Receive() with { State = Trace.Update(21), First = Trace.Update(13) }
        public func Scalar() Expression[Func[int32]] -> () -> 7
    }
}`, native.AssemblyPath)
        IlVerifier.Verify(native.AssemblyPath)
        IlVerifier.Verify(image, []string{native.AssemblyPath})
        using let caller = CSharpFixture((`using NativeCopy4776;
using ClassCopyTree4776;
using System.Linq.Expressions;
public static class Probe {
    private static void Check(bool value, string reason) {
        if (!value) throw new System.Exception(reason);
    }
    public static string Run() {
        Trace.Initializations = 0;
        var original = new ClassCopyTree4776.Leaf<` + "$csType" + `>(8) { State = 31 };
        var anchor = original.Anchor();
        var tree = ` + "${(if throughBase { "Api.Base(original)" } else { "Api.Build(original)" })}" + `;
        Check(Trace.Initializations == 1 && Trace.Events == "", "tree construction executed copy");
        original.State = 41;
        original.Payload = ` + "$payload" + `;
        var run = tree.Compile();
        for (var index = 0; index < 2; index++) {
            Trace.Events = "";
            var copy = run();
            Check(copy.GetType() == original.GetType() && !object.ReferenceEquals(copy, original), "virtual clone runtime identity");
            Check(copy.First == 13 && copy.State == 21 && ((ClassCopyTree4776.Leaf<` + "$csType" + `>)copy).Second == 8, "clone values");
            Check(original.First == 7 && original.State == 41 && original.Second == 8, "original state");
            Check(object.ReferenceEquals(copy.Anchor(), anchor) && object.Equals(copy.Payload, original.Payload), "private base copy state");
            Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;", "tree clone once and order");
        }
        var sugar = Api.Sugar(original).Compile();
        Trace.Events = "";
        var sugarCopy = sugar();
        Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;" && object.ReferenceEquals(sugarCopy.Anchor(), anchor), "copy sugar tree");
        Trace.Initializations = 0;
        Trace.Events = "";
        var native = new NativeCopy4776.Leaf<` + "$csType" + `>(8) { Payload = ` + "$payload" + `, State = 41 };
        var nativeTree = Oracle.Build<` + "$csType" + `>(native);
        Check(Trace.Initializations == 1 && Trace.Events == "", "native tree creation");
        Trace.Events = "";
        var nativeCopy = nativeTree.Compile()();
        Check(nativeCopy.GetType() == native.GetType() && !object.ReferenceEquals(nativeCopy, native), "native virtual clone");
        Check(nativeCopy.First == 13 && nativeCopy.State == 21 && ((NativeCopy4776.Leaf<` + "$csType" + `>)nativeCopy).Second == 8, "native tree values");
        Check(object.ReferenceEquals(nativeCopy.Anchor(), native.Anchor()) && object.Equals(nativeCopy.Payload, native.Payload), "native private state");
        Check(Trace.Initializations == 1 && Trace.Events == "R;21;13;" && native.State == 41, "native once and order");
        Check(Api.Scalar().Compile()() == 7, "supported tree control");
        return "virtual|private-base|typed|live|once|ordered";
    }
}`), []PortableExecutableReference{
                MetadataReference.CreateFromFile(Path.ChangeExtension(image, ".ref.dll")),
                MetadataReference.CreateFromFile(native.AssemblyPath)
            })
        IlVerifier.Verify(caller.AssemblyPath, []string{image, native.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(
            native.DirectoryPath,
            File.ReadAllBytes(native.AssemblyPath),
            File.ReadAllBytes(image),
            File.ReadAllBytes(caller.AssemblyPath)
        )
        Assert.Equal(
            "virtual|private-base|typed|live|once|ordered",
            assemblies[2].GetType("Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
        let api Type? = assemblies[1].GetType("ClassCopyTree4776.Api")
        let owner = assemblies[1].GetType("ClassCopyTree4776.Leaf`1")!!.MakeGenericType(
            if csType == "int" {
                typeof(int32)
            } else {
                typeof(string)
            }
        )
        let originalObject object? = Activator.CreateInstance(owner, 8)
        let method = api!!.GetMethod(
            if throughBase {
                "Base"
            } else {
                "Build"
            }
        )!!.MakeGenericMethod(
            if csType == "int" {
                typeof(int32)
            } else {
                typeof(string)
            }
        )
        let tree = Assert.IsAssignableFrom[ExpressionsLambdaExpression](method.Invoke(nil, []object{originalObject}))
        let visitor = CopyVisitor()
        visitor.Visit(tree.Body)
        let clone = Assert.Single(visitor.Clones)
        Assert.True(clone.Method.IsVirtual)
        Assert.Equal(tree.ReturnType, clone.Method.DeclaringType)
        Assert.Equal(tree.ReturnType, clone.Method.ReturnType)
        Assert.Empty(clone.Arguments)
        Assert.Empty(visitor.Constructions)
    }

    @Fact
    func ImportedClassCopyTree_KeepsExistingPreciseUnsupportedBoundary() {
        using let native = CSharpFixture("namespace NativeCopy4776; public record Root<T>(T Value);")
        const expression = "original with { }"
        let source = (`package ImportedCopyTree4776
import System
import System.Linq.Expressions
import NativeCopy4776
public func Build(original Root[int32]) Expression[Func[Root[int32]]] -> () -> ` + "$expression")
        using let references = native.RuntimeReferences()
        let compilation = GsCompilation(references, GsSyntaxTree.Parse(GsSourceText.From(source))){IsLibrary = true}
        using let image = MemoryStream()
        let result = compilation.Emit(image, pdbStream: nil, refStream: nil, assemblyName: "UnsupportedCopyTree")
        Assert.False(result.Success)
        let diagnostic = Assert.Single(
            result.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0473")
        )
        Assert.Equal(expression, source.Substring(diagnostic.Location.Span.Start, diagnostic.Location.Span.Length))
    }

    private class CopyVisitor : ExpressionVisitor {
        init() {
            Clones = List[MethodCallExpression]()
            Constructions = List[NewExpression]()
        }

        prop Clones List[MethodCallExpression] {
            get;
        }

        prop Constructions List[NewExpression] {
            get;
        }

        protected override func VisitMethodCall(node MethodCallExpression) Expression {
            if node.Method.Name == "<Clone>$$" {
                Clones.Add(node)
            }
            return base.VisitMethodCall(node)
        }

        protected override func VisitNew(node NewExpression) Expression {
            Constructions.Add(node)
            return base.VisitNew(node)
        }
    }

    shared {
        private func Compile(directory string, source string, reference string) string {
            let sourcePath = Path.Combine(directory, "Fixture.gs")
            let image = Path.Combine(directory, "Fixture.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let exit = Program.Main(
                    []string{
                        "/target:library",
                        "/targetframework:net10.0",
                        "/assemblyname:Fixture",
                        "/out:" + image,
                        "/refout:" + Path.ChangeExtension(image, ".ref.dll"),
                        "/reference:" + reference,
                        sourcePath
                    }
                )
                Assert.True(exit == 0, (`gsc exited ` + "$exit" + `
` + "$stdout" + `
` + "$stderr"))
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(File.Exists(image))
            Assert.True(File.Exists(Path.ChangeExtension(image, ".ref.dll")))
            return image
        }
    }
}
