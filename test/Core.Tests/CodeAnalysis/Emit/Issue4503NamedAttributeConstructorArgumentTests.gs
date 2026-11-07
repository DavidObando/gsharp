// <copyright file="Issue4503NamedAttributeConstructorArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import GSharp.Tests
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

/// Issue #4503: named constructor arguments belong in fixed-argument slots.
class Issue4503NamedAttributeConstructorArgumentTests {
    @Fact
    func GeneratedRegexNamedTimeout_IsAReadableConstructorArgument() {
        let result = Emit(`import System.Text.RegularExpressions

@GeneratedRegex("a", RegexOptions.None, matchTimeoutMilliseconds: 1000)
func Pattern() {
}`)
        Assert.True(result.Success, FormatDiagnostics(result))
        let assembly = EmittedFixture.Load(result.Image)
        let method MethodInfo? = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "<Program>")
            .GetMethod("Pattern")
        let data = Assert.Single(
            method!!.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute.AttributeType == typeof(GeneratedRegexAttribute)
        )
        Assert.Equal(
            []object{"a", 0, 1000},
            data.ConstructorArguments.Select((argument CustomAttributeTypedArgument) -> argument.Value)
        )
        Assert.Empty(data.NamedArguments)
    }

    @Fact
    func NamedConstructorArguments_AreReordered_Defaulted_AndReadable() {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit(`import Issue4503.Contracts

@ImportedNamedConstructor("first", third: 30, Label = "ok", Code = 40)
class Tagged {
}`, contracts.Path)
        Assert.True(result.Success, FormatDiagnostics(result))
        let (contractAssembly, assembly) = contracts.LoadWith(result.Image)
        let tagged = assembly.GetTypes().Single((type Type) -> type.Name == "Tagged")
        let namedAttributeType = contractAssembly.GetTypes().Single(
            (type Type) -> type.Name == "ImportedNamedConstructorAttribute"
        )
        let data = tagged.GetCustomAttributesData().Single(
            (attribute CustomAttributeData) -> attribute.AttributeType == namedAttributeType
        )
        Assert.Equal(
            []object{"first", 2, 30},
            data.ConstructorArguments.Select((argument CustomAttributeTypedArgument) -> argument.Value)
        )
        Assert.Equal(
            []string{"Code", "Label"},
            data
                .NamedArguments
                .Select((argument CustomAttributeNamedArgument) -> argument.MemberName)
                .OrderBy((name string) -> name)
        )
        Assert.True(
            data
                .NamedArguments
                .Single((argument CustomAttributeNamedArgument) -> argument.MemberName == "Label")
                .IsField == false
        )
        Assert.True(
            data.NamedArguments.Single((argument CustomAttributeNamedArgument) -> argument.MemberName == "Code").IsField
        )
        let instance = tagged.GetCustomAttributes(namedAttributeType, inherit: false).Single()
        Assert.Equal("first", namedAttributeType.GetProperty("First")?.GetValue(instance))
        Assert.Equal(2, namedAttributeType.GetProperty("Second")?.GetValue(instance))
        Assert.Equal(30, namedAttributeType.GetProperty("Third")?.GetValue(instance))
        Assert.Equal("ok", namedAttributeType.GetProperty("Label")?.GetValue(instance))
        Assert.Equal(40, namedAttributeType.GetField("Code")?.GetValue(instance))
    }

    @Fact
    func SameCompilationNamedConstructorArguments_AreReorderedAndDefaulted() {
        let result = Emit(`import System

class LocalAttribute(First string, Second int32 = 2, Third int32 = 3) : Attribute {
}

@Local("first", Third: 30)
class Tagged {
}`)
        Assert.True(result.Success, FormatDiagnostics(result))
        let assembly = EmittedFixture.Load(result.Image)
        let tagged = assembly.GetTypes().Single((type Type) -> type.Name == "Tagged")
        let data = tagged.GetCustomAttributesData().Single(
            (attribute CustomAttributeData) -> attribute.AttributeType.Name == "LocalAttribute"
        )
        Assert.Equal(
            []object{"first", 2, 30},
            data.ConstructorArguments.Select((argument CustomAttributeTypedArgument) -> argument.Value)
        )
    }

    @Fact
    func ParamsConstructorArguments_PreserveDirectAndExpandedForms() {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit(`import Issue4503.Contracts

@ImportedParamsConstructor("expanded", 1, 2)
class Expanded {
}

@ImportedParamsConstructor(values: []int32{3, 4}, name: "direct")
class Direct {
}`, contracts.Path)
        Assert.True(result.Success, FormatDiagnostics(result))
        let (contractAssembly, assembly) = contracts.LoadWith(result.Image)
        let paramsAttributeType = contractAssembly.GetTypes().Single(
            (type Type) -> type.Name == "ImportedParamsConstructorAttribute"
        )
        let expanded = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "Expanded")
            .GetCustomAttributes(paramsAttributeType, inherit: false)
            .Single()
        let direct = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "Direct")
            .GetCustomAttributes(paramsAttributeType, inherit: false)
            .Single()
        Assert.Equal("expanded", paramsAttributeType.GetProperty("Name")?.GetValue(expanded))
        Assert.Equal([]int32{1, 2}, paramsAttributeType.GetProperty("Values")?.GetValue(expanded))
        Assert.Equal("direct", paramsAttributeType.GetProperty("Name")?.GetValue(direct))
        Assert.Equal([]int32{3, 4}, paramsAttributeType.GetProperty("Values")?.GetValue(direct))
    }

    @Fact
    func InPositionNamedArguments_CanPrecedePositionalArguments() {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit(`import System
import Issue4503.Contracts

@ImportedNamedConstructor(first: "imported", 20, third: 30)
class ImportedMixed {
}

class LocalAttribute(First string, Second int32, Third int32) : Attribute {
}

@Local(First: "local", 20, Third: 30)
class LocalMixed {
}`, contracts.Path)
        Assert.True(result.Success, FormatDiagnostics(result))
        let (contractAssembly, assembly) = contracts.LoadWith(result.Image)
        let namedAttributeType = contractAssembly.GetTypes().Single(
            (type Type) -> type.Name == "ImportedNamedConstructorAttribute"
        )
        let importedData = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "ImportedMixed")
            .GetCustomAttributesData()
            .Single((attribute CustomAttributeData) -> attribute.AttributeType == namedAttributeType)
        let localData = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "LocalMixed")
            .GetCustomAttributesData()
            .Single((attribute CustomAttributeData) -> attribute.AttributeType.Name == "LocalAttribute")
        Assert.Equal(
            []object{"imported", 20, 30},
            importedData.ConstructorArguments.Select((argument CustomAttributeTypedArgument) -> argument.Value)
        )
        Assert.Equal(
            []object{"local", 20, 30},
            localData.ConstructorArguments.Select((argument CustomAttributeTypedArgument) -> argument.Value)
        )
    }

    @Fact
    func SameCompilationOverloads_WithDifferentParameterNames_SelectMatchingCandidate() {
        let result = Emit(`import System

class LocalAttribute : Attribute {
    init(Value int32) {
    }

    init(Text string) {
    }
}

@Local(Text: "ok")
class Tagged {
}`)
        Assert.True(result.Success, FormatDiagnostics(result))
        let assembly = EmittedFixture.Load(result.Image)
        let data = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "Tagged")
            .GetCustomAttributesData()
            .Single((attribute CustomAttributeData) -> attribute.AttributeType.Name == "LocalAttribute")
        Assert.Equal("ok", Assert.Single(data.ConstructorArguments).Value)
    }

    @Fact
    func SameCompilationExactConstructor_OutranksOptionalPrimaryConstructor() {
        let result = Emit(`import System

class LocalAttribute(Value int32 = 1) : Attribute {
    init() {
    }
}

@Local
class Tagged {
}`)
        Assert.True(result.Success, FormatDiagnostics(result))
        let assembly = EmittedFixture.Load(result.Image)
        let data = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "Tagged")
            .GetCustomAttributesData()
            .Single((attribute CustomAttributeData) -> attribute.AttributeType.Name == "LocalAttribute")
        Assert.Empty(data.ConstructorArguments)
    }

    @Fact
    func ValueAndNullableValueOverloads_PreferNonNullableCandidate() {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit(`import System
import Issue4503.Contracts

@ImportedValueOrNullableValue(DayOfWeek.Monday)
class EnumTagged {
}

@ImportedValueOrNullableValue(5)
class IntTagged {
}`, contracts.Path)
        Assert.True(result.Success, FormatDiagnostics(result))
        let (_, assembly) = contracts.LoadWith(result.Image)
        let enumData = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "EnumTagged")
            .GetCustomAttributesData()
            .Single(
            (attribute CustomAttributeData) -> attribute.AttributeType.Name == "ImportedValueOrNullableValueAttribute"
        )
        let intData = assembly
            .GetTypes()
            .Single((type Type) -> type.Name == "IntTagged")
            .GetCustomAttributesData()
            .Single(
            (attribute CustomAttributeData) -> attribute.AttributeType.Name == "ImportedValueOrNullableValueAttribute"
        )
        Assert.Equal(typeof(DayOfWeek), Assert.Single(enumData.Constructor.GetParameters()).ParameterType)
        Assert.Equal(typeof(int32), Assert.Single(intData.Constructor.GetParameters()).ParameterType)
    }

    @Theory
    @InlineData("@ImportedNamedConstructor(\"a\", first: \"b\")", "GS0247")
    @InlineData("@ImportedNamedConstructor(\"a\", second: 2, second: 3)", "GS0245")
    @InlineData("@ImportedNamedConstructor(\"a\", Missing: 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(\"a\", Missing = 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(Missing = 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(\"a\", Label = 1)", "GS0614")
    @InlineData("@ImportedNamedConstructor(\"a\", Item = 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(\"a\", Unsupported = nil)", "GS0615")
    @InlineData("@ImportedNullableProperty(Value = nil)", "GS0615")
    @InlineData("@ImportedNullableProperty(Value = 5)", "GS0615")
    @InlineData("@ImportedNullableConstructor(nil)", "GS0585")
    @InlineData("@ImportedNullableConstructor(5)", "GS0585")
    @InlineData("@ImportedNullableConstructor(value: 5)", "GS0585")
    @InlineData("@ImportedNullableOrObject(nil)", "GS0585")
    @InlineData("@ImportedNullableOrObject(5)", "GS0585")
    @InlineData("@ImportedComparableOrObject(5)", "GS0585")
    @InlineData("@ImportedDayOfWeekOrNullable(nil)", "GS0585")
    @InlineData("@ImportedIntOrNullable(nil)", "GS0585")
    @InlineData("@ImportedNamedConstructor(third: 3, 2)", "GS0583")
    @InlineData("@ImportedNamedConstructor(Label = \"ok\", \"a\")", "GS0616")
    func InvalidNamedAttributeArguments_ReportClearDiagnostics(annotation string, expectedId string) {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit((`import Issue4503.Contracts

` + "$annotation" + `
class Tagged {
}`), contracts.Path)
        let diagnostic = Assert.Single(result.Diagnostics, (item Diagnostic) -> item.Id == expectedId)
        Assert.Equal(2, diagnostic.Location.StartLine)
        Assert.False(result.Success)
    }

    @Fact
    func SameCompilationDuplicateNamedConstructorArgument_ReportsDuplicateDiagnostic() {
        let result = Emit(`import System

class LocalAttribute(Value int32 = 0) : Attribute {
}

@Local(Value: 1, Value: 2)
class Tagged {
}`)
        let diagnostic = Assert.Single(result.Diagnostics, (item Diagnostic) -> item.Id == "GS0245")
        Assert.Equal(5, diagnostic.Location.StartLine)
        Assert.False(result.Success)
    }

    @Fact
    func SameCompilationNamedPropertyAndFieldArguments_AreEncodedAndReadable() {
        let result = Emit(`import System

enum StampKind {
    Ordinary,
    Special
}

open class BaseStampAttribute : Attribute {
    var InheritedCode int32
    prop InheritedFlag bool { get; set; }
}

@AttributeUsage(AttributeTargets.Class | AttributeTargets.Parameter)
class StampAttribute : BaseStampAttribute {
    var Code int32
    var WideCode int64
    prop Label string { get; set; }
    prop Visible bool { get; set; }
    prop SmallByte uint8 { get; set; }
    prop Ratio float64 { get; set; }
    prop Kind StampKind { get; set; }
    prop Target Type? { get; set; }
    prop BoxedValue object? { get; set; }
    prop ExplicitlyBoxedValue object? { get; set; }

    init(label string, code int32) {
        Label = label
        Code = code
    }
}

class Node {
}

@Stamp("class", 7, Visible = true, WideCode = 1, SmallByte = 5, Ratio = 3, Kind = StampKind.Special, Target = typeof(Node), BoxedValue = StampKind.Special, ExplicitlyBoxedValue = cast[object](StampKind.Special), InheritedFlag = true, InheritedCode = 42)
class Holder {
}

func (@Stamp("receiver", int32(17), Visible = true, Code = 99, BoxedValue = typeof(Node), ExplicitlyBoxedValue = cast[object](typeof(Node))) node Node) TryNode() bool -> true`)
        Assert.True(result.Success, FormatDiagnostics(result))
        let assembly = EmittedFixture.Load(result.Image)
        let stampType = assembly.GetTypes().Single((type Type) -> type.Name == "StampAttribute")
        let stampKindType = assembly.GetTypes().Single((type Type) -> type.Name == "StampKind")
        let holder = assembly.GetTypes().Single((type Type) -> type.Name == "Holder")
        let holderAttr = holder.GetCustomAttributes(stampType, inherit: false).Single()
        Assert.Equal("class", stampType.GetProperty("Label")?.GetValue(holderAttr))
        Assert.Equal(7, stampType.GetField("Code")?.GetValue(holderAttr))
        Assert.Equal(int64(1), stampType.GetField("WideCode")?.GetValue(holderAttr))
        Assert.Equal(true, stampType.GetProperty("Visible")?.GetValue(holderAttr))
        Assert.Equal(uint8(5), stampType.GetProperty("SmallByte")?.GetValue(holderAttr))
        Assert.Equal(3.0, stampType.GetProperty("Ratio")?.GetValue(holderAttr))
        Assert.Equal(1, Convert.ToInt32(stampType.GetProperty("Kind")?.GetValue(holderAttr)))
        Assert.Equal("Node", (stampType.GetProperty("Target")?.GetValue(holderAttr) as Type)?.Name)
        let boxedEnum = stampType.GetProperty("BoxedValue")?.GetValue(holderAttr)
        Assert.Equal(stampKindType, boxedEnum?.GetType())
        Assert.Equal(1, Convert.ToInt32(boxedEnum))
        let explicitlyBoxedEnum = stampType.GetProperty("ExplicitlyBoxedValue")?.GetValue(holderAttr)
        Assert.Equal(stampKindType, explicitlyBoxedEnum?.GetType())
        Assert.Equal(1, Convert.ToInt32(explicitlyBoxedEnum))
        Assert.Equal(true, stampType.GetProperty("InheritedFlag")?.GetValue(holderAttr))
        Assert.Equal(42, stampType.GetField("InheritedCode")?.GetValue(holderAttr))

        let programType = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
        let tryNodeMethod = programType.GetMethod(
            "TryNode",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(tryNodeMethod)
        let receiverParam = tryNodeMethod!!.GetParameters()[0]
        let paramAttr = receiverParam.GetCustomAttributes(stampType, inherit: false).Single()
        Assert.Equal("receiver", stampType.GetProperty("Label")?.GetValue(paramAttr))
        Assert.Equal(99, stampType.GetField("Code")?.GetValue(paramAttr))
        Assert.Equal(true, stampType.GetProperty("Visible")?.GetValue(paramAttr))
        Assert.Equal("Node", (stampType.GetProperty("BoxedValue")?.GetValue(paramAttr) as Type)?.Name)
        Assert.Equal("Node", (stampType.GetProperty("ExplicitlyBoxedValue")?.GetValue(paramAttr) as Type)?.Name)
    }

    @Fact
    func SourceAttributeInheritingConstructedImportedGenericBase_EncodesSymbolicMemberTypes() {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit(`import Issue4503.Contracts

enum StampKind {
    Ordinary,
    Special
}

class StampAttribute : ImportedGenericStampBaseAttribute[StampKind] {
}

@Stamp(Value = StampKind.Special, Tag = StampKind.Ordinary)
class Holder {
}`, contracts.Path)
        Assert.True(result.Success, FormatDiagnostics(result))
        let (_, assembly) = contracts.LoadWith(result.Image)
        let stampType = assembly.GetTypes().Single((type Type) -> type.Name == "StampAttribute")
        let stampKindType = assembly.GetTypes().Single((type Type) -> type.Name == "StampKind")
        let holder = assembly.GetTypes().Single((type Type) -> type.Name == "Holder")
        let holderAttr = holder.GetCustomAttributes(stampType, inherit: false).Single()
        let propVal = stampType.GetProperty("Value")?.GetValue(holderAttr)
        let fieldVal = stampType.GetField("Tag")?.GetValue(holderAttr)
        Assert.Equal(stampKindType, propVal?.GetType())
        Assert.Equal(1, Convert.ToInt32(propVal))
        Assert.Equal(stampKindType, fieldVal?.GetType())
        Assert.Equal(0, Convert.ToInt32(fieldVal))
    }

    @Theory
    @InlineData("@Stamp(\"a\", 1, Missing = true)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, ReadOnlyField = 2)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, GetOnlyProp = true)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, HiddenGetOnlyProp = true)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, HiddenReadOnlyField = 2)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, HiddenStaticProp = true)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, HiddenStaticField = 2)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, HiddenConstField = 2)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, Item = 2)", "GS0613")
    @InlineData("@Stamp(\"a\", 1, Visible = \"wrong\")", "GS0614")
    @InlineData("@Stamp(\"a\", 1, SmallByte = 300)", "GS0614")
    @InlineData("@Stamp(\"a\", 1, WideCode = cast[object](7))", "GS0614")
    @InlineData("@Stamp(\"a\", 1, BoxedValue = decimal(1))", "GS0614")
    @InlineData("@Stamp(\"a\", 1, BoxedValue = []object{decimal(1)})", "GS0614")
    @InlineData("@Stamp(\"a\", 1, Visible = true, Visible = false)", "GS0245")
    @InlineData("@Stamp(\"a\", 1, NullableValue = 5)", "GS0615")
    func SameCompilationInvalidNamedAttributeMembers_ReportClearDiagnostics(annotation string, expectedId string) {
        let result = Emit((`import System

open class BaseStampAttribute : Attribute {
    var HiddenReadOnlyField int32
    var HiddenStaticField int32
    var HiddenConstField int32
    prop HiddenGetOnlyProp bool { get; set; }
    prop HiddenStaticProp bool { get; set; }
}

class StampAttribute(Label string, Code int32) : BaseStampAttribute {
    const HiddenConstField int32 = 1
    let ReadOnlyField int32 = 1
    let HiddenReadOnlyField int32 = 1
    var WideCode int64
    prop GetOnlyProp bool -> false
    prop HiddenGetOnlyProp bool -> false
    prop Visible bool { get; set; }
    prop SmallByte uint8 { get; set; }
    prop BoxedValue object? { get; set; }
    prop NullableValue int32? { get; set; }
    prop this[index int32] int32 {
        get -> index
        set { }
    }

    shared {
        var HiddenStaticField int32
        prop HiddenStaticProp bool { get; set; }
    }
}

` + "$annotation" + `
class Tagged {
}`))
        let diagnostic = Assert.Single(result.Diagnostics, (item Diagnostic) -> item.Id == expectedId)
        Assert.Equal(32, diagnostic.Location.StartLine)
        Assert.False(result.Success)
    }

    @Fact
    func Issue4683_QualifiedAndUnqualifiedGenericConstructorReceiver_ResolvesExtensionMethod() {
        let result = Emit(`package Gsharp.Concurrency
import System.Diagnostics.CodeAnalysis

struct ReceiveResult[T] {
    @AllowNull
    private let value T
    prop Ok bool { get; }
    internal prop Element T -> value

    init(@AllowNull value T, ok bool) {
        this.value = value
        Ok = ok
    }
}

shared class ChannelOps {
    func Unqualified[T](value T, ok bool)(Value T, Ok bool) -> ReceiveResult[T](value, ok).ToTuple()

    func Qualified[T](value T, ok bool)(Value T, Ok bool) -> Gsharp.Concurrency.ReceiveResult[T](value, ok).ToTuple()
}

@ExtensionOwner(typeof(ChannelOps))
private func (result ReceiveResult[T]) ToTuple[T]()(Value T, Ok bool) -> (result.Element, result.Ok)`)
        Assert.True(result.Success, FormatDiagnostics(result))
    }

    @Fact
    func ConstructorParameterAliases_ReportDuplicateNamedDiagnostic() {
        using let contracts = Issue4503ImportedAttributeContracts()
        let result = Emit(`import Issue4503.Contracts

@ImportedReservedNamed($params: "a", params__: "b")
class Tagged {
}`, contracts.Path)
        let diagnostic = Assert.Single(result.Diagnostics, (item Diagnostic) -> item.Id == "GS0245")
        Assert.Equal(2, diagnostic.Location.StartLine)
        Assert.False(result.Success)
    }

    private data class EmitResult(Success bool, Diagnostics ImmutableArray[Diagnostic], Image[]uint8) : IEquatable[
        Issue4503NamedAttributeConstructorArgumentTests.EmitResult
    ] { }

    shared {
        private func Emit(source string, referencePath string? = nil) Issue4503NamedAttributeConstructorArgumentTests
            .EmitResult {
            using let resolver = ReferenceResolver.WithReferences(
                if referencePath == nil {
                    Array.Empty[string]()
                } else {
                    []string{referencePath}
                }
            )
            let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(source)))
            using let stream = MemoryStream()
            let result = compilation.Emit(stream)
            return Issue4503NamedAttributeConstructorArgumentTests.EmitResult(
                result.Success,
                result.Diagnostics,
                stream.ToArray()
            )
        }

        private func FormatDiagnostics(
            result Issue4503NamedAttributeConstructorArgumentTests.EmitResult
        ) string -> string.Join(
            Environment.NewLine,
            result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
        )
    }
}
