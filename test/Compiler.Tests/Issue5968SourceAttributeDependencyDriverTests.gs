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
    @InlineData(false)
    @InlineData(true)
    func DeepAttributeDependencies_ReportLocatedDiagnosticWithoutCrashing(inheritance bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let driver = CompileBoundedStackDriver(fixture)
        let sourceFile = Path.Combine(fixture.Directory, "dependency.gs")
        let outputFile = Path.Combine(fixture.Directory, "dependency.dll")
        File.WriteAllText(
            sourceFile,
            if inheritance {
                AttributeInheritanceChain(8)
            } else {
                AttributeChain(8)
            }
        )
        let (controlCode, controlOutput) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
            sourceFile,
            outputFile,
            driver
        )
        Assert.True(controlCode == 0, controlOutput)
        File.Delete(outputFile)
        let source = if inheritance {
            AttributeInheritanceChain(8192)
        } else {
            AttributeChain(8192)
        }
        File.WriteAllText(sourceFile, source)
        let (code, output) = Issue4143CyclicAttributeDeclarationValidationTests.RunGscOutOfProcess(
            sourceFile,
            outputFile,
            driver
        )
        Assert.True(
            code == 1,
            "Expected recoverable compiler error; exit " + code.ToString() + ": " + output.Substring(
                0,
                Math.Min(output.Length, 500)
            )
        )
        Assert.DoesNotContain("Stack overflow", output, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("GS9998", output)
        let diagnostic = Assert.Single(DiagnosticLocations(output))
        Assert.StartsWith("GS0639@", diagnostic)
        let span = diagnostic
            .Substring(diagnostic.IndexOf('@') + 1)
            .Split(',')
            .Select((value string) -> int32.Parse(value))
            .ToArray()
        Assert.Equal(span[0], span[2])
        let line = source.Split('\n')[span[0] - 1].TrimEnd('\r')
        let identifier = Regex.Match(line, "^(?:open )?class (A[0-9]+) : ").Groups[1].Value
        Assert.NotEmpty(identifier)
        let column = if inheritance {
            12
        } else {
            7
        }
        Assert.Equal(column, span[1])
        Assert.Equal(column + identifier.Length, span[3])
        Assert.False(File.Exists(outputFile))
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
