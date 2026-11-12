package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Collections.Generic
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

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func BaseAttributeApplications_SeePublishedOverrideMembers(property bool, memberApplication bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let baseMember = if property {
            "open prop Value int32 -> 1"
        } else {
            "open func Value() int32 -> 1"
        }
        let derivedMember = if property {
            "override prop Value int32 -> 2"
        } else {
            "override func Value() int32 -> 2"
        }
        let access = if property {
            "value.Value"
        } else {
            "value.Value()"
        }
        const annotation = "@Derived(code: 7)\n"
        let source = "import System\n" +
            (
            if memberApplication {
                ""
            } else {
                annotation
            }
        ) +
            "open class BaseAttribute : Attribute {\n" +
            (
            if memberApplication {
                annotation
            } else {
                ""
            }
        ) +
            baseMember +
            "\n}\nclass DerivedAttribute : BaseAttribute {\ninit(code int32) {}\n" +
            derivedMember +
            "\n}\nfunc Main() {\nlet value BaseAttribute = DerivedAttribute(7)\nConsole.Write(" +
            access +
            ")\n}"
        fixture.Compile(source.Replace(annotation, ""), "override-control5968", true)
        let dll = fixture.Compile(source, "override5968", true)
        IlVerifier.Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let baseType = assembly.GetTypes().Single((t Type) -> t.Name == "BaseAttribute")
        let owner MemberInfo = if memberApplication {
            if property {
                cast[MemberInfo](baseType.GetProperty("Value")!!)
            } else {
                cast[MemberInfo](baseType.GetMethod("Value")!!)
            }
        } else {
            baseType
        }
        let application = Assert.Single(
            owner.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.Name == "DerivedAttribute"
        )
        Assert.Equal("DerivedAttribute", application.AttributeType.Name)
        Assert.Equal(7, Assert.Single(application.ConstructorArguments).Value)
        let derivedType = assembly.GetTypes().Single((t Type) -> t.Name == "DerivedAttribute")
        let method = derivedType.GetMethod(
            if property {
                "get_Value"
            } else {
                "Value"
            }
        )!!
        Assert.Equal(baseType, method.GetBaseDefinition().DeclaringType)
        Assert.Equal(Encoding.UTF8.GetBytes("2"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ConstructedAttributes_ReadDefinitionContractsWithoutLosingTypeArguments(sugar bool, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let name = if nested {
            "Container.Tag"
        } else {
            "Tag"
        }
        let attribute = "@AttributeUsage(AttributeTargets.All, AllowMultiple: true)\n" +
            (
            if sugar {
                "@Attribute\n"
            } else {
                ""
            }
        ) +
            "public class TagAttribute[T](Code int32)" +
            (
            if sugar {
                ""
            } else {
                " : Attribute"
            }
        ) +
            " {}"
        let source = "import System\n@" +
            name +
            "[int32](7)\n@" +
            name +
            "[int32](9)\ndelegate Reader() int32;\n" +
            (
            if nested {
                "class Container {\n" + attribute + "\n}"
            } else {
                attribute
            }
        )
        let dll = fixture.Compile(source, "constructed5968", false)
        IlVerifier.Verify(dll)
        let reader = EmittedFixture.Load(dll).GetTypes().Single((t Type) -> t.Name == "Reader")
        let applications = reader
            .GetCustomAttributesData()
            .Where((a CustomAttributeData) -> a.AttributeType.Name == "TagAttribute`1")
            .ToArray()
        Assert.Equal(
            []int32{7, 9},
            applications.Select((a CustomAttributeData) -> cast[int32](Assert.Single(a.ConstructorArguments).Value))
                .ToArray()
        )
        for application in applications {
            Assert.False(application.AttributeType.ContainsGenericParameters)
            Assert.Equal(typeof(int32), Assert.Single(application.AttributeType.GetGenericArguments()))
            Assert.Equal(typeof(Attribute), application.AttributeType.BaseType)
            let usage = Assert.Single(
                application.AttributeType.GetGenericTypeDefinition().GetCustomAttributesData(),
                (a CustomAttributeData) -> a.AttributeType == typeof(AttributeUsageAttribute)
            )
            Assert.Equal(true, Assert.Single(usage.NamedArguments).TypedValue.Value)
        }
        let (code, output) = fixture.TryCompile(
            source.Replace("AllowMultiple: true", "AllowMultiple: false"),
            "constructed-duplicate5968",
            false
        )
        Assert.NotEqual(0, code)
        Assert.Equal([]string{"GS0210@3,2,3," + (name.Length + 2).ToString()}, DiagnosticLocations(output))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    func DeepAttributeDependencies_CompileAndRetainContractsOnSmallStacks(inheritance bool, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        let sourceFile = Path.Combine(fixture.Directory, "dependency.gs")
        let outputFile = Path.Combine(fixture.Directory, "dependency.dll")
        let wrapSource = (source string) -> if nested {
            source.Replace("import System\n", "import System\nclass Envelope {\n") + "\n}"
        } else {
            source
        }
        File.WriteAllText(
            sourceFile,
            wrapSource(
                if inheritance {
                    AttributeInheritanceChain(8)
                } else {
                    AttributeChain(8)
                }
            )
        )
        let (controlCode, controlOutput) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
            sourceFile,
            outputFile,
            driver
        )
        Assert.True(controlCode == 0, controlOutput)
        File.Delete(outputFile)
        let source = wrapSource(
            if inheritance {
                AttributeInheritanceChain(8192)
            } else {
                AttributeChain(8192)
            }
        )
        File.WriteAllText(sourceFile, source)
        let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
            sourceFile,
            outputFile,
            driver
        )
        Assert.True(code == 0, "Exit " + code.ToString() + ": " + output.Substring(0, Math.Min(output.Length, 2000)))
        Assert.DoesNotContain("Stack overflow", output, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("GS9998", output)
        IlVerifier.Verify(outputFile)
        using let stream = File.OpenRead(outputFile)
        using let pe = PEReader(stream)
        let metadata = pe.GetMetadataReader()
        let definitions = metadata
            .TypeDefinitions
            .Select((handle TypeDefinitionHandle) -> metadata.GetTypeDefinition(handle))
            .Where((type TypeDefinition) -> metadata.GetString(type.Name).StartsWith("A", StringComparison.Ordinal))
            .OrderBy((type TypeDefinition) -> int32.Parse(metadata.GetString(type.Name).Substring(1)))
            .ToArray()
        Assert.Equal(8192, definitions.Length)
        for var index = 0; index < definitions.Length; index++ {
            let definition = definitions[index]
            Assert.Equal("A" + index.ToString(), metadata.GetString(definition.Name))
            if nested {
                Assert.Equal(
                    "Envelope",
                    metadata.GetString(metadata.GetTypeDefinition(definition.GetDeclaringType()).Name)
                )
            }
            if inheritance && index + 1 < definitions.Length {
                Assert.Equal(
                    "A" + (index + 1).ToString(),
                    metadata.GetString(metadata.GetTypeDefinition(cast[TypeDefinitionHandle](definition.BaseType)).Name)
                )
            } else {
                Assert.Equal(
                    "Attribute",
                    metadata.GetString(metadata.GetTypeReference(cast[TypeReferenceHandle](definition.BaseType)).Name)
                )
            }
            if !inheritance && index + 1 < definitions.Length {
                let application = Assert.Single(
                    definition.GetCustomAttributes().Select(
                        (handle CustomAttributeHandle) -> metadata.GetCustomAttribute(handle)
                    ),
                    (attribute CustomAttribute) -> attribute.Constructor.Kind == HandleKind.MethodDefinition
                )
                let constructor = metadata.GetMethodDefinition(cast[MethodDefinitionHandle](application.Constructor))
                Assert.Equal(
                    "A" + (index + 1).ToString(),
                    metadata.GetString(metadata.GetTypeDefinition(constructor.GetDeclaringType()).Name)
                )
                Assert.Equal([]uint8{1, 0, 0, 0}, metadata.GetBlobBytes(application.Value))
            }
        }
        if !inheritance {
            let first = EmittedFixture.Load(outputFile).GetTypes().Single((type Type) -> type.Name == "A0")
            Assert.Equal(
                "A1",
                Assert
                    .Single(
                    first.GetCustomAttributes(false),
                    (attribute object) -> attribute.GetType().Name.StartsWith("A", StringComparison.Ordinal)
                )
                    .GetType()
                    .Name
            )
        }
    }

    @Fact
    func DeepAttributeDependencies_PreserveContractsAcrossFileAndDeclarationOrders() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        const count = 1024
        let left = List[string]()
        let right = List[string]()
        for var index = 0; index < count; index++ {
            let even = index % 2 == 0
            let annotation = if index + 1 == count {
                ""
            } else {
                "@" +
                    (
                    if even {
                        "Right"
                    } else {
                        "Left"
                    }
                ) +
                    ".A" +
                    (index + 1).ToString() + "(Code: " + index.ToString() + ")\n"
            }
            let declaration = annotation +
                "@AttributeUsage(AttributeTargets.All, AllowMultiple: true)\nclass A" +
                index.ToString() +
                "(Code int32) : " +
                (
                if even {
                    "System.Attribute"
                } else {
                    "Base"
                }
            ) +
                " {}"
            (
                if even {
                    left
                } else {
                    right
                }
            ).Add(declaration)
        }
        let leftPath = Path.Combine(fixture.Directory, "left.gs")
        let rightPath = Path.Combine(fixture.Directory, "right.gs")
        let response = Path.Combine(fixture.Directory, "order.rsp")
        var expected List[string]? = nil
        for reverseDeclarations in[]bool{false, true} {
            File.WriteAllText(
                leftPath,
                "package Left\nimport System\nimport Base = System.Exception\n" +
                    "@Right.A1(Code: 17)\nclass Probe[T] { shared { func Identity(value T) T -> value } }\n" +
                    string.Join(
                    "\n",
                    if reverseDeclarations {
                        left.AsEnumerable().Reverse()
                    } else {
                        left
                    }
                )
            )
            File.WriteAllText(
                rightPath,
                "package Right\nimport System\nimport Base = System.Attribute\n" + string.Join(
                    "\n",
                    if reverseDeclarations {
                        right.AsEnumerable().Reverse()
                    } else {
                        right
                    }
                )
            )
            for reverseFiles in[]bool{false, true} {
                let paths = if reverseFiles {
                    []string{rightPath, leftPath}
                } else {
                    []string{leftPath, rightPath}
                }
                File.WriteAllText(
                    response,
                    "/deterministic+\n/debug:none\n" + string.Join(
                        "\n",
                        paths.Select((path string) -> "\"" + path + "\"")
                    )
                )
                let dll = Path.Combine(
                    fixture.Directory,
                    "ordered-" + reverseDeclarations.ToString() + reverseFiles.ToString() + ".dll"
                )
                let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
                    "@" + response,
                    dll,
                    driver
                )
                Assert.True(code == 0, output)
                let bytes = File.ReadAllBytes(dll)
                let (repeatCode, repeatOutput) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
                    "@" + response,
                    dll,
                    driver
                )
                Assert.True(repeatCode == 0, repeatOutput)
                Assert.Equal(bytes, File.ReadAllBytes(dll))
                IlVerifier.Verify(dll)
                let types = EmittedFixture.Load(dll).GetTypes()
                let attributes = types
                    .Where((type Type) -> type.Name.StartsWith("A", StringComparison.Ordinal))
                    .OrderBy((type Type) -> type.Name, StringComparer.Ordinal)
                    .ToArray()
                Assert.Equal(count, attributes.Length)
                let contracts = List[string]()
                for type in attributes {
                    Assert.Equal(typeof(Attribute), type.BaseType)
                    let usage = Assert.Single(
                        type.GetCustomAttributesData(),
                        (data CustomAttributeData) -> data.AttributeType == typeof(AttributeUsageAttribute)
                    )
                    Assert.Equal(int32(AttributeTargets.All), usage.ConstructorArguments[0].Value)
                    Assert.Equal(true, Assert.Single(usage.NamedArguments).TypedValue.Value)
                    let index = int32.Parse(type.Name.Substring(1))
                    let applications = type
                        .GetCustomAttributesData()
                        .Where((data CustomAttributeData) -> data.AttributeType.Assembly == type.Assembly)
                        .ToArray()
                    if index + 1 == count {
                        Assert.Empty(applications)
                        continue
                    }
                    let application = Assert.Single(applications)
                    Assert.Equal("A" + (index + 1).ToString(), application.AttributeType.Name)
                    Assert.Equal(index, Assert.Single(application.ConstructorArguments).Value)
                    contracts.Add(type.FullName + ":" + application.AttributeType.FullName + ":" + index.ToString())
                }
                let actual = contracts.ToArray()
                if expected is {} previous {
                    Assert.Equal(previous.ToArray(), actual)
                } else {
                    expected = contracts
                }
                let probe = types.Single((type Type) -> type.Name == "Probe`1").MakeGenericType(typeof(int32))
                Assert.Equal(42, probe.GetMethod("Identity")!!.Invoke(nil, []object{42}))
                Assert.Equal(
                    17,
                    probe
                        .GetCustomAttributesData()
                        .Single((data CustomAttributeData) -> data.AttributeType.Name == "A1")
                        .ConstructorArguments[0]
                        .Value
                )
            }
        }
    }

    @Theory
    @InlineData("constraint")
    @InlineData("base")
    @InlineData("argument")
    @InlineData("interface")
    func QualifiedDeclarationSignatures_UseReadyLexicalHeaders(kind string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        const root = "open class Root { public open class Nested {} }"
        let container = if kind == "constraint" {
            "public open class Container[T] : Root {}"
        } else {
            "public open class Container : Root {}"
        }
        let consumer = switch kind {
            case "constraint": "public class Consumer[U Container[int32].Nested] {}"
            case "base": "public class Consumer : Container.Nested {}"
            case "argument": "public open class GenericBase[T] {}\npublic class Consumer : GenericBase[Container.Nested] {}"
            default: "public interface Contract { func Read(value Container.Nested); }\n" +
                "public class Implementation : Contract { public func Read(value Root.Nested) {} }"
        }
        for reverse in[]bool{false, true} {
            let siblings = if reverse {
                consumer + "\n" + container
            } else {
                container + "\n" + consumer
            }
            let declarations = []string{
                root,
                if kind == "constraint" {
                    "open class Container[T] {}"
                } else {
                    ""
                },
                "class Envelope {\n" + siblings + "\n}"
            }
            let sourcePath = Path.Combine(fixture.Directory, "qualifiers.gs")
            let dll = Path.Combine(fixture.Directory, "qualifiers-" + reverse.ToString() + ".dll")
            File.WriteAllText(
                sourcePath,
                string.Join(
                    "\n",
                    if reverse {
                        declarations.Reverse()
                    } else {
                        declarations
                    }
                )
            )
            let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
                sourcePath,
                dll,
                driver
            )
            Assert.True(code == 0, output)
            IlVerifier.Verify(dll)
            let types = EmittedFixture.Load(dll).GetTypes()
            let nested = types.Single((type Type) -> type.Name == "Nested")
            if kind == "interface" {
                let contract = types.Single((type Type) -> type.Name == "Contract")
                let read = contract.GetMethod("Read")!!
                Assert.Equal(nested, Assert.Single(read.GetParameters()).ParameterType)
                let implementation = types.Single((type Type) -> type.Name == "Implementation")
                read.Invoke(Activator.CreateInstance(implementation), []object{Activator.CreateInstance(nested)!!})
            } else {
                let result = types.Single(
                    (type Type) -> type.Name == if kind == "constraint" {
                        "Consumer`1"
                    } else {
                        "Consumer"
                    }
                )
                if kind == "constraint" {
                    Assert.Equal(
                        nested,
                        Assert.Single(Assert.Single(result.GetGenericArguments()).GetGenericParameterConstraints())
                    )
                    Assert.NotNull(Activator.CreateInstance(result.MakeGenericType(nested)))
                } else {
                    Assert.Equal(
                        nested,
                        if kind == "argument" {
                            Assert.Single(result.BaseType!!.GetGenericArguments())
                        } else {
                            result.BaseType
                        }
                    )
                    Assert.NotNull(Activator.CreateInstance(result))
                }
            }
        }
    }

    @Fact
    func HeaderConstraints_SeeInheritedNestedTypesInEitherDeclarationOrder() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        let declarations = []string{
            "class Derived[T Base.Nested] : Base {}",
            "open class Base : Root {}",
            "open class Root { public class Nested {} }"
        }
        for reverse in[]bool{false, true} {
            let source = string.Join(
                "\n",
                if reverse {
                    declarations.Reverse()
                } else {
                    declarations
                }
            )
            let sourcePath = Path.Combine(fixture.Directory, "constraints.gs")
            let dll = Path.Combine(fixture.Directory, "constraints-" + reverse.ToString() + ".dll")
            File.WriteAllText(sourcePath, source)
            let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
                sourcePath,
                dll,
                driver
            )
            Assert.True(code == 0, output)
            IlVerifier.Verify(dll)
            let types = EmittedFixture.Load(dll).GetTypes()
            let nested = types.Single((type Type) -> type.Name == "Nested")
            let derived = types.Single((type Type) -> type.Name == "Derived`1")
            Assert.Equal(
                nested,
                Assert.Single(Assert.Single(derived.GetGenericArguments()).GetGenericParameterConstraints())
            )
            Assert.Equal("Base", derived.BaseType!!.Name)
            Assert.NotNull(Activator.CreateInstance(derived.MakeGenericType(nested)))
        }
    }

    @Fact
    func NestedBaseMembers_SeeEnclosingConstraintsBeforeTheEnclosingBody() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        let declarations = []string{
            "class Derived : Outer[int32].Base {}",
            "unsafe class Outer[T unmanaged] { public open class Base { public var Pointer *T } }"
        }
        for reverse in[]bool{false, true} {
            let source = string.Join(
                "\n",
                if reverse {
                    declarations.Reverse()
                } else {
                    declarations
                }
            )
            let sourcePath = Path.Combine(fixture.Directory, "enclosing.gs")
            let dll = Path.Combine(fixture.Directory, "enclosing-" + reverse.ToString() + ".dll")
            File.WriteAllText(sourcePath, source)
            let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
                sourcePath,
                dll,
                driver
            )
            Assert.True(code == 0, output)
            IlVerifier.Verify(dll)
            let derived = EmittedFixture.Load(dll).GetTypes().Single((type Type) -> type.Name == "Derived")
            Assert.Equal("Base", derived.BaseType!!.Name)
            Assert.Equal(typeof(int32), Assert.Single(derived.BaseType!!.GetGenericArguments()))
            Assert.Equal(typeof(int32).MakePointerType(), derived.GetField("Pointer")!!.FieldType)
            Assert.NotNull(Activator.CreateInstance(derived))
        }
    }

    @Fact
    func NestedPendingDeclarations_PreserveRequestedChildBodies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        const source = `import System
@BaseAttribute.Derived
open class BaseAttribute : Attribute {
    open func Value() int32 -> 1
    class DerivedAttribute : BaseAttribute {
        override func Value() int32 -> 2
        class Leaf {
            shared {
                func Answer() int32 -> 42
            }
        }
    }
}
func Main() { Console.Write(BaseAttribute.DerivedAttribute.Leaf.Answer()) }`
        fixture.Compile(source.Replace("@BaseAttribute.Derived\n", ""), "nested-control5968", true)
        let dll = fixture.Compile(source, "nested-pending5968", true)
        IlVerifier.Verify(dll)
        let leaf = EmittedFixture.Load(dll).GetTypes().Single((t Type) -> t.Name == "Leaf")
        Assert.Equal("DerivedAttribute", leaf.DeclaringType!!.Name)
        Assert.Equal("BaseAttribute", leaf.DeclaringType!!.DeclaringType!!.Name)
        Assert.Equal(42, leaf.GetMethod("Answer")!!.Invoke(nil, nil))
        Assert.Equal(Encoding.UTF8.GetBytes("42"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("self", false)
    @InlineData("self", true)
    @InlineData("mutual", false)
    @InlineData("mutual", true)
    @InlineData("derived", false)
    @InlineData("derived", true)
    func LegalAnnotationCycles_RetainContractsAndInstancesOnSmallStacks(kind string, nested bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        let self = kind == "self"
        let derived = kind == "derived"
        const usage = "@AttributeUsage(AttributeTargets.All, AllowMultiple: true)\n"
        let first = (
            if self {
                "@A(11)\n@A(12)\n"
            } else {
                "@B(21)\n@B(22)\n"
            }
        ) +
            usage +
            (
            if derived {
                "open "
            } else {
                ""
            }
        ) +
            "class AAttribute(Code int32) : Attribute {}"
        let second = "@A(11)\n@A(12)\n" +
            usage +
            (
            if derived {
                "class BAttribute(Input int32) : AAttribute(Input) {}"
            } else {
                "class BAttribute(Code int32) : Attribute {}"
            }
        )
        const target = "@A(31)\n@A(32)\nclass Target {}"
        for reverse in[]bool{false, true} {
            var declarations = if self {
                []string{first, target}
            } else {
                []string{first, second, target}
            }
            if reverse {
                declarations = declarations.Reverse().ToArray()
            }
            let body = string.Join("\n", declarations)
            let source = "import System\n" +
                (
                if nested {
                    "class Envelope {\n" + body + "\n}"
                } else {
                    body
                }
            )
            let name = "cycle-instances-" + reverse.ToString()
            let sourcePath = Path.Combine(fixture.Directory, name + ".gs")
            let dll = Path.Combine(fixture.Directory, name + ".dll")
            File.WriteAllText(sourcePath, source)
            let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
                sourcePath,
                dll,
                driver
            )
            Assert.True(code == 0, output.Substring(0, Math.Min(output.Length, 2000)))
            IlVerifier.Verify(dll)
            let types = EmittedFixture.Load(dll).GetTypes()
            let a = types.Single((t Type) -> t.Name == "AAttribute")
            let owner = types.Single((t Type) -> t.Name == "Target")
            AssertCycleApplications(
                a,
                if self {
                    "AAttribute"
                } else {
                    "BAttribute"
                },
                if self {
                    []int32{11, 12}
                } else {
                    []int32{21, 22}
                }
            )
            AssertCycleApplications(owner, "AAttribute", []int32{31, 32})
            if !self {
                AssertCycleApplications(types.Single((t Type) -> t.Name == "BAttribute"), "AAttribute", []int32{11, 12})
            }
            for attribute in types.Where((t Type) -> t.Name == "AAttribute" || t.Name == "BAttribute") {
                Assert.Equal(
                    if derived && attribute.Name == "BAttribute" {
                        a
                    } else {
                        typeof(Attribute)
                    },
                    attribute.BaseType
                )
                let contract = Assert.Single(
                    attribute.GetCustomAttributesData(),
                    (data CustomAttributeData) -> data.AttributeType == typeof(AttributeUsageAttribute)
                )
                Assert.Equal(int32(AttributeTargets.All), contract.ConstructorArguments[0].Value)
                let allowMultiple = Assert.Single(contract.NamedArguments)
                Assert.Equal("AllowMultiple", allowMultiple.MemberName)
                Assert.Equal(true, allowMultiple.TypedValue.Value)
                if nested {
                    Assert.Equal("Envelope", attribute.DeclaringType!!.Name)
                }
            }
        }
    }

    shared {
        private func AssertCycleApplications(owner Type, attributeName string, expected[]int32) {
            let metadata = owner
                .GetCustomAttributesData()
                .Where((data CustomAttributeData) -> data.AttributeType.Name == attributeName)
                .ToArray()
            Assert.Equal(
                expected,
                metadata.Select(
                    (data CustomAttributeData) -> cast[int32](Assert.Single(data.ConstructorArguments).Value)
                )
                    .ToArray()
            )
            let instances = owner
                .GetCustomAttributes(false)
                .Where((attribute object) -> attribute.GetType().Name == attributeName)
                .ToArray()
            Assert.Equal(
                expected,
                instances
                    .Select(
                    (attribute object) -> cast[int32](
                        attribute.GetType().GetField(
                            "Code",
                            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                        )!!.GetValue(attribute)
                    )
                )
                    .OrderBy((value int32) -> value)
                    .ToArray()
            )
        }

        private func CompileBoundedStackDriver(fixture NativeSliceLanguageTests.Fixture) string {
            return fixture.CompileCSharpExecutable(`using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
public static class Driver {
    public static int Main(string[] args) {
        var directory = Path.GetDirectoryName(args[0])!;
        AssemblyLoadContext.Default.Resolving += (context, name) => {
            var path = Path.Combine(directory, name.Name + ".dll");
            return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
        };
        var entry = Assembly.LoadFrom(args[0]).GetType("GSharp.Compiler.Program", true)!
            .GetMethod("Main", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;
        var code = -1;
        var thread = new Thread(() => {
            code = (int)entry.Invoke(null, new object[] { args.Skip(1).ToArray() })!;
        }, 512 * 1024);
        thread.Start();
        thread.Join();
        return code;
    }
}`, "bounded-stack5968")
        }

        private func AttributeChain(count int32) string {
            let source = StringBuilder("import System\n")
            for var index = 0; index < count; index++ {
                if index + 1 < count {
                    source.Append("@A").Append(index + 1).AppendLine()
                }
                source.Append("class A").Append(index).AppendLine(" : Attribute {}")
            }
            return source.ToString()
        }

        private func AttributeInheritanceChain(count int32) string {
            let source = StringBuilder("import System\n@A0\ndelegate Reader() int32;\n")
            for var index = 0; index < count; index++ {
                source
                    .Append("open class A")
                    .Append(index)
                    .Append(" : ")
                    .Append(
                    if index + 1 == count {
                        "Attribute"
                    } else {
                        "A" + (index + 1).ToString()
                    }
                )
                    .AppendLine(" {}")
            }
            return source.ToString()
        }

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
