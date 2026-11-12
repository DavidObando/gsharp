// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

class Issue5983SegmentedAliasTargetTests {
    @Theory
    @InlineData(
        "class Outer[T] { public open class Base[U] {} }",
        "Outer[int32, string].Base[bool]",
        "GS0149",
        "(3,15,3,20)"
    )
    @InlineData(
        "class Outer[T] { public open class Base[U] {} }",
        "Outer[int32].Base[string, bool]",
        "GS0113",
        "(3,15,3,20)"
    )
    @InlineData("class Outer[T] { public open class Base {} }", "Outer[int32].Missing", "GS0113", "(3,15,3,20)")
    @InlineData("class Outer[T struct] { public open class Base {} }", "Outer[string].Base", "GS0152", "(3,15,3,20)")
    @InlineData(
        "class Outer[T] { public open class Base[U struct] {} }",
        "Outer[int32].Base[string]",
        "GS0152",
        "(3,28,3,32)"
    )
    func InvalidSegmentsRetainCanonicalLocatedDiagnostics(
        declaration string,
        target string,
        diagnostic string,
        location string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package AliasReject\n" + declaration + "\ntype Parent = " + target + "\n",
            "reject",
            false
        )
        Assert.Equal(1, code)
        Assert.Contains("reject.gs$location: error $diagnostic", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0005", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "reject.dll")))
    }

    @Fact
    func IncompleteNestedTargetReportsMissingBracketAtEndOfInput() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package AliasReject\nclass Outer[T] { public open class Base[U] {} }\ntype Parent = Outer[int32].Base[\n",
            "incomplete",
            false
        )
        Assert.Equal(1, code)
        Assert.Contains(
            "incomplete.gs(4,1,4,1): error GS0005: Unexpected token <EndOfFileToken>, expected <CloseSquareBracketToken>.",
            output,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("expected <IdentifierToken>", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "incomplete.dll")))
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func AliasPreservesConstructedOuterAndNestedArguments(aliasFirst bool, genericInner bool) {
        using let direct = NativeSliceLanguageTests.Fixture()
        using let aliased = NativeSliceLanguageTests.Fixture()
        let control = direct.Compile(Source(false, aliasFirst, genericInner), "witness", true)
        VerifyStrict(control)
        let expected = Encoding.UTF8.GetBytes(
            if genericInner {
                "42${Environment.NewLine}inner${Environment.NewLine}"
            } else {
                "42${Environment.NewLine}"
            }
        )
        Assert.Equal(expected, direct.RunBytes(control))
        let output = aliased.Compile(Source(true, aliasFirst, genericInner), "witness", true)
        VerifyStrict(output)
        Assert.Equal(expected, aliased.RunBytes(output))
        Assert.Equal(BaseSignature(control), BaseSignature(output))
        AssertMetadata(output, genericInner)
    }

    shared {
        private func Source(useAlias bool, aliasFirst bool, genericInner bool) string {
            let target = if genericInner {
                "Outer[int32].Base[string]"
            } else {
                "Outer[int32].Base"
            }
            let alias = if useAlias {
                "type Parent = $target\n"
            } else {
                string.Empty
            }
            let declarations = if genericInner {
                `open class Base[U] {}
class Outer[T] {
    public open class Base[U] {
        public var Item T
        public var Other U
    }
}
`
            } else {
                `open class Base {}
class Outer[T] {
    public open class Base {
        public var Item T
    }
}
`
            }
            return "package AliasTargets\nimport System\n" +
                (
                if aliasFirst {
                    alias + declarations
                } else {
                    declarations + alias
                }
            ) +
                "class Derived : " +
                (
                if useAlias {
                    "Parent"
                } else {
                    target
                }
            ) +
                " {}\n" +
                `func Main() {
    let value = Derived()
    value.Item = 42
    Console.WriteLine(value.Item)
` +
                (
                if genericInner {
                    "    value.Other = \"inner\"\n    Console.WriteLine(value.Other)\n"
                } else {
                    string.Empty
                }
            ) +
                "}\n"
        }

        private func VerifyStrict(path string) {
            var report = string.Empty
            IlVerifier.Verify(
                path,
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }

        private func BaseSignature(path string)[]uint8 {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            let derived = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((type TypeDefinition) -> reader.GetString(type.Name) == "Derived")
            Assert.Equal(HandleKind.TypeSpecification, derived.BaseType.Kind)
            return reader.GetBlobBytes(
                reader.GetTypeSpecification(cast[TypeSpecificationHandle](derived.BaseType)).Signature
            )
        }

        private func AssertMetadata(path string, genericInner bool) {
            let runtimePaths = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
            using let context = MetadataLoadContext(PathAssemblyResolver(runtimePaths.Append(path)))
            let assembly = context.LoadFromAssemblyPath(path)
            let derived = assembly.GetType("AliasTargets.Derived", throwOnError: true)!!
            let parent = derived.BaseType!!
            Assert.Equal(
                if genericInner {
                    "AliasTargets.Outer`1+Base`1"
                } else {
                    "AliasTargets.Outer`1+Base"
                },
                parent.GetGenericTypeDefinition().FullName
            )
            Assert.Equal(
                if genericInner {
                    []string{"System.Int32", "System.String"}
                } else {
                    []string{"System.Int32"}
                },
                parent.GetGenericArguments().Select((type Type) -> type.FullName).ToArray()
            )
            Assert.Equal("System.Int32", parent.GetField("Item")!!.FieldType.FullName)
            if genericInner {
                Assert.Equal("System.String", parent.GetField("Other")!!.FieldType.FullName)
            }
            Assert.Null(assembly.GetType("AliasTargets.Parent"))
        }
    }
}
