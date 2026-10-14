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

    @Theory
    @InlineData("@ImportedNamedConstructor(\"a\", first: \"b\")", "GS0247")
    @InlineData("@ImportedNamedConstructor(\"a\", second: 2, second: 3)", "GS0245")
    @InlineData("@ImportedNamedConstructor(\"a\", Missing: 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(\"a\", Missing = 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(Missing = 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(\"a\", Label = 1)", "GS0614")
    @InlineData("@ImportedNamedConstructor(\"a\", Item = 1)", "GS0613")
    @InlineData("@ImportedNamedConstructor(\"a\", Unsupported = nil)", "GS0615")
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
