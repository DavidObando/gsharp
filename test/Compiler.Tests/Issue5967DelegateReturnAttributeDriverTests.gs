package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.ComponentModel
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5967DelegateReturnAttributeDriverTests {
    @Fact
    func MaybeNull_UsesInvokeReturnParameterLikeAnOrdinaryMethod() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let control = fixture.Compile(`import System.Diagnostics.CodeAnalysis
shared class P {
    @return:MaybeNull
    func Value() string? -> nil
}`, "method5967", false)
        let method = EmittedFixture.Load(control).GetTypes().Single((t Type) -> t.Name == "P").GetMethod("Value")!!
        Assert.Single(
            method.ReturnParameter.GetCustomAttributesData(),
            (a CustomAttributeData) ->
            a.AttributeType.FullName == "System.Diagnostics.CodeAnalysis.MaybeNullAttribute"
        )

        let dll = fixture.Compile(`import System.Diagnostics.CodeAnalysis

@return:MaybeNull
delegate Reader() string?;`, "minimal5967", false)
        IlVerifier.Verify(dll)
        let reader = EmittedFixture.Load(dll).GetTypes().Single((t Type) -> t.Name == "Reader")
        let invoke = reader.GetMethod("Invoke")!!
        Assert.Equal(typeof(string), invoke.ReturnType)
        Assert.Equal(-1, invoke.ReturnParameter.Position)
        Assert.Single(
            invoke.ReturnParameter.GetCustomAttributesData(),
            (a CustomAttributeData) ->
            a.AttributeType.FullName == "System.Diagnostics.CodeAnalysis.MaybeNullAttribute"
        )
        Assert.DoesNotContain(
            reader.GetCustomAttributesData(),
            (a CustomAttributeData) ->
            a.AttributeType.FullName == "System.Diagnostics.CodeAnalysis.MaybeNullAttribute"
        )
        Assert.DoesNotContain(
            invoke.GetCustomAttributesData(),
            (a CustomAttributeData) ->
            a.AttributeType.FullName == "System.Diagnostics.CodeAnalysis.MaybeNullAttribute"
        )
        Assert.Empty(invoke.GetParameters())
        AssertInvokeRows(dll, reader.Name, []int32{0})
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ReturnOnlyAttributes_PreserveTypeParameterAndRuntimeOwnership(generic bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let attributes = fixture.CompileCSharp(`using System;
namespace Attributes5967 {
    [AttributeUsage(AttributeTargets.ReturnValue, AllowMultiple = true)]
    public sealed class ReturnMarkAttribute(int code) : Attribute {
        public int Code { get; } = code;
    }
}`, "attributes5967")
        var signature = if generic {
            "[T any](value T) T"
        } else {
            "(value int32) int32"
        }
        signature = signature.Replace("(value", `(@Description("input") value`)
        let use = if generic {
            "Reader[int32]"
        } else {
            "Reader"
        }
        let source = `import System
import System.ComponentModel
import Attributes5967
@Description("reader")
@return:ReturnMark(7)
@return:ReturnMark(9)
delegate Reader` + signature + `;
func Main() {
    let read ` + use + ` = func(value int32) int32 { return value + 1 }
    Console.Write(read(6))
}`
        let name = if generic {
            "generic5967"
        } else {
            "value5967"
        }
        let dll = fixture.Compile(source, name, true, "/reference:" + attributes, "/deterministic+", "/debug:none")
        let bytes = File.ReadAllBytes(dll)
        fixture.Compile(source, name, true, "/reference:" + attributes, "/deterministic+", "/debug:none")
        Assert.Equal(bytes, File.ReadAllBytes(dll))
        IlVerifier.Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        var reader = assembly.GetTypes().Single(
            (t Type) -> t.Name == if generic {
                "Reader`1"
            } else {
                "Reader"
            }
        )
        if generic {
            Assert.Single(reader.GetGenericArguments())
            let definitionInvoke = reader.GetMethod("Invoke")!!
            Assert.Equal(0, definitionInvoke.ReturnType.GenericParameterPosition)
            Assert.Equal(definitionInvoke.ReturnType, definitionInvoke.GetParameters()[0].ParameterType)
            reader = reader.MakeGenericType(typeof(int32))
        }
        let invoke = reader.GetMethod("Invoke")!!
        Assert.Equal(typeof(int32), invoke.ReturnType)
        let returns = invoke
            .ReturnParameter
            .GetCustomAttributesData()
            .Where((a CustomAttributeData) -> a.AttributeType.Name == "ReturnMarkAttribute")
            .ToArray()
        Assert.Equal(
            []int32{7, 9},
            returns.Select((a CustomAttributeData) -> cast[int32](a.ConstructorArguments[0].Value)).ToArray()
        )
        let typeAttribute = Assert.Single(
            reader.GetCustomAttributesData(),
            (a CustomAttributeData) ->
            a.AttributeType == typeof(DescriptionAttribute)
        )
        Assert.Equal("reader", typeAttribute.ConstructorArguments[0].Value)
        let parameter = Assert.Single(invoke.GetParameters())
        Assert.Equal("value", parameter.Name)
        Assert.Equal(typeof(int32), parameter.ParameterType)
        let parameterAttribute = Assert.Single(
            parameter.GetCustomAttributesData(),
            (a CustomAttributeData) ->
            a.AttributeType == typeof(DescriptionAttribute)
        )
        Assert.Equal("input", parameterAttribute.ConstructorArguments[0].Value)
        Assert.DoesNotContain(
            reader.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.Name == "ReturnMarkAttribute"
        )
        Assert.DoesNotContain(
            invoke.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.Name == "ReturnMarkAttribute"
        )
        let ctor = Assert.Single(reader.GetConstructors())
        Assert.Empty(ctor.GetCustomAttributesData())
        Assert.Equal(2, ctor.GetParameters().Length)
        Assert.All(ctor.GetParameters(), (p ParameterInfo) -> Assert.Empty(p.GetCustomAttributesData()))
        AssertInvokeRows(dll, reader.Name, []int32{0, 1})
        Assert.Equal(Encoding.UTF8.GetBytes("7"), fixture.RunBytes(dll))
    }

    @Fact
    func ReturnTarget_StillValidatesDeclarationTargetsUsageAndConstructors() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = "import System.ComponentModel\n@return:Description(\"ok\")\ndelegate Reader() int32;"
        fixture.Compile(source, "valid5967", false)
        for target in[]string{"method", "field", "param"} {
            let rejected = source.Replace("return:", target + ":")
            let (code, output) = fixture.TryCompile(rejected, "target-" + target, false)
            Assert.NotEqual(0, code)
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "target-" + target + ".dll")))
            Assert.Equal([]string{"GS0201@2,2,2," + (target.Length + 2).ToString()}, DiagnosticLocations(output))
        }
        let (usageCode, usageOutput) = fixture.TryCompile(
            "import System\n@return:Obsolete\ndelegate Reader() int32;",
            "usage5967",
            false
        )
        Assert.NotEqual(0, usageCode)
        Assert.Equal([]string{"GS0209@2,9,2,17"}, DiagnosticLocations(usageOutput))
        let (constructorCode, constructorOutput) = fixture.TryCompile(
            source.Replace(`Description("ok")`, "Description(1)"),
            "constructor5967",
            false
        )
        Assert.NotEqual(0, constructorCode)
        Assert.Equal([]string{"GS0583@2,1,2,23"}, DiagnosticLocations(constructorOutput))
    }

    shared {
        private func AssertInvokeRows(dll string, typeName string, expected[]int32) {
            using let stream = File.OpenRead(dll)
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            let type = metadata
                .TypeDefinitions
                .Select((h TypeDefinitionHandle) -> metadata.GetTypeDefinition(h))
                .Single((t TypeDefinition) -> metadata.GetString(t.Name) == typeName)
            let invoke = type
                .GetMethods()
                .Select((h MethodDefinitionHandle) -> metadata.GetMethodDefinition(h))
                .Single((m MethodDefinition) -> metadata.GetString(m.Name) == "Invoke")
            let rows = invoke.GetParameters().Select((h ParameterHandle) -> metadata.GetParameter(h)).ToArray()
            Assert.Equal(expected, rows.Select((p Parameter) -> p.SequenceNumber).ToArray())
            Assert.NotEmpty(rows[0].GetCustomAttributes())
        }

        private func DiagnosticLocations(output string)[]string {
            let matches = Regex.Matches(output, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
            Assert.NotEmpty(matches)
            return matches.Select((m Match) -> m.Groups[2].Value + "@" + m.Groups[1].Value).ToArray()
        }
    }
}
