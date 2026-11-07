// <copyright file="Issue4756TupleOverrideContractTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection
import Xunit

class Issue4756TupleOverrideContractTests {
    @Theory
    @InlineData("Task", "none", false, int32(3))
    @InlineData("ValueTask", "none", false, int32(3))
    @InlineData("Task", "open", false, int32(4))
    @InlineData("ValueTask", "open", false, int32(4))
    @InlineData("Task", "closed", false, int32(4))
    @InlineData("ValueTask", "closed", false, int32(4))
    @InlineData("Task", "none", true, int32(4))
    @InlineData("ValueTask", "none", true, int32(4))
    @InlineData("Task", "open", true, int32(8))
    @InlineData("ValueTask", "open", true, int32(8))
    func ImportedAsyncTuple_OverridesAndImplements(envelope string, genericMode string, isInterface bool, arity int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let generic = genericMode != "none"
        let isOpen = genericMode == "open"
        let kind = if isInterface {
            "interface"
        } else {
            "abstract class"
        }
        let nativeGeneric = if generic {
            "<T> where T : class"
        } else {
            ""
        }
        let nativeRequired = if generic {
            "T"
        } else {
            "Box"
        }
        let sourceGeneric = if isOpen {
            "[T class]"
        } else {
            ""
        }
        let sourceRequired = if isOpen {
            "T"
        } else {
            "Box"
        }
        let parent = if isOpen {
            "Contract[T]"
        } else if generic {
            "Contract[Box]"
        } else {
            "Contract"
        }
        let overrideModifier = if isInterface {
            ""
        } else {
            "override "
        }
        let abstractModifier = if isInterface {
            ""
        } else {
            "abstract "
        }
        let nullableValueNative = if arity >= 4 {
            ", int? Number"
        } else {
            ""
        }
        let nullableValueSource = if arity >= 4 {
            ", Number int32?"
        } else {
            ""
        }
        let nullableValueResult = if arity >= 4 {
            ", nil"
        } else {
            ""
        }
        let tailNative = if arity == 8 {
            ", int D, int E, int F, OptionalBox? Last"
        } else {
            ""
        }
        let tailSource = if arity == 8 {
            ", D int32, E int32, F int32, Last OptionalBox?"
        } else {
            ""
        }
        let tailResult = if arity == 8 {
            ", 4, 5, 6, nil"
        } else {
            ""
        }
        let nativeTuple = "($nativeRequired Required, OptionalBox? Optional, int Code$nullableValueNative$tailNative)"
        let sourceTuple = "(Required $sourceRequired, Optional OptionalBox?, Code int32$nullableValueSource$tailSource)"
        let sourceReturn = if envelope == "ValueTask" {
            "ValueTask[$sourceTuple]"
        } else {
            sourceTuple
        }
        let native = fixture.CompileCSharp(
            "#nullable enable\nusing System.Threading.Tasks;\nnamespace Tuple4756;\n" +
                "public sealed class Box { }\npublic sealed class OptionalBox { }\n" +
                "public $kind Contract$nativeGeneric { public ${abstractModifier}$envelope<$nativeTuple> Read($nativeRequired value); }",
            "native4756"
        )
        let emitted = fixture.Compile(
            "package Tuple4756\nimport System.Threading.Tasks\n" +
                "class Rows$sourceGeneric : $parent {\n" +
                "    ${overrideModifier}async func Read(value $sourceRequired) $sourceReturn {\n" +
                "        return (value, nil, 3$nullableValueResult$tailResult)\n    }\n}",
            "Tuple4756",
            executable: false,
            "/r:" + native
        )
        let closedRows = if isOpen {
            "Rows<Box>"
        } else {
            "Rows"
        }
        let closedContract = if generic {
            "Contract<Box>"
        } else {
            "Contract"
        }
        let valueCheck = if arity >= 4 {
            " || row.Number != null"
        } else {
            ""
        }
        let tailCheck = if arity == 8 {
            " || row.D != 4 || row.E != 5 || row.F != 6 || row.Last != null"
        } else {
            ""
        }
        let consumer = fixture.CompileCSharp(
            "using System;\nusing Tuple4756;\npublic static class Consumer {\n" +
                "public static string Run() { $closedContract rows = new $closedRows(); var value = new Box();\n" +
                "var row = rows.Read(value).GetAwaiter().GetResult();\n" +
                "if (!ReferenceEquals(value, row.Required) || row.Optional != null || row.Code != 3$valueCheck$tailCheck) " +
                "throw new Exception(\"tuple contract\"); return \"tuple:required-identity;nullable-leaves:nil;code:3\"; }\n}",
            "consumer4756",
            native,
            emitted
        )
        VerifyAndRun(native, emitted, consumer, "tuple:required-identity;nullable-leaves:nil;code:3")
    }

    @Theory
    @InlineData("disable", "Box?", true, "")
    @InlineData("disable", "Box", true, "")
    @InlineData("enable", "Box?", false, "")
    @InlineData("enable", "Box", true, "")
    @InlineData("disable", "Box?", true, "Task")
    @InlineData("disable", "Box", true, "Task")
    @InlineData("enable", "Box?", false, "Task")
    @InlineData("enable", "Box", true, "Task")
    @InlineData("disable", "Box?", true, "ValueTask")
    @InlineData("disable", "Box", true, "ValueTask")
    @InlineData("enable", "Box?", false, "ValueTask")
    @InlineData("enable", "Box", true, "ValueTask")
    func ImportedTupleOverride_DistinguishesObliviousAndStatedNonNull(
        context string,
        leaf string,
        accepted bool,
        envelope string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let nativeReturn = if envelope == "" {
            "(Box Value, int Code)"
        } else {
            "$envelope<(Box Value, int Code)>"
        }
        let sourceReturn = if envelope == "ValueTask" {
            "ValueTask[(Value $leaf, Code int32)]"
        } else {
            "(Value $leaf, Code int32)"
        }
        let asyncModifier = if envelope == "" {
            ""
        } else {
            "async "
        }
        let native = fixture.CompileCSharp(
            "#nullable $context\nusing System.Threading.Tasks;\nnamespace Tuple4795;\npublic sealed class Box { }\n" +
                "public abstract class Contract { public abstract $nativeReturn Read(bool choose); }",
            "native4795"
        )
        let result = if leaf == "Box?" {
            "(nil, 1)"
        } else {
            "(Box(), 1)"
        }
        let (exit, output) = fixture.TryCompile(
            "package Tuple4795\nimport System.Threading.Tasks\nclass Rows : Contract {\n" +
                "    override ${asyncModifier}func Read(choose bool) $sourceReturn -> $result\n}",
            "Tuple4795",
            executable: false,
            "/r:" + native
        )
        let emitted = Path.Combine(fixture.Directory, "Tuple4795.dll")
        if !accepted {
            Assert.NotEqual(0, exit)
            Assert.Contains("error GS0185", output, StringComparison.Ordinal)
            let column = if envelope == "" {
                19
            } else {
                25
            }
            Assert.Contains("Tuple4795.gs(4,$column,4,", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
            Assert.False(File.Exists(emitted))
            return
        }
        Assert.True(exit == 0, output)
        let expectedNil = if leaf == "Box?" {
            "true"
        } else {
            "false"
        }
        let awaitSuffix = if envelope == "" {
            ""
        } else {
            ".GetAwaiter().GetResult()"
        }
        let consumer = fixture.CompileCSharp(
            "using System;\nusing Tuple4795;\npublic static class Consumer {\n" +
                "public static string Run() { Contract rows = new Rows(); var row = rows.Read(false)$awaitSuffix;\n" +
                "if ((row.Value == null) != $expectedNil || row.Code != 1) throw new Exception(\"return\");\n" +
                "return \"tuple:base-dispatch;code:1\"; }\n}",
            "consumer4795",
            native,
            emitted
        )
        VerifyAndRun(native, emitted, consumer, "tuple:base-dispatch;code:1")
    }

    @Theory
    @InlineData("Task", "disable", "", true)
    @InlineData("ValueTask", "disable", "", true)
    @InlineData("Task", "enable", "", false)
    @InlineData("ValueTask", "enable", "", false)
    @InlineData("Task", "enable", "?", true)
    @InlineData("ValueTask", "enable", "?", true)
    func ImportedGenericMethodTuple_PreservesEachLeafContract(
        envelope string,
        context string,
        requiredAnnotation string,
        accepted bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let optionalAnnotation = if context == "enable" {
            "?"
        } else {
            ""
        }
        let native = fixture.CompileCSharp(
            "#nullable $context\nusing System.Threading.Tasks;\nnamespace Generic4756;\n" +
                "public sealed class Box { }\npublic abstract class Contract {\n" +
                "public abstract $envelope<(T Value, Box$requiredAnnotation Required, Box$optionalAnnotation Optional)> " +
                "Read<T>(T value) where T : class;\n}",
            "nativeGeneric4756"
        )
        let tuple = "(Value U, Required Box?, Optional Box?)"
        let sourceReturn = if envelope == "ValueTask" {
            "ValueTask[$tuple]"
        } else {
            tuple
        }
        let (exit, output) = fixture.TryCompile(
            "package Generic4756\nimport System.Threading.Tasks\nclass Rows : Contract {\n" +
                "    override async func Read[U class](value U) $sourceReturn -> (value, nil, nil)\n}",
            "Generic4756",
            executable: false,
            "/r:" + native
        )
        let emitted = Path.Combine(fixture.Directory, "Generic4756.dll")
        if !accepted {
            Assert.NotEqual(0, exit)
            Assert.Contains("error GS0185", output, StringComparison.Ordinal)
            Assert.Contains("Generic4756.gs(4,25,4,", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
            Assert.False(File.Exists(emitted))
            return
        }
        Assert.True(exit == 0, output)
        let consumer = fixture.CompileCSharp(
            "using System;\nusing Generic4756;\npublic static class Consumer {\n" +
                "public static string Run() { Contract rows = new Rows(); var value = new Box();\n" +
                "var row = rows.Read(value).GetAwaiter().GetResult();\n" +
                "if (!ReferenceEquals(value, row.Value) || row.Required != null || row.Optional != null) " +
                "throw new Exception(\"generic return\"); return \"generic:identity;nullable-leaves:nil\"; }\n}",
            "consumerGeneric4756",
            native,
            emitted
        )
        VerifyAndRun(native, emitted, consumer, "generic:identity;nullable-leaves:nil")
    }

    @Theory
    @InlineData("string?", "string?", "null", "nullable")
    @InlineData("[]string?", "string?[]", "new string?[] { null, \"x\" }", "array")
    @InlineData("(Value string?, Code int32)", "(string? Value, int Code)", "(null, 7)", "tuple")
    func NamedDelegateReturn_NativeReflectionMatchesRoslyn(
        sourceReturn string,
        nativeReturn string,
        expression string,
        shape string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let native = fixture.CompileCSharp(
            "#nullable enable\nnamespace Delegate4763;\npublic delegate $nativeReturn Result(string value);",
            "native4763"
        )
        let emitted = fixture.Compile(
            "package Delegate4763\ndelegate Result(value string) $sourceReturn;",
            "delegate4763",
            executable: false
        )
        let expected = switch shape {
            case "array": "NotNull/Nullable"
            case "tuple": "NotNull/Nullable/NotNull"
            default: "Nullable"
        }
        for producer in[]string{native, emitted} {
            IlVerifier.Verify(producer)
            let consumer = fixture.CompileCSharp(`#nullable enable
using System;
using System.Reflection;
using Delegate4763;
public static class Consumer {
    public static string Run() {
        Result callback = value => ` + expression + `;
        var result = callback("x");
        ` + switch shape {
                    case "array": "if (result.Length != 2 || result[0] != null || result[1] != \"x\") throw new Exception(\"array\");"
                    case "tuple": "if (result.Value != null || result.Code != 7) throw new Exception(\"tuple\");"
                    default: "if (result != null) throw new Exception(\"nullable\");"
                } + `
        var invoke = typeof(Result).GetMethod("Invoke") ?? throw new Exception("Invoke");
        var context = new NullabilityInfoContext();
        if (context.Create(invoke.GetParameters()[0]).ReadState != NullabilityState.NotNull)
            throw new Exception("parameter");
        var info = context.Create(invoke.ReturnParameter);
        var states = info.ReadState.ToString();
        if (info.ElementType != null) states += "/" + info.ElementType.ReadState;
        foreach (var argument in info.GenericTypeArguments) states += "/" + argument.ReadState;
        return states;
    }
}`, Path.GetFileNameWithoutExtension(producer) + "Consumer", producer)
            IlVerifier.Verify(consumer, []string{producer})
            let pair = EmittedFixture.LoadTogether(producer, consumer)
            let entry = pair[1].GetType("Consumer", throwOnError: true)!!.GetMethod("Run")!!
            Assert.Equal(expected, entry.Invoke(nil, nil))
        }
    }

    shared {
        private func VerifyAndRun(native string, emitted string, consumer string, expected string) {
            IlVerifier.Verify(native)
            IlVerifier.Verify(emitted, []string{native})
            IlVerifier.Verify(consumer, []string{native, emitted})
            let assemblies = EmittedFixture.LoadTogether(native, emitted, consumer)
            let entry = assemblies[2].GetType("Consumer", throwOnError: true)!!.GetMethod("Run")!!
            Assert.Equal(expected, entry.Invoke(nil, nil))
        }
    }
}
