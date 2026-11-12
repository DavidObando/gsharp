package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5968SourceAttributeDependencyDriverTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func SourceContracts_BindBeforeDelegateApplications(sugar bool, crossFile bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let declaration = "import System\n@AttributeUsage(AttributeTargets.ReturnValue)\n" +
            "class ReturnOnlyAttribute(Code int32) : Attribute {}\n" +
            "@AttributeUsage(AttributeTargets.All, AllowMultiple: true)\n" +
            if sugar {
            "@Attribute\nclass TagAttribute(Code int32) {}"
        } else {
            "class TagAttribute(Code int32) : Attribute {}"
        }
        fixture.Compile(declaration + "\n@Tag(17) @Tag(19)\nfunc Value() int32 -> 7", "method-control5968", false)
        let consumer = `import System
@Tag(Code: 7)
@Tag(Code: 9)
@return:ReturnOnly(13)
delegate Reader(@Tag(11) value int32) int32;
@Tag(17)
@Tag(19)
func Value() int32 -> 7
func Main() {
    let read Reader = func(value int32) int32 { return value + Value() }
    Console.Write(read(6))
}`
        let dependency = Path.Combine(fixture.Directory, "contract.gs")
        File.WriteAllText(dependency, declaration)
        let source = if crossFile {
            consumer
        } else {
            declaration + "\n" + consumer.Replace("import System\n", "")
        }
        let extra = if crossFile {
            []string{dependency, "/deterministic+", "/debug:none"}
        } else {
            []string{"/deterministic+", "/debug:none"}
        }
        let dll = fixture.Compile(source, "source5968", true, extra)
        let bytes = File.ReadAllBytes(dll)
        fixture.Compile(source, "source5968", true, extra)
        Assert.Equal(bytes, File.ReadAllBytes(dll))
        IlVerifier.Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let tag = assembly.GetTypes().Single((t Type) -> t.Name == "TagAttribute")
        Assert.Equal(typeof(Attribute), tag.BaseType)
        let usage = Assert.Single(
            tag.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType == typeof(AttributeUsageAttribute)
        )
        Assert.Equal(int32(AttributeTargets.All), usage.ConstructorArguments[0].Value)
        let allowMultiple = Assert.Single(usage.NamedArguments)
        Assert.Equal("AllowMultiple", allowMultiple.MemberName)
        Assert.Equal(true, allowMultiple.TypedValue.Value)
        let reader = assembly.GetTypes().Single((t Type) -> t.Name == "Reader")
        AssertCodes(reader.GetCustomAttributesData().ToArray(), []int32{7, 9})
        Assert.DoesNotContain(
            reader.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.Name == "ReturnOnlyAttribute"
        )
        let invoke = reader.GetMethod("Invoke")!!
        let returnAttribute = Assert.Single(invoke.ReturnParameter.GetCustomAttributesData())
        Assert.Equal("ReturnOnlyAttribute", returnAttribute.AttributeType.Name)
        Assert.Equal(13, returnAttribute.ConstructorArguments[0].Value)
        AssertCodes(Assert.Single(invoke.GetParameters()).GetCustomAttributesData().ToArray(), []int32{11})
        Assert.Empty(invoke.GetCustomAttributesData())
        let value = assembly
            .GetTypes()
            .SelectMany((t Type) -> t.GetMethods())
            .Single((m MethodInfo) -> m.Name == "Value")
        AssertCodes(value.GetCustomAttributesData().ToArray(), []int32{17, 19})
        using let stream = File.OpenRead(dll)
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        let invokeDefinition = metadata
            .MethodDefinitions
            .Select((h MethodDefinitionHandle) -> metadata.GetMethodDefinition(h))
            .Single((m MethodDefinition) -> metadata.GetString(m.Name) == "Invoke")
        let rows = invokeDefinition.GetParameters().Select((h ParameterHandle) -> metadata.GetParameter(h)).ToArray()
        Assert.Equal([]int32{0, 1}, rows.Select((p Parameter) -> p.SequenceNumber).ToArray())
        Assert.Single(rows[0].GetCustomAttributes())
        Assert.Equal(Encoding.UTF8.GetBytes("13"), fixture.RunBytes(dll))
    }

    @Fact
    func OrdinaryTypeApplications_UseTheSameSourceDependencyAndKeepDiagnostics() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `import System
@Tag
@Tag
class First {}
@AttributeUsage(AttributeTargets.Class, AllowMultiple: true)
class TagAttribute : Attribute {}`
        let dll = fixture.Compile(source, "type5968", false)
        let first = EmittedFixture.Load(dll).GetTypes().Single((t Type) -> t.Name == "First")
        Assert.Equal(
            2,
            first.GetCustomAttributesData().Count((a CustomAttributeData) -> a.AttributeType.Name == "TagAttribute")
        )
        let (duplicateCode, duplicateOutput) = fixture.TryCompile(
            source.Replace("AllowMultiple: true", "AllowMultiple: false"),
            "duplicate5968",
            false
        )
        Assert.NotEqual(0, duplicateCode)
        Assert.Equal([]string{"GS0210@3,2,3,5"}, DiagnosticLocations(duplicateOutput))
        let (delegateDuplicateCode, delegateDuplicateOutput) = fixture.TryCompile(
            source.Replace("class First {}", "delegate First() int32;").Replace(
                "AttributeTargets.Class, AllowMultiple: true",
                "AttributeTargets.Delegate"
            ),
            "delegate-duplicate5968",
            false
        )
        Assert.NotEqual(0, delegateDuplicateCode)
        Assert.Equal([]string{"GS0210@3,2,3,5"}, DiagnosticLocations(delegateDuplicateOutput))
        let (usageCode, usageOutput) = fixture.TryCompile(
            source.Replace("class First {}", "delegate First() int32;"),
            "usage5968",
            false
        )
        Assert.NotEqual(0, usageCode)
        Assert.Equal([]string{"GS0209@2,2,2,5", "GS0209@3,2,3,5"}, DiagnosticLocations(usageOutput))
        let (constructorCode, constructorOutput) = fixture.TryCompile(
            "import System\n@Tag(1)\ndelegate Reader() int32;\nclass TagAttribute(Text string) : Attribute {}",
            "constructor5968",
            false
        )
        Assert.NotEqual(0, constructorCode)
        Assert.Equal([]string{"GS0583@2,1,2,8"}, DiagnosticLocations(constructorOutput))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SourceAttributeDependencies_CanReferToEachOtherWithoutReadingProvisionalUsage(sugar bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        var source = `import System
@A @A
delegate Reader() int32;
@B @B
@AttributeUsage(AttributeTargets.All, AllowMultiple: true)
class AAttribute : Attribute {}
@A @A
@AttributeUsage(AttributeTargets.All, AllowMultiple: true)
class BAttribute : Attribute {}`
        if sugar {
            source = source.Replace("class AAttribute : Attribute", "@Attribute class AAttribute").Replace(
                "class BAttribute : Attribute",
                "@Attribute class BAttribute"
            )
        }
        let dll = fixture.Compile(source, "cycle5968", false)
        let types = EmittedFixture.Load(dll).GetTypes()
        for name in[]string{"Reader", "AAttribute", "BAttribute"} {
            let type = types.Single((t Type) -> t.Name == name)
            Assert.Equal(
                2,
                type.GetCustomAttributesData().Count(
                    (a CustomAttributeData) -> a.AttributeType.Name == if name == "AAttribute" {
                        "BAttribute"
                    } else {
                        "AAttribute"
                    }
                )
            )
        }
        let (duplicateCode, duplicateOutput) = fixture.TryCompile(
            source.Replace("AllowMultiple: true", "AllowMultiple: false"),
            "cycle-duplicate5968",
            false
        )
        Assert.NotEqual(0, duplicateCode)
        Assert.Equal(
            []string{"GS0210@2,5,2,6", "GS0210@4,5,4,6", "GS0210@7,5,7,6"},
            DiagnosticLocations(duplicateOutput)
        )
        for allowMultiple in[]bool{true, false} {
            var rejected = source.Replace("AttributeTargets.All", "AttributeTargets.Delegate")
            var expected = []string{"GS0209@4,2,4,3", "GS0209@4,5,4,6", "GS0209@7,2,7,3", "GS0209@7,5,7,6"}
            if !allowMultiple {
                rejected = rejected.Replace("AllowMultiple: true", "AllowMultiple: false")
                expected = []string{"GS0210@2,5,2,6"}.Concat(expected).ToArray()
            }
            let (usageCode, usageOutput) = fixture.TryCompile(rejected, "cycle-usage5968", false)
            Assert.NotEqual(0, usageCode)
            Assert.Equal(expected, DiagnosticLocations(usageOutput))
            Assert.False(File.Exists(Path.Combine(fixture.Directory, "cycle-usage5968.dll")))
        }
    }

    shared {
        private func AssertCodes(attributes[]CustomAttributeData, expected[]int32) {
            let tags = attributes.Where((a CustomAttributeData) -> a.AttributeType.Name == "TagAttribute").ToArray()
            Assert.Equal(
                expected,
                tags.Select((a CustomAttributeData) -> cast[int32](a.ConstructorArguments[0].Value)).ToArray()
            )
        }

        private func DiagnosticLocations(output string)[]string {
            let matches = Regex.Matches(output, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
            Assert.NotEmpty(matches)
            return matches.Select((m Match) -> m.Groups[2].Value + "@" + m.Groups[1].Value).ToArray()
        }
    }
}
