// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import Gsharp.Values
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Security.Cryptography
import System.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import Xunit.Abstractions

/// Production ABI witnesses for ADR-0210 F1, without source fixed-array lowering.
class FixedArrayAbiTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
        this.output = output
    }

    @Fact
    func OwnerContainsFrozenSequentialValueDefinitions() {
        let assembly = typeof(Slice[_]).Assembly
        this.output.WriteLine("values owner: " + assembly.FullName)
        Assert.Equal(Version(0, 5, 0, 0), assembly.GetName().Version)
        for name in[]string{"Empty`1", "Leaf`1", "Branch`3"} {
            let type = assembly.GetType("Gsharp.Values.FixedArrays.V1." + name)
            Assert.NotNull(type)
            let definition = type!!
            Assert.True(definition.IsPublic && definition.IsValueType && definition.IsLayoutSequential)
            let fields = definition.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            Assert.Equal(
                if name == "Empty`1" {
                    0
                } else {
                    if name == "Leaf`1" {
                        1
                    } else {
                        2
                    }
                },
                fields.Length
            )
            Assert.Equal(
                if name == "Empty`1" {
                    []string{}
                } else {
                    if name == "Leaf`1" {
                        []string{"Item:T"}
                    } else {
                        []string{"Left:L", "Right:R"}
                    }
                },
                fields.OrderBy((field FieldInfo) -> field.MetadataToken).Select(
                    (field FieldInfo) -> field.Name + ":" + field.FieldType.Name
                )
            )
        }
        let abi = FixedArrayAbi(assembly)
        var distinct = HashSet[Type]()
        for var length = 0; length <= 32; length++ {
            Assert.True(distinct.Add(abi.Encode(typeof(int32), length)))
        }
        Assert.Equal(33, distinct.Count)
        Assert.Equal(
            assembly.GetType("Gsharp.Values.FixedArrays.V1.Empty`1")!!.MakeGenericType(typeof(int32)),
            abi.Encode(typeof(int32), 0)
        )
        Assert.Equal(
            assembly.GetType("Gsharp.Values.FixedArrays.V1.Leaf`1")!!.MakeGenericType(typeof(int32)),
            abi.Encode(typeof(int32), 1)
        )
        Assert.Throws[InvalidDataException](() -> abi.Encode(typeof(int32), 33))
        Assert.Throws[InvalidDataException](() -> abi.Encode(typeof(int32), -1))
        Assert.Throws[InvalidDataException](() -> abi.Encode(typeof(int32).MakeByRefType(), 1))
    }

    @Fact
    func CompleteSdkRuntimePassesStrictIlVerification() -> IlVerifier.Verify(typeof(Slice[_]).Assembly.Location)

    @Fact
    func UnsupportedImportedCapabilityReportsSourceDiagnostic() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let foreign = fixture.CompileCSharp(`
using System.Reflection;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "2")]
public sealed class FixedArrayContract { }
`, "UnsupportedFixedArrayContract")
        let (code, diagnostics) = fixture.TryCompile(
            "package FixedArrayRejected\nfunc Main() { }\n",
            "rejected",
            true,
            "/reference:" + foreign
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
        Assert.Contains("rejected.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func UnrelatedMissingAttributeDoesNotInventFixedArrayAuthority(marked bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dependency = CompileClient(
            fixture,
            "public sealed class OpaqueAttribute: System.Attribute { }",
            "OpaqueDependency"
        )
        let contract = CompileClient(fixture, `
using System.Reflection;
[assembly: Opaque]
` + (
                if marked {
                    "[assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"2\")]"
                } else {
                    ""
                }
            ) + "\npublic class Contract { }\n", "OpaqueContract", dependency)
        File.Delete(dependency)
        let (code, diagnostics) = fixture.TryCompile(
            "package OpaqueConsumer\nfunc Main() { }\n",
            "opaque-consumer",
            true,
            "/reference:" + contract
        )
        if marked {
            Assert.NotEqual(0, code)
            Assert.Contains("opaque-consumer.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("unsupported fixed-array capability revision", diagnostics, StringComparison.Ordinal)
        } else {
            Assert.True(code == 0, diagnostics)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func IndependentGsharpLibrariesExchangeCanonicalValues(referenceAssemblies bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let runtimeReference = Path.Combine(fixture.Directory, "runtime.ref.dll")
        let source = File.ReadAllText(
            Path.Combine(IlVerifier.FindRepoRoot(), "src", "Sdk", "Gsharp.Runtime.Values", "FixedArrays.V1.gs")
        )
            .Replace(
            "@assembly: AssemblyMetadata",
            "@assembly: AssemblyVersion(\"0.5.0.0\")\n@assembly: AssemblyMetadata",
            StringComparison.Ordinal
        )
        let runtime = fixture.Compile(
            source,
            "Gsharp.Runtime.Values",
            false,
            "/assemblyname:Gsharp.Runtime.Values",
            "/refout:" + runtimeReference
        )
        let owner = if referenceAssemblies {
            runtimeReference
        } else {
            runtime
        }
        let newerSource = source.Replace(
            "@assembly: AssemblyMetadata",
            "@assembly: AssemblyFileVersion(\"99.2.0.0\")\n@assembly: AssemblyMetadata",
            StringComparison.Ordinal
        )
        let newerReference = Path.Combine(fixture.Directory, "newer-runtime.ref.dll")
        let newerRuntime = fixture.Compile(
            newerSource,
            "newer-runtime",
            false,
            "/assemblyname:Gsharp.Runtime.Values",
            "/refout:" + newerReference
        )
        let consumerOwner = if referenceAssemblies {
            newerReference
        } else {
            owner
        }
        let producerReference = Path.Combine(fixture.Directory, "producer.ref.dll")
        let consumerReference = Path.Combine(fixture.Directory, "consumer.ref.dll")
        let producer = fixture.Compile(
            Library("Producer"),
            "FixedProducer",
            false,
            "/assemblyname:FixedProducer",
            "/reference:" + owner,
            "/refout:" + producerReference
        )
        let consumer = fixture.Compile(
            Library("Consumer"),
            "FixedConsumer",
            false,
            "/assemblyname:FixedConsumer",
            "/reference:" + consumerOwner,
            "/refout:" + consumerReference
        )
        let client = CompileClient(
            fixture,
            Client(),
            "FixedClient",
            owner,
            if referenceAssemblies {
                producerReference
            } else {
                producer
            },
            if referenceAssemblies {
                consumerReference
            } else {
                consumer
            }
        )
        let images = Dictionary[string, []uint8](StringComparer.Ordinal)
        for path in[]string{
            runtime,
            runtimeReference,
            newerRuntime,
            newerReference,
            producer,
            producerReference,
            consumer,
            consumerReference,
            client
        } {
            images.Add(path, File.ReadAllBytes(path))
        }
        fixture.Compile(
            source,
            "Gsharp.Runtime.Values",
            false,
            "/assemblyname:Gsharp.Runtime.Values",
            "/refout:" + runtimeReference
        )
        fixture.Compile(
            newerSource,
            "newer-runtime",
            false,
            "/assemblyname:Gsharp.Runtime.Values",
            "/refout:" + newerReference
        )
        fixture.Compile(
            Library("Producer"),
            "FixedProducer",
            false,
            "/assemblyname:FixedProducer",
            "/reference:" + owner,
            "/refout:" + producerReference
        )
        fixture.Compile(
            Library("Consumer"),
            "FixedConsumer",
            false,
            "/assemblyname:FixedConsumer",
            "/reference:" + consumerOwner,
            "/refout:" + consumerReference
        )
        CompileClient(
            fixture,
            Client(),
            "FixedClient",
            owner,
            if referenceAssemblies {
                producerReference
            } else {
                producer
            },
            if referenceAssemblies {
                consumerReference
            } else {
                consumer
            }
        )
        for image in images.OrderBy((item KeyValuePair[string, []uint8]) -> item.Key, StringComparer.Ordinal) {
            Assert.Equal(image.Value, File.ReadAllBytes(image.Key))
            this.output.WriteLine(
                Path.GetFileName(image.Key) + " sha256=" + Convert.ToHexString(SHA256.HashData(image.Value))
            )
            IlVerifier.Verify(image.Key, []string{runtime, producer, consumer})
        }
        let newer = EmittedFixture.Load(newerRuntime)
        Assert.Equal(Version(0, 5, 0, 0), newer.GetName().Version)
        Assert.Equal(
            "99.2.0.0",
            newer
                .GetCustomAttributesData()
                .Single(
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .FullName == "System.Reflection.AssemblyFileVersionAttribute"
            )
                .ConstructorArguments[0]
                .Value
        )
        let loaded = EmittedFixture.LoadTogether(runtime, producer, consumer, client)
        let abi = FixedArrayAbi(loaded[0])
        for var length = 0; length <= 32; length++ {
            let exported = loaded[1].GetType("FixedProducer.Producer")!!.GetMethod("Make" + length.ToString())!!
                .ReturnType
                .GetGenericArguments()[0]
            Assert.Equal(exported, abi.Encode(typeof(int32), length))
            Assert.Equal(length, abi.Decode(exported).Length)
        }
        Assert.Equal(
            loaded[3].GetType("FixedClient")!!.GetMethod("ExpectedTenType")!!.Invoke(nil, nil),
            abi.Encode(typeof(int32), 10)
        )
        Assert.Equal(
            "33 lengths; independent invariant exchange; generic copies; nested/reference/nullable",
            loaded[3].GetType("FixedClient")!!.GetMethod("Run")!!.Invoke(nil, nil)
        )
        let other = AssemblyLoadContext("fixed-array-distinct-owner", isCollectible: true)
        try {
            using let image = MemoryStream(File.ReadAllBytes(runtime))
            let otherOwner = other.LoadFromStream(image)
            let foreign = otherOwner.GetType("Gsharp.Values.FixedArrays.V1.Leaf`1")!!.MakeGenericType(typeof(int32))
            Assert.Throws[InvalidDataException](() -> FixedArrayAbi(loaded[0]).Decode(foreign))
            let foreignList = Activator.CreateInstance(typeof(List[_]).MakeGenericType(foreign))!!
            Assert.Throws[ArgumentException](
                () ->
                loaded[2].GetType("FixedConsumer.Consumer")!!.GetMethod("Take1")!!.Invoke(nil, []object{foreignList})
            )
        } finally {
            other.Unload()
        }
    }

    @Theory
    @InlineData("Branch<int,Empty<int>,Branch<int,Leaf<int>,Leaf<int>>>", "noncanonical")
    @InlineData("Branch<int,Empty<int>,Branch<int,Leaf<int>,Leaf<int>>>?", "noncanonical")
    @InlineData("List<Branch<int,Empty<int>,Branch<int,Leaf<int>,Leaf<int>>>>", "noncanonical")
    @InlineData("ref Branch<int,Empty<int>,Branch<int,Leaf<int>,Leaf<int>>>", "noncanonical")
    @InlineData("Branch<string,Leaf<string?>,Leaf<string?>>", "nullability")
    @InlineData("Branch<T,Leaf<T?>,Leaf<T?>>", "nullability")
    @InlineData("oversize", "noncanonical")
    func MarkedForeignShapeClaimsFailClosed(shape string, reason string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let actual = if shape == "oversize" {
            TypeName(33, "int", true)
        } else {
            shape
        }
        let contract = fixture.CompileCSharp(`
using System.Reflection;
using System.Collections.Generic;
using Gsharp.Values.FixedArrays.V1;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public static class FalseFixedShape` + (
                if actual.StartsWith("Branch<T", StringComparison.Ordinal) {
                    "<T>"
                } else {
                    ""
                }
            ) + ` {
` + (
                if actual.StartsWith("ref ", StringComparison.Ordinal) {
                    "public static void Consume(" + actual + " value) { }"
                } else {
                    "public static " + actual + " Value;"
                }
            ) + `
}`, "FalseFixedShape")
        let (code, diagnostics) = fixture.TryCompile(
            "package ShapeRejected\nfunc Main() { }\n",
            "bad-shape",
            true,
            "/reference:" + contract
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
        Assert.Contains("bad-shape.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
        Assert.Contains(reason, diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("marker")
    @InlineData("revision")
    @InlineData("duplicate")
    @InlineData("version")
    @InlineData("field")
    @InlineData("readonly")
    @InlineData("layout")
    @InlineData("pack")
    @InlineData("constraint")
    @InlineData("unmanaged")
    func IncompatibleCanonicalOwnerReportsDiagnostic(mutation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        var source = `
using System.Reflection;
using System.Runtime.InteropServices;
[assembly: AssemblyVersion("0.5.0.0")]
[assembly: AssemblyMetadata("GSharp.FixedArrayAbi", "1")]
namespace Gsharp.Values.FixedArrays.V1 {
    [StructLayout(LayoutKind.Sequential)] public struct Empty<T> { }
    [StructLayout(LayoutKind.Sequential)] public struct Leaf<T> { public T Item; }
    [StructLayout(LayoutKind.Sequential)] public struct Branch<T,L,R> where L:struct where R:struct { public L Left; public R Right; }
}
`
        source = switch mutation {
            case "marker": source.Replace(
                "[assembly: AssemblyMetadata(\"GSharp.FixedArrayAbi\", \"1\")]",
                "",
                StringComparison.Ordinal
            )
            case "revision": source.Replace("\"1\")]", "\"2\")]", StringComparison.Ordinal)
            case "duplicate": source.Replace(
                "[assembly: AssemblyMetadata(\"GSharp.FixedArrayAbi\", \"1\")]",
                "[assembly: AssemblyMetadata(\"GSharp.FixedArrayAbi\", \"1\")]\n[assembly: AssemblyMetadata(\"GSharp.FixedArrayAbi\", \"2\")]",
                StringComparison.Ordinal
            )
            case "version": source.Replace("0.5.0.0", "0.6.0.0", StringComparison.Ordinal)
            case "field": source.Replace(
                "public L Left; public R Right;",
                "public R Right; public L Left;",
                StringComparison.Ordinal
            )
            case "readonly": source.Replace("public T Item;", "public readonly T Item;", StringComparison.Ordinal)
            case "layout": source.Replace("LayoutKind.Sequential", "LayoutKind.Auto", StringComparison.Ordinal)
            case "pack": source.Replace(
                "LayoutKind.Sequential",
                "LayoutKind.Sequential, Pack=1",
                StringComparison.Ordinal
            )
            case "constraint": source.Replace(
                "where L:struct",
                "where L:struct,System.IComparable",
                StringComparison.Ordinal
            )
            case "unmanaged": source.Replace("where L:struct", "where L:unmanaged", StringComparison.Ordinal)
            default: source
        }
        let owner = CompileClient(fixture, source, "Gsharp.Runtime.Values")
        let claim = fixture.CompileCSharp(`
using System.Reflection;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public class Claim { }
`, "Claim")
        let (code, diagnostics) = fixture.TryCompile(
            "package BadOwner\nfunc Main() { }\n",
            "bad-owner",
            true,
            "/reference:" + owner,
            "/reference:" + claim
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
        Assert.Contains("bad-owner.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ForeignReexportPreservesSubstitutedNullabilityAndValueFields(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "foreign.ref.dll")
        let foreign = fixture.CompileCSharpWithReference(`
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using Gsharp.Values.FixedArrays.V1;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
[assembly: TypeForwardedTo(typeof(Leaf<>))]
namespace FixedForeign {
    public class Holder<T> { public T Item = default!; public T Echo(T value) => value; }
    public static class Exports {
        public static Holder<Branch<int,Leaf<int>,Leaf<int>>> Box() => new() { Item = Values()[0] };
        public static List<Branch<int,Leaf<int>,Leaf<int>>> Values() => new() {
            new() { Left = new() { Item = 200 }, Right = new() { Item = 201 } }
        };
        public static Branch<string?,Leaf<string?>,Leaf<string?>> Text() => new() { Right = new() { Item = "present" } };
        public static Branch<T?,Leaf<T?>,Leaf<T?>> Open<T>(T? value) => new() { Left = new() { Item = value } };
        public static Branch<Gsharp.Values.Slice<int>,Leaf<Gsharp.Values.Slice<int>>,Leaf<Gsharp.Values.Slice<int>>> Descriptors() => new() {
            Left = new() { Item = Gsharp.Values.Slice<int>.FromArray(new[] { 200 }) }
        };
    }
}`, "FixedForeign", reference)
        let imported = if referenceAssembly {
            reference
        } else {
            foreign
        }
        let app = fixture.Compile(`
package FixedForeignConsumer
import FixedForeign
import System
func Main() {
    let values = Exports.Values()
    Console.WriteLine(values[0].Left.Item)
    let box = Exports.Box()
    var local = box.Echo(box.Item)
    local.Left.Item = 99
    Console.WriteLine(box.Item.Left.Item)
    let text = Exports.Text()
    Console.WriteLine(text.Left.Item == nil)
    let present string? = text.Right.Item
    Console.WriteLine(present)
    var descriptors = Exports.Descriptors()
    var copied = descriptors
    copied.Left.Item[0] = 88
    Console.WriteLine(descriptors.Left.Item[0])
    let optional = Exports.Open[string](nil)
    Console.WriteLine(optional.Left.Item == nil)
    let nonOptional = Exports.Open[int32](7)
    let certain int32 = nonOptional.Left.Item
    Console.WriteLine(certain)
}`, "foreign-consumer", true, "/reference:" + imported)
        IlVerifier.Verify(foreign)
        IlVerifier.Verify(app, []string{foreign})
        Assert.Equal("200\n200\nTrue\npresent\n88\nTrue\n7\n", fixture.Run(app))
        let (code, diagnostics) = fixture.TryCompile(`
package FixedNullRejected
import FixedForeign
func Needs(value string) { }
func Main() { Needs(Exports.Text().Left.Item) }
`, "fixed-null-rejected", true, "/reference:" + imported)
        Assert.NotEqual(0, code)
        this.output.WriteLine(diagnostics)
        Assert.Contains("GS0154", diagnostics, StringComparison.Ordinal)
        Assert.Contains("fixed-null-rejected.gs(5,21,5,45)", diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func LookalikeIsOrdinaryUnlessItClaimsNativeShape(marked bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let foreign = fixture.CompileCSharp(`
using System.Reflection;
` + (
                if marked {
                    "[assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"1\")]"
                } else {
                    ""
                }
            ) + `
namespace Gsharp.Values.FixedArrays.V1 {
    public struct Leaf<T> { public T Item; }
    public static class Lookalike { public static Leaf<int> Value; }
}`, "Lookalike")
        let (code, diagnostics) = fixture.TryCompile(
            "package LookalikeConsumer\nfunc Main() { }\n",
            "lookalike",
            true,
            "/reference:" + foreign
        )
        if marked {
            Assert.NotEqual(0, code)
            Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
            Assert.Contains("lookalike.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
        } else {
            Assert.True(code == 0, diagnostics)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func MarkedInheritedGenericShapesAreValidated(nullableMismatch bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "inherited.ref.dll")
        let shape = if nullableMismatch {
            "Branch<string,Leaf<string?>,Leaf<string?>>"
        } else {
            "Branch<int,Empty<int>,Branch<int,Leaf<int>,Leaf<int>>>"
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public class Parent<T> { }
public class Child: Parent<` + shape + `> { }
`, "InheritedShape", reference)
        let (code, diagnostics) = fixture.TryCompile(
            "package BadInheritance\nfunc Main() { }\n",
            "bad-inheritance",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            )
        )
        Assert.NotEqual(0, code)
        Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
        Assert.Contains("bad-inheritance.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func MarkedOrdinaryHelperIsNotMistakenForACarrier() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let foreign = fixture.CompileCSharp(`
using System.Reflection;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
namespace Gsharp.Values.FixedArrays.V1 {
    public class Helper<T> { public T Item = default!; }
    public static class Api { public static Helper<Leaf<int>> Make() => new(); }
}`, "OrdinaryHelper")
        let (code, diagnostics) = fixture.TryCompile(
            "package HelperConsumer\nfunc Main() { }\n",
            "ordinary-helper",
            true,
            "/reference:" + foreign
        )
        Assert.True(code == 0, diagnostics)
    }

    @Theory
    @InlineData(false, "valid", false)
    @InlineData(false, "valid", true)
    @InlineData(false, "split", false)
    @InlineData(false, "split", true)
    @InlineData(false, "nullable", false)
    @InlineData(false, "nullable", true)
    @InlineData(true, "valid", false)
    @InlineData(true, "valid", true)
    @InlineData(true, "split", false)
    @InlineData(true, "split", true)
    @InlineData(true, "nullable", false)
    @InlineData(true, "nullable", true)
    func FixedBearingInterfaceInheritanceIsValidated(marked bool, shapeCase string, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "interface.ref.dll")
        let shape = switch shapeCase {
            case "split": "Branch<int,Empty<int>,Branch<int,Leaf<int>,Leaf<int>>>"
            case "nullable": "Branch<string,Leaf<string?>,Leaf<string?>>"
            default: "Branch<string?,Leaf<string?>,Leaf<string?>>"
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
` + (
                if marked {
                    "[assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"1\")]"
                } else {
                    ""
                }
            ) + `
public interface Parent<T> { }
public interface Child: Parent<` + shape + `> { }
`, "InterfaceShape", reference)
        let (code, diagnostics) = fixture.TryCompile(
            "package InterfaceConsumer\nfunc Main() { }\n",
            "interface-shape",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            )
        )
        if marked && shapeCase != "valid" {
            Assert.NotEqual(0, code)
            Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
            Assert.Contains("interface-shape.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
        } else {
            Assert.True(code == 0, diagnostics)
        }
        IlVerifier.Verify(foreign)
        IlVerifier.Verify(reference)
    }

    @Theory
    @InlineData(false, false, false, false)
    @InlineData(false, false, false, true)
    @InlineData(false, false, true, false)
    @InlineData(false, false, true, true)
    @InlineData(false, true, false, false)
    @InlineData(false, true, false, true)
    @InlineData(false, true, true, false)
    @InlineData(false, true, true, true)
    @InlineData(true, false, false, false)
    @InlineData(true, false, false, true)
    @InlineData(true, false, true, false)
    @InlineData(true, false, true, true)
    @InlineData(true, true, false, false)
    @InlineData(true, true, false, true)
    @InlineData(true, true, true, false)
    @InlineData(true, true, true, true)
    func FixedBearingGenericConstraintsAreValidated(marked bool, method bool, valid bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "constraint.ref.dll")
        let shape = if valid {
            "Branch<string?,Leaf<string?>,Leaf<string?>>"
        } else {
            "Branch<string,Leaf<string?>,Leaf<string?>>"
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
` + (
                if marked {
                    "[assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"1\")]"
                } else {
                    ""
                }
            ) + `
public interface Parent<T> { }
` + (
                if method {
                    "public class Api { public static void Consume<T>() where T: Parent<" + shape + "> { } }"
                } else {
                    "public class Api<T> where T: Parent<" + shape + "> { }"
                }
            ), "ConstraintShape", reference)
        let (code, diagnostics) = fixture.TryCompile(
            "package ConstraintConsumer\nfunc Main() { }\n",
            "constraint-shape",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            )
        )
        if marked && !valid {
            Assert.NotEqual(0, code)
            Assert.Contains("GS0630", diagnostics, StringComparison.Ordinal)
            Assert.Contains("constraint-shape.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
        } else {
            Assert.True(code == 0, diagnostics)
        }
        IlVerifier.Verify(foreign)
        IlVerifier.Verify(reference)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func InterfaceFixedElementNullabilitySurvivesImport(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "interface-nullable.ref.dll")
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
namespace InterfaceNullable {
    public interface Root<T> { T Item { get; } }
    public interface Middle<T>: Root<Branch<T,Leaf<T>,Leaf<T>>> { }
    public interface Child: Middle<string?> { }
    public static class Api { public static Child Make() => null!; }
}`, "InterfaceNullable", reference)
        let (code, diagnostics) = fixture.TryCompile(`
package InterfaceNullRejected
import InterfaceNullable
func Needs(value string) { }
func Main() { Needs(Api.Make().Item.Left.Item) }
`, "interface-null-rejected", true, "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            ))
        Assert.NotEqual(0, code)
        Assert.Contains("interface-null-rejected.gs(5,21,5,46): error GS0154:", diagnostics, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func InheritedMethodConstraintSubstitutionValidatesElementAnnotations(valid bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "inherited-constraint.ref.dll")
        let referenceDirectory = Directory.CreateDirectory(Path.Combine(fixture.Directory, "ref")).FullName
        let baseReference = Path.Combine(referenceDirectory, "ConstraintBase.dll")
        let baseContract = fixture.CompileCSharpWithReference(`
using Gsharp.Values.FixedArrays.V1;
public interface Parent<T> { }
public class Api<T> {
    public static void Consume<U>() where U: Parent<Branch<T,Leaf<T?>,Leaf<T?>>> { }
}
`, "ConstraintBase", baseReference)
        let baseImport = if referenceAssembly {
            baseReference
        } else {
            baseContract
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public class ClosedApi: Api<` + (
                if valid {
                    "string?"
                } else {
                    "string"
                }
            ) + `> { }
`, "InheritedConstraint", reference, baseImport)
        let (code, diagnostics) = fixture.TryCompile(
            "package ConstraintConsumer\nfunc Main() { }\n",
            "inherited-constraint",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            ),
            "/reference:" + baseImport
        )
        if valid {
            Assert.True(code == 0, diagnostics)
        } else {
            Assert.NotEqual(0, code)
            Assert.Contains("inherited-constraint.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("contradictory element nullability", diagnostics, StringComparison.Ordinal)
        }
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, false, true)
    @InlineData(false, true, false)
    @InlineData(false, true, true)
    @InlineData(true, false, false)
    @InlineData(true, false, true)
    @InlineData(true, true, false)
    @InlineData(true, true, true)
    func TransitiveFixedRelationshipsValidateClosedElementAnnotations(
        interfaceType bool,
        valid bool,
        referenceAssembly bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "transitive-relationship.ref.dll")
        let referenceDirectory = Directory.CreateDirectory(Path.Combine(fixture.Directory, "ref")).FullName
        let baseReference = Path.Combine(referenceDirectory, "TransitiveBase.dll")
        let kind = if interfaceType {
            "interface"
        } else {
            "class"
        }
        let baseContract = fixture.CompileCSharpWithReference(`
using Gsharp.Values.FixedArrays.V1;
public ` + kind + ` Parent<T> { }
public ` + kind + ` Middle<T>: Parent<Branch<T,Leaf<T?>,Leaf<T?>>> { }
`, "TransitiveBase", baseReference)
        let baseImport = if referenceAssembly {
            baseReference
        } else {
            baseContract
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public ` + kind + ` Child: Middle<` + (
                if valid {
                    "string?"
                } else {
                    "string"
                }
            ) + `> { }
`, "TransitiveRelationship", reference, baseImport)
        let (code, diagnostics) = fixture.TryCompile(
            "package TransitiveConsumer\nfunc Main() { }\n",
            "transitive-relationship",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            ),
            "/reference:" + baseImport
        )
        if valid {
            Assert.True(code == 0, diagnostics)
        } else {
            Assert.NotEqual(0, code)
            Assert.Contains("transitive-relationship.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("contradictory element nullability", diagnostics, StringComparison.Ordinal)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ConstructorFixedSignaturesUseReceiverAnnotations(valid bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "constructor-nullable.ref.dll")
        let referenceDirectory = Directory.CreateDirectory(Path.Combine(fixture.Directory, "ref")).FullName
        let baseReference = Path.Combine(referenceDirectory, "ConstructorBase.dll")
        let baseContract = fixture.CompileCSharpWithReference(`
using Gsharp.Values.FixedArrays.V1;
public class Parent<T> {
    public Parent(Branch<T,Leaf<T?>,Leaf<T?>> value) { }
}
`, "ConstructorBase", baseReference)
        let baseImport = if referenceAssembly {
            baseReference
        } else {
            baseContract
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public class Child: Parent<` + (
                if valid {
                    "string?"
                } else {
                    "string"
                }
            ) + `> {
    public Child(): base(default) { }
}
`, "ConstructorNullable", reference, baseImport)
        let (code, diagnostics) = fixture.TryCompile(
            "package ConstructorConsumer\nfunc Main() { }\n",
            "constructor-nullable",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            ),
            "/reference:" + baseImport
        )
        if valid {
            Assert.True(code == 0, diagnostics)
        } else {
            Assert.NotEqual(0, code)
            Assert.Contains("constructor-nullable.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("contradictory element nullability", diagnostics, StringComparison.Ordinal)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func AmbiguousFixedInterfaceAnnotationsRequireAnExplicitContract(marked bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ambiguous-interface.ref.dll")
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
` + (
                if marked {
                    "[assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"1\")]"
                } else {
                    ""
                }
            ) + `
public interface Parent<T> { }
public interface Left: Parent<Leaf<string>> { }
public interface Right: Parent<Leaf<string?>> { }
public interface Child: Left,Right { }
`, "AmbiguousInterface", reference)
        let (code, diagnostics) = fixture.TryCompile(
            "package AmbiguousConsumer\nfunc Main() { }\n",
            "ambiguous-interface",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            )
        )
        if marked {
            Assert.NotEqual(0, code)
            Assert.Contains("ambiguous-interface.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("ambiguous fixed-bearing interface annotations", diagnostics, StringComparison.Ordinal)
        } else {
            Assert.True(code == 0, diagnostics)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func FixedInterfaceRowsResolveFrameworkForwarders(valid bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "framework-interface.ref.dll")
        let shape = if valid {
            "Leaf<string?>"
        } else {
            "Branch<string,Leaf<string?>,Leaf<string?>>"
        }
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
public interface Child: System.Collections.Generic.IEnumerable<` + shape + `> { }
`, "FrameworkInterface", reference)
        let (code, diagnostics) = fixture.TryCompile(
            "package FrameworkConsumer\nfunc Main() { }\n",
            "framework-interface",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            )
        )
        if valid {
            Assert.True(code == 0, diagnostics)
        } else {
            Assert.NotEqual(0, code)
            Assert.Contains("framework-interface.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("contradictory element nullability", diagnostics, StringComparison.Ordinal)
        }
        IlVerifier.Verify(foreign)
        IlVerifier.Verify(reference)
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, false, true)
    @InlineData(false, true, false)
    @InlineData(false, true, true)
    @InlineData(true, false, false)
    @InlineData(true, false, true)
    @InlineData(true, true, false)
    @InlineData(true, true, true)
    func UnsafeFixedSignatureClaimsFailClosed(marked bool, functionPointer bool, referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let signature = if functionPointer {
            "delegate*<Branch<int,Leaf<int>,Empty<int>>,void>"
        } else {
            "Branch<int,Leaf<int>,Empty<int>>*"
        }
        let source = `
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
` + (
            if marked {
                "[assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"1\")]"
            } else {
                ""
            }
        ) + `
public static unsafe class Api { public static ` + signature + ` Value; }
`
        let paths = ReferenceResolver
            .HostTrustedPlatformAssemblyPaths()
            .Append(typeof(Slice[_]).Assembly.Location)
            .Distinct(StringComparer.Ordinal)
        let compilation = CSharpCompilation.Create(
            "UnsafeFixedContract",
            []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
            paths.Select((path string) -> MetadataReference.CreateFromFile(path)),
            CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                allowUnsafe: true,
                nullableContextOptions: NullableContextOptions.Enable
            )
        )
        let foreign = Path.Combine(fixture.Directory, "UnsafeFixedContract.dll")
        let reference = Path.Combine(fixture.Directory, "unsafe-fixed.ref.dll")
        {
            using let implementation = File.Create(foreign)
            using let refStream = File.Create(reference)
            let emitted = compilation.Emit(
                implementation,
                metadataPEStream: refStream,
                options: Microsoft.CodeAnalysis.Emit.EmitOptions(includePrivateMembers: false)
            )
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        }
        let (code, diagnostics) = fixture.TryCompile(
            "package UnsafeConsumer\nfunc Main() { }\n",
            "unsafe-fixed",
            true,
            "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            )
        )
        if marked {
            Assert.NotEqual(0, code)
            Assert.Contains("unsafe-fixed.gs(1,1,3,1): error GS0630:", diagnostics, StringComparison.Ordinal)
            Assert.Contains("behind unmanaged pointers are unsupported", diagnostics, StringComparison.Ordinal)
        } else {
            Assert.True(code == 0, diagnostics)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func InheritedFixedElementNullabilitySurvivesImport(referenceAssembly bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "inherited-nullable.ref.dll")
        let foreign = fixture.CompileCSharpWithReference(`
using System.Reflection;
using Gsharp.Values.FixedArrays.V1;
[assembly: AssemblyMetadata("GSharp.FixedArrays", "1")]
namespace InheritedNullable {
    public class Holder<T> { public T Item = default!; }
    public class Derived: Holder<Branch<string?,Leaf<string?>,Leaf<string?>>> { }
    public static class Api { public static Derived Make() => new(); }
}`, "InheritedNullable", reference)
        let (code, diagnostics) = fixture.TryCompile(`
package InheritedNullRejected
import InheritedNullable
func Needs(value string) { }
func Main() { Needs(Api.Make().Item.Left.Item) }
`, "inherited-null-rejected", true, "/reference:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    foreign
                }
            ))
        Assert.NotEqual(0, code)
        Assert.Contains("GS0154", diagnostics, StringComparison.Ordinal)
        Assert.Contains("inherited-null-rejected.gs(5,21,5,46)", diagnostics, StringComparison.Ordinal)
    }

    shared {
        private func TypeName(length int32, element string, csharp bool) string {
            let begin = if csharp {
                "<"
            } else {
                "["
            }
            let close = if csharp {
                ">"
            } else {
                "]"
            }
            return if length == 0 {
                "Empty" + begin + element + close
            } else {
                if length == 1 {
                    "Leaf" + begin + element + close
                } else {
                    "Branch" +
                        begin +
                        element +
                        "," +
                        TypeName(length / 2, element, csharp) +
                        "," +
                        TypeName(length - length / 2, element, csharp) +
                        close
                }
            }
        }

        private func ElementPath(length int32, index int32) string -> if length == 1 {
            ".Item"
        } else {
            if index < length / 2 {
                ".Left" + ElementPath(length / 2, index)
            } else {
                ".Right" + ElementPath(length - length / 2, index - length / 2)
            }
        }

        private func Library(kind string) string {
            let text = StringBuilder(
                "package Fixed" +
                    kind +
                    "\nimport System.Reflection\nimport System.Collections.Generic\nimport Gsharp.Values.FixedArrays.V1\n@assembly: AssemblyMetadata(\"GSharp.FixedArrays\", \"1\")\nshared class " +
                    kind +
                    " {\n"
            )
            for var length = 0; length <= 32; length++ {
                let type = TypeName(length, "int32", false)
                if kind == "Producer" {
                    text.AppendLine("func Make" + length.ToString() + "() List[" + type + "] {")
                    text.AppendLine("var value " + type + " = default")
                    for var index = 0; index < length; index++ {
                        text.AppendLine(
                            "value" + ElementPath(length, index) + " = " + (length * 100 + index).ToString()
                        )
                    }
                    text.AppendLine("return List[" + type + "]{value}\n}")
                } else {
                    text.AppendLine("func Take" + length.ToString() + "(values List[" + type + "]) int32 {")
                    text.AppendLine("if values.Count != 1 { return -1 }\nvar value = values[0]")
                    for var index = 0; index < length; index++ {
                        text.AppendLine(
                            "if value" + ElementPath(length, index) + " != " + (length * 100 + index).ToString() +
                                " { return -2 }"
                        )
                    }
                    if length > 0 {
                        text.AppendLine(
                            "value" +
                                ElementPath(length, 0) +
                                " = -1\nif values[0]" +
                                ElementPath(length, 0) +
                                " != " +
                                (length * 100).ToString() + " { return -3 }"
                        )
                    }
                    text.AppendLine("return 1\n}")
                }
            }
            text.AppendLine("func Open[T](value Branch[T,Leaf[T],Leaf[T]]) Branch[T,Leaf[T],Leaf[T]] -> value")
            return text.AppendLine("}").ToString()
        }

        private func Client() string {
            let text = StringBuilder(`
using System;
using System.Collections.Generic;
using Gsharp.Values.FixedArrays.V1;
using Pair = Gsharp.Values.FixedArrays.V1.Branch<int,Gsharp.Values.FixedArrays.V1.Leaf<int>,Gsharp.Values.FixedArrays.V1.Leaf<int>>;
using Five = Gsharp.Values.FixedArrays.V1.Branch<int,Gsharp.Values.FixedArrays.V1.Branch<int,Gsharp.Values.FixedArrays.V1.Leaf<int>,Gsharp.Values.FixedArrays.V1.Leaf<int>>,Gsharp.Values.FixedArrays.V1.Branch<int,Gsharp.Values.FixedArrays.V1.Leaf<int>,Gsharp.Values.FixedArrays.V1.Branch<int,Gsharp.Values.FixedArrays.V1.Leaf<int>,Gsharp.Values.FixedArrays.V1.Leaf<int>>>>;
public static class FixedClient {
    private enum Shade:byte { Blue=3 }
    private struct Token { public int Value; }
    public static Type ExpectedTenType() => typeof(Branch<int,Five,Five>);
    private static (T,T) Duplicate<T>(T value) => (value,value);
    private static void Check(bool ok) { if (!ok) throw new Exception("fixed-array exchange"); }
    public static string Run() {
        int count = 0;
`)
            for var length = 0; length <= 32; length++ {
                text.AppendLine(
                    "count += FixedConsumer.Consumer.Take" + length.ToString() +
                        "(FixedProducer.Producer.Make" +
                        length.ToString() + "());"
                )
            }
            return text.AppendLine(`
        Check(count == 33);
        var foreign = new List<Pair> { new Pair { Left = new Leaf<int> { Item = 200 }, Right = new Leaf<int> { Item = 201 } } };
        Check(FixedConsumer.Consumer.Take2(foreign) == 1);
        var values = FixedProducer.Producer.Make2();
        var copies = Duplicate(values[0]);
        copies.Item1.Left.Item = 999;
        Check(copies.Item2.Left.Item == 200 && values[0].Left.Item == 200);
        var nested = new Branch<Pair,Leaf<Pair>,Leaf<Pair>> { Left = new Leaf<Pair> { Item = values[0] } };
        var nestedCopy = FixedConsumer.Consumer.Open(FixedProducer.Producer.Open(nested));
        nestedCopy.Left.Item.Left.Item = 7;
        Check(nested.Left.Item.Left.Item == 200);
        var item = new object();
        var references = new Branch<object,Leaf<object>,Leaf<object>> { Left = new Leaf<object> { Item = item } };
        var refs = FixedConsumer.Consumer.Open(FixedProducer.Producer.Open(references));
        refs.Right.Item = new object();
        Check(ReferenceEquals(refs.Left.Item,item) && references.Right.Item == null);
        var nullable = new Branch<int?,Leaf<int?>,Leaf<int?>> { Right = new Leaf<int?> { Item = 42 } };
        var optional = FixedConsumer.Consumer.Open(FixedProducer.Producer.Open(nullable));
        Check(optional.Left.Item == null && optional.Right.Item == 42);
        var enums = new Branch<Shade,Leaf<Shade>,Leaf<Shade>> { Left = new() { Item = Shade.Blue } };
        Check(FixedConsumer.Consumer.Open(FixedProducer.Producer.Open(enums)).Left.Item == Shade.Blue);
        var structs = new Branch<Token,Leaf<Token>,Leaf<Token>> { Left = new() { Item = new Token { Value = 7 } } };
        var structCopy = FixedConsumer.Consumer.Open(FixedProducer.Producer.Open(structs));
        structCopy.Left.Item.Value = 9;
        Check(structs.Left.Item.Value == 7);
        var array = new[] { 4 };
        var arrays = new Branch<int[],Leaf<int[]>,Leaf<int[]>> { Left = new() { Item = array } };
        var arrayCopy = FixedConsumer.Consumer.Open(FixedProducer.Producer.Open(arrays));
        arrayCopy.Left.Item[0] = 8;
        Check(arrays.Left.Item[0] == 8 && ReferenceEquals(array,arrayCopy.Left.Item));
        return "33 lengths; independent invariant exchange; generic copies; nested/reference/nullable";
    }
}`).ToString()
        }

        private func CompileClient(
            fixture NativeSliceLanguageTests.Fixture,
            source string,
            name string,
            references ...string
        ) string {
            let paths = ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Where((path string) -> Path.GetFileNameWithoutExtension(path) != "Gsharp.Runtime.Values")
                .Concat(references)
                .Distinct(StringComparer.Ordinal)
            let compilation = CSharpCompilation.Create(
                name,
                []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                paths.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable,
                    deterministic: true
                )
            )
            let path = Path.Combine(fixture.Directory, name + ".dll")
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            return path
        }
    }
}
