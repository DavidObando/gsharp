// <copyright file="Issue4765AbstractPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import Xunit.Abstractions
import MetadataParameter = System.Reflection.Metadata.Parameter
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis.Emit

class Issue4765AbstractPropertyEmitTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, true, true)
    @InlineData(true, false, false)
    @InlineData(true, true, false)
    @InlineData(true, true, true)
    func TranslatedAbstractContracts_MatchRoslynMetadataDispatchAndCopy(record bool, generic bool, partial bool) {
        let name = if partial {
            "package"
        } else {
            "Value"
        }
        let parameterType = if generic {
            "T"
        } else {
            "int"
        }
        let baseUse = if generic {
            "R<int>"
        } else {
            "R"
        }
        let kind = if record {
            "record"
        } else {
            "class"
        }
        let source = (`namespace AbstractProperties {
    public static class Counter {
        public static int Calls;
        public static int Next() => ++Calls;
    }
    public abstract ` + "${(if partial { "partial " } else { "" })}" + "$kind" + ` R` + "${(if generic { "<T>" } else { "" })}" + "${(if record && !partial { "(" + parameterType + " " + name + ")" } else { "" })}" + ` {
        public abstract ` + "$parameterType" + ` ` + "$name" + ` { get; ` + "${(if record { "init" } else { "set" })}" + `; }
    }
    public sealed ` + "$kind" + ` Item : ` + "$baseUse" + `, Foreign.Readable {
        public override int ` + "$name" + ` { get; ` + "${(if record { "init" } else { "set" })}" + `; } = Counter.Next();
        private int stamp = Counter.Next();
        public int Stamp => stamp;
        public Item(int value)` + "${(if record { ": base(value)" } else { "" })}" + ` { }
    }
    public static class Driver {
        public static string Run() {
            ` + "$baseUse" + ` root = new Item(7);
            ` + "${(if record { "var copy = ((Item)root) with { " + name + " = Counter.Next() }; return root." + name + " + \",\" + copy." + name + " + \",\" + ((Item)root).Stamp + \",\" + copy.Stamp + \",\" + Counter.Calls;" } else { "root." + name + " = Counter.Next(); return root." + name + " + \",\" + ((Item)root).Stamp + \",\" + Counter.Calls;" })}" + `
        }
    }
}`)
        let sources = if partial && record {
            [](string, string){("Header.cs", (`namespace AbstractProperties {
    public abstract partial record R` + "${(if generic { "<T>" } else { "" })}" + `(` + "$parameterType" + ` ` + "$name" + `);
}`)), ("Body.cs", source)}
        } else {
            cast[[](string, string)]([](string, source string){("Body.cs", source)})
        }
        using let nativeContract = CSharpFixture(
            "namespace Foreign { public interface Readable { int Stamp { get; } } }"
        )
        let references = ReferenceResolver
            .HostTrustedPlatformAssemblyPaths()
            .Select((path string) -> MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(nativeContract.AssemblyPath))
            .ToArray()
        let compilation = CSharpCompilation.Create(
            "RoslynBaseline",
            sources.Select(
                (sourceFile(string, string)) -> CSharpSyntaxTree.ParseText(sourceFile.Item2, path: sourceFile.Item1)
            ),
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
        )
        using let fixture = NativeSliceLanguageTests.Fixture()
        let baselinePath = Path.Combine(fixture.Directory, "RoslynBaseline.dll")
        {
            using let stream = File.Create(baselinePath)
            let emitted = compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        }
        let translatedFiles = compilation
            .SyntaxTrees
            .Select(
            (tree SyntaxTree) -> {
                let document = LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree))
                let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
                let text = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                Assert.DoesNotContain(
                    context.Diagnostics,
                    (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                )
                return text
            }
        )
            .ToArray()
        let translated = string.Join("\n", translatedFiles)
        this.output.WriteLine(translated)
        Assert.Contains("abstract prop ", translated, StringComparison.Ordinal)
        let extraSources = translatedFiles
            .Skip(1)
            .Select(
            (text string, index int32) -> {
                let path = Path.Combine(fixture.Directory, "Part" + index.ToString() + ".gs")
                File.WriteAllText(path, text)
                return path
            }
        )
            .ToArray()
        let dll = fixture.Compile(
            translatedFiles[0],
            "TranslatedAbstractProperties",
            false,
            []string{"/r:" + nativeContract.AssemblyPath}.Concat(extraSources).ToArray()
        )
        this.LogProduct(baselinePath)
        this.LogProduct(dll)
        Verify(dll, nativeContract.AssemblyPath)
        Verify(baselinePath, nativeContract.AssemblyPath)
        let baseline = EmittedFixture.LoadTogether(nativeContract.AssemblyPath, baselinePath)[1]
        let actual = EmittedFixture.LoadTogether(nativeContract.AssemblyPath, dll)[1]
        let originalBase = RequiredType(
            baseline,
            "AbstractProperties.R" +
                (
                if generic {
                    "`1"
                } else {
                    ""
                }
            )
        )
        let actualBase = RequiredType(
            actual,
            "AbstractProperties.R" +
                (
                if generic {
                    "`1"
                } else {
                    ""
                }
            )
        )
        Assert.Empty(
            actualBase.GetFields(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly
            )
        )
        CompareContract(originalBase, actualBase, name, init: record)
        let actualItem = RequiredType(actual, "AbstractProperties.Item")
        let itemProperty = RequiredProperty(actualItem, name)
        Assert.False(itemProperty.GetMethod!!.IsAbstract)
        Assert.False(itemProperty.SetMethod!!.IsAbstract)
        Assert.Equal(
            record,
            itemProperty.SetMethod!!
                .ReturnParameter
                .GetRequiredCustomModifiers()
                .Any((type Type) -> type.FullName == "System.Runtime.CompilerServices.IsExternalInit")
        )
        Assert.Contains(
            actualItem.GetFields(BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly),
            (field FieldInfo) -> field.FieldType == typeof(int32)
        )
        let expected = if record {
            "1,3,2,2,3"
        } else {
            "3,2,3"
        }
        Assert.Equal(expected, Run(baseline))
        Assert.Equal(expected, Run(actual))
    }

    @Theory
    @InlineData("set")
    @InlineData("init")
    func NativeExplicitAbstractAndReabstractProperties_AreStorageFree(write string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile((`package NativeAbstract
public abstract class Base {
    public abstract prop Value int32 { get; ` + "$write" + `; }
}
public abstract class Retained : Base { }
public abstract class Middle : Retained {
    public abstract override prop Value int32 { get; ` + "$write" + `; }
}
public class Item : Middle {
    public override prop Value int32 { get; ` + "$write" + `; }
    public init(value int32) { this.Value = value }
}
public class Driver {
    shared {
        public func Run() int32 {
            let item Base = Item(7)
            return item.Value
        }
    }
}`), "NativeAbstract", false)
        this.LogProduct(dll)
        Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let parent = RequiredType(assembly, "NativeAbstract.Base")
        let middle = RequiredType(assembly, "NativeAbstract.Middle")
        Assert.Empty(
            parent.GetFields(
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly
            )
        )
        Assert.Empty(
            middle.GetFields(
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly
            )
        )
        for type in[]Type{parent, middle} {
            let property = RequiredProperty(type, "Value")
            AssertAbstractAccessor(property.GetMethod, newSlot: type == parent)
            AssertAbstractAccessor(property.SetMethod, newSlot: type == parent)
            Assert.Equal(
                write == "init",
                property.SetMethod!!
                    .ReturnParameter
                    .GetRequiredCustomModifiers()
                    .Any((modifier Type) -> modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit")
            )
        }
        Assert.Equal(7, RequiredType(assembly, "NativeAbstract.Driver").GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func CovariantReabstractGetter_MatchesRoslynInImplementationAndReferenceMetadata() {
        const nativeSource = `namespace CovariantAbstract {
    public class Value { }
    public class NarrowValue : Value { }
    public abstract class Base { public abstract Value Item { get; } }
    public abstract class Middle : Base { public abstract override NarrowValue Item { get; } }
}`
        using let native = CSharpFixture(nativeSource)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "CovariantAbstract.ref.dll")
        let dll = fixture.Compile(`package CovariantAbstract
public open class Value { }
public class NarrowValue : Value { }
public abstract class Base { public abstract prop Item Value { get; } }
public abstract class Middle : Base { public abstract override prop Item NarrowValue { get; } }`, "CovariantAbstract", false, "/refout:" +
                reference)
        Verify(native.AssemblyPath)
        Verify(dll)
        let expected = ReadCovariantAbstractGetterShape(native.AssemblyPath)
        Assert.True((expected.Attributes & MethodAttributes.NewSlot) != 0)
        for path in[]string{dll, reference} {
            this.LogProduct(path)
            Assert.Equal(expected, ReadCovariantAbstractGetterShape(path))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedCovariantGetter_MatchesReferencedRoslynContract(reabstract bool) {
        using let contract = CSharpFixture(`namespace ImportedCovariant {
    public abstract class Base { public abstract object Item { get; } }
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceResolver
            .HostTrustedPlatformAssemblyPaths()
            .Select((path string) -> MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(contract.AssemblyPath))
        let compilation = CSharpCompilation.Create(
            "ImportedCovariantRoslyn",
            []SyntaxTree{
                CSharpSyntaxTree.ParseText(
                    if reabstract {
                        `namespace ImportedCovariant {
    public abstract class Middle : Base {
        public abstract override string Item { get; }
    }
}`
                    } else {
                        `namespace ImportedCovariant {
    public class Middle : Base {
        public override string Item => "x";
    }
}`
                    }
                )
            },
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let expected = Path.Combine(fixture.Directory, "ImportedCovariantRoslyn.dll")
        {
            using let stream = File.Create(expected)
            let emitted = compilation.Emit(stream)
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        }
        let expectedReference = Path.Combine(fixture.Directory, "ImportedCovariantRoslyn.ref.dll")
        {
            using let stream = File.Create(expectedReference)
            let emitted = compilation.Emit(stream, options: EmitOptions(metadataOnly: true))
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics))
        }
        let reference = Path.Combine(fixture.Directory, "ImportedCovariant.ref.dll")
        let dll = fixture.Compile(
            if reabstract {
                `package ImportedCovariant
public abstract class Middle : Base {
    public abstract override prop Item string { get; }
}`
            } else {
                `package ImportedCovariant
public class Middle : Base {
    public override prop Item string -> "x"
}`
            },
            "ImportedCovariant",
            false,
            "/r:" + contract.AssemblyPath,
            "/refout:" + reference
        )
        Verify(expected, contract.AssemblyPath)
        Verify(dll, contract.AssemblyPath)
        let expectedShape = ReadCovariantAbstractGetterShape(expected)
        let expectedReferenceShape = ReadCovariantAbstractGetterShape(expectedReference)
        Assert.True((expectedShape.Attributes & MethodAttributes.NewSlot) != 0)
        this.LogProduct(dll)
        this.LogProduct(reference)
        let actualShape = ReadCovariantAbstractGetterShape(dll)
        let actualReferenceShape = ReadCovariantAbstractGetterShape(reference)
        AssertCovariantSlotShape(expectedShape, actualShape)
        AssertCovariantSlotShape(expectedReferenceShape, actualReferenceShape)
        Assert.Equal(!reabstract, actualShape.HasBody)
        Assert.False(actualReferenceShape.HasBody)
    }

    @Fact
    func ImportedCovariantGetter_PreservesOriginalSlotThroughFurtherOverride() {
        using let contract = CSharpFixture(`namespace ImportedCovariantChain {
    public abstract class Base { public abstract object Item { get; } }
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ImportedCovariantChain.ref.dll")
        let dll = fixture.Compile(`package ImportedCovariantChain
public open class Middle : Base {
    public open override prop Item string -> "middle"
}
public class Leaf : Middle {
    public override prop Item string -> "leaf"
}`, "ImportedCovariantChain", false, "/r:" + contract.AssemblyPath, "/refout:" + reference)
        const consumer = `namespace ImportedCovariantChain {
    public static class Driver {
        public static string Run() {
            Base throughBase = new Leaf();
            Middle throughMiddle = (Middle)throughBase;
            return (string)throughBase.Item + ":" + throughMiddle.Item;
        }
    }
}`
        for path in[]string{dll, reference} {
            let caller = fixture.CompileCSharp(
                consumer,
                if path == dll {
                    "ImplementationCaller"
                } else {
                    "ReferenceCaller"
                },
                path,
                contract.AssemblyPath
            )
            let assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, dll, caller)
            let run MethodInfo? = RequiredType(assemblies[2], "ImportedCovariantChain.Driver").GetMethod("Run")
            Assert.Equal("leaf:leaf", run!!.Invoke(nil, nil))
        }
    }

    @Fact
    func InheritedGenericOverrideDischargesTheOriginalAccessorSlots() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package GenericAbstract
public abstract class Base[T] { public abstract prop Value T { get; set; } }
public open class Middle[T] : Base[T] { public override prop Value T { get; set; } }
public class Item : Middle[int32] { }
public class Driver {
    shared {
        public func Run() int32 {
            let item Base[int32] = Item()
            item.Value = 13
            return item.Value
        }
    }
}`, "GenericAbstract", false)
        this.LogProduct(dll)
        Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        Assert.False(RequiredType(assembly, "GenericAbstract.Middle`1").IsAbstract)
        Assert.False(RequiredType(assembly, "GenericAbstract.Item").IsAbstract)
        Assert.Equal(13, RequiredType(assembly, "GenericAbstract.Driver").GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func ExplicitReabstractOverridePreservesRoslynImportedSlotsAndProtectedInit() {
        using let native = CSharpFixture(`namespace ImportedContracts {
    public abstract class Contract<T> {
        public abstract T Value { get; protected init; }
    }
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ImportedAbstract
import ImportedContracts
public abstract class Bridge : Contract[int32] {
    public abstract override prop Value int32 { get; protected init; }
}
public class Item : Bridge {
    public override prop Value int32 { get; protected init; }
    public init(value int32) { this.Value = value }
}
public class Driver {
    shared {
        public func Run() int32 {
            let item Contract[int32] = Item(11)
            return item.Value
        }
    }
}`, "ImportedAbstract", false, "/r:" + native.AssemblyPath)
        this.LogProduct(native.AssemblyPath)
        this.LogProduct(dll)
        Verify(native.AssemblyPath)
        Verify(dll, native.AssemblyPath)
        let assembly = EmittedFixture.LoadTogether(native.AssemblyPath, dll)[1]
        let bridge = RequiredType(assembly, "ImportedAbstract.Bridge")
        Assert.Empty(
            bridge.GetFields(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )
        )
        let property = RequiredProperty(bridge, "Value")
        AssertAbstractAccessor(property.GetMethod, newSlot: false)
        Assert.True(property.SetMethod!!.IsFamily)
        Assert.True(property.SetMethod!!.IsAbstract)
        Assert.False((property.SetMethod!!.Attributes & MethodAttributes.NewSlot) != 0)
        Assert.Equal("value", Assert.Single(property.SetMethod!!.GetParameters()).Name)
        Assert.Equal(
            "System.Runtime.CompilerServices.IsExternalInit",
            Assert.Single(property.SetMethod!!.ReturnParameter.GetRequiredCustomModifiers()).FullName
        )
        Assert.Equal(11, RequiredType(assembly, "ImportedAbstract.Driver").GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func RoslynGetterOnlyContractAndInitializedOverrideStayGetterOnly() {
        const source = `namespace GetterContract {
    public abstract class Base { public abstract int Value { get; } }
    public sealed class Item : Base {
        public override int Value { get; } = 17;
    }
    public static class Driver { public static int Run() { Base value = new Item(); return value.Value; } }
}`
        using let reference = CSharpFixture(source)
        let compilation = CSharpCompilation.Create(
            "GetterBaseline",
            []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(
                (path string) -> MetadataReference.CreateFromFile(path)
            ),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let tree = Assert.Single(compilation.SyntaxTrees)
        let document = LoadedDocument("Getter.cs", tree, compilation.GetSemanticModel(tree))
        let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
        let translated = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(translated, "GetterContract", false, "/r:" + reference.AssemblyPath)
        this.LogProduct(reference.AssemblyPath)
        this.LogProduct(dll)
        Verify(dll, reference.AssemblyPath)
        let expected = reference.Load()
        let actual = EmittedFixture.Load(dll)
        let contract = RequiredProperty(RequiredType(actual, "GetterContract.Base"), "Value")
        AssertAbstractAccessor(contract.GetMethod, newSlot: true)
        Assert.Null(contract.SetMethod)
        Assert.Empty(
            RequiredType(actual, "GetterContract.Base").GetFields(
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly
            )
        )
        let item = RequiredProperty(RequiredType(actual, "GetterContract.Item"), "Value")
        Assert.Null(item.SetMethod)
        Assert.False(item.GetMethod!!.IsAbstract)
        Assert.Equal(
            RequiredProperty(RequiredType(expected, "GetterContract.Item"), "Value").GetMethod!!.Attributes,
            item.GetMethod!!.Attributes
        )
        Assert.Equal(17, RequiredType(expected, "GetterContract.Driver").GetMethod("Run")!!.Invoke(nil, nil))
        Assert.Equal(17, RequiredType(actual, "GetterContract.Driver").GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Fact
    func AbstractInitContract_ImplementationAndReferenceMetadataAgree() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "AbstractApi.ref.dll")
        let dll = fixture.Compile(`package AbstractApi
public abstract class Base[T] {
    public abstract prop Value T { get; init; }
}`, "AbstractApi", false, "/refout:" + reference)
        Verify(dll)
        for path in[]string{dll, reference} {
            using let stream = File.OpenRead(path)
            using let pe = PEReader(stream)
            let metadata = pe.GetMetadataReader()
            let owner = metadata.GetTypeDefinition(
                Assert.Single(
                    metadata.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> metadata.GetString(
                        metadata.GetTypeDefinition(handle).Name
                    ) == "Base`1"
                )
            )
            Assert.Empty(owner.GetFields())
            let property = metadata.GetPropertyDefinition(Assert.Single(owner.GetProperties()))
            let accessors = property.GetAccessors()
            for handle in[]MethodDefinitionHandle{accessors.Getter, accessors.Setter} {
                Assert.False(handle.IsNil)
                let method = metadata.GetMethodDefinition(handle)
                Assert.Equal(
                    MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot,
                    method.Attributes
                )
                Assert.Equal(0, method.RelativeVirtualAddress)
            }
            let setter = metadata.GetMethodDefinition(accessors.Setter)
            Assert.Equal("value", metadata.GetString(metadata.GetParameter(Assert.Single(setter.GetParameters())).Name))
            var signature = metadata.GetBlobReader(setter.Signature)
            Assert.Equal(0x20, int32(signature.ReadByte()))
            Assert.Equal(1, signature.ReadCompressedInteger())
            Assert.Equal(0x1f, int32(signature.ReadByte()))
            let codedType = signature.ReadCompressedInteger()
            Assert.Equal(1, codedType & 3)
            let modifier = metadata.GetTypeReference(MetadataTokens.TypeReferenceHandle(codedType >> 2))
            Assert.Equal("System.Runtime.CompilerServices", metadata.GetString(modifier.Namespace))
            Assert.Equal("IsExternalInit", metadata.GetString(modifier.Name))
            Assert.Equal(0x01, int32(signature.ReadByte()))
            this.LogProduct(path)
        }
    }

    @Theory
    @InlineData("get")
    @InlineData("set")
    @InlineData("init")
    func NativeAbstractIndexerDefaults_MatchRoslynAndDownstreamCalls(kind string) {
        let accessors = if kind == "get" {
            "get;"
        } else {
            "get; " + kind + ";"
        }
        const contractName = "OptionalAbstractIndexers"
        let contract = (`namespace ` + "$contractName" + ` {
    public abstract class Base {
        public abstract int this[int row, int column = 1] { ` + "$accessors" + ` }
    }
}`)
        let consumer = (`namespace ` + "$contractName" + ` {
    public sealed class Item : Base {
        private int value = 42;
        public override int this[int row, int column] {
            get { return value + row + column; }
            ` + "${(if kind == "get" { "" } else { kind + " { this.value = value; }" })}" + `
        }
    }
    public static class Driver {
        public static int Run() {
            Base item = new Item();
            ` + "${(if kind == "set" { "item[4] = 50;" } else { "" })}" + `
            return item[4];
        }
    }
}`)
        // The oracle is an untransformed Roslyn contract, not cs2gs output or
        // another G# product; the real gsc driver emits both implementation/ref PE.
        using let native = CSharpFixture(contract + consumer)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "OptionalAbstractIndexers.ref.dll")
        let dll = fixture.Compile((`package ` + "$contractName" + `
public abstract class Base {
    public abstract prop this[row int32, column int32 = 1] int32 { ` + "$accessors" + ` }
}`), contractName, false, "/refout:" + reference)
        this.LogProduct(native.AssemblyPath)
        Verify(native.AssemblyPath)
        Verify(dll)
        let expected = RequiredType(native.Load(), contractName + ".Base")
        AssertAbstractIndexerReflection(RequiredType(EmittedFixture.Load(dll), contractName + ".Base"), expected)
        for path in[]string{dll, reference} {
            this.LogProduct(path)
            AssertAbstractIndexerMetadata(path, expected)
        }
        let nativeRun MethodInfo? = RequiredType(native.Load(), contractName + ".Driver").GetMethod("Run")
        let result = if kind == "set" {
            55
        } else {
            47
        }
        Assert.Equal(result, nativeRun!!.Invoke(nil, nil))
        for path in[]string{dll, reference} {
            let caller = fixture.CompileCSharp(
                consumer,
                if path == dll {
                    "ImplementationCaller"
                } else {
                    "ReferenceCaller"
                },
                path
            )
            this.LogProduct(caller)
            Verify(caller, dll)
            let actual = EmittedFixture.LoadTogether(dll, caller)
            let actualRun MethodInfo? = RequiredType(actual[1], contractName + ".Driver").GetMethod("Run")
            Assert.Equal(result, actualRun!!.Invoke(nil, nil))
            if kind == "set" || kind == "init" {
                let item object? = Activator.CreateInstance(RequiredType(actual[1], contractName + ".Item"))
                let property = RequiredProperty(RequiredType(actual[0], contractName + ".Base"), "Item")
                property.SetMethod!!.Invoke(item, []object{4, Type.Missing, 60})
                Assert.Equal(65, property.GetMethod!!.Invoke(item, []object{4, Type.Missing}))
            }
        }
    }

    @Fact
    func AbstractNullableIndexerParameter_EmitsNullableAttributeInBothAssemblies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "NullableIndexer.ref.dll")
        let dll = fixture.Compile(`package NullableIndexer
public abstract class Base {
    public abstract prop this[
        @System.Runtime.CompilerServices.CallerMemberName key string? = ""
    ] int32 { get; }
    public abstract prop Value string? { get; init; }
}`, "NullableIndexer", false, "/refout:" + reference)
        for path in[]string{dll, reference} {
            using let pe = PEReader(File.OpenRead(path))
            let metadata = pe.GetMetadataReader()
            let owner = metadata.GetTypeDefinition(
                Assert.Single(
                    metadata.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> metadata.GetString(
                        metadata.GetTypeDefinition(handle).Name
                    ) == "Base"
                )
            )
            let getter = metadata.GetMethodDefinition(
                Assert.Single(
                    owner.GetMethods(),
                    (handle MethodDefinitionHandle) -> metadata.GetString(
                        metadata.GetMethodDefinition(handle).Name
                    ) == "get_Item"
                )
            )
            let parameter = metadata.GetParameter(
                Assert.Single(
                    getter.GetParameters(),
                    (handle ParameterHandle) -> metadata.GetString(metadata.GetParameter(handle).Name) == "key"
                )
            )
            Assert.Contains(
                parameter.GetCustomAttributes(),
                (handle CustomAttributeHandle) -> GetCustomAttributeTypeName(
                    metadata,
                    handle
                ) == "System.Runtime.CompilerServices.NullableAttribute"
            )
            Assert.Contains(
                parameter.GetCustomAttributes(),
                (handle CustomAttributeHandle) -> GetCustomAttributeTypeName(
                    metadata,
                    handle
                ) == "System.Runtime.CompilerServices.CallerMemberNameAttribute"
            )
            for accessorName in[]string{"get_Value", "set_Value"} {
                let accessor = metadata.GetMethodDefinition(
                    Assert.Single(
                        owner.GetMethods(),
                        (handle MethodDefinitionHandle) -> metadata.GetString(
                            metadata.GetMethodDefinition(handle).Name
                        ) == accessorName
                    )
                )
                let contractParameter = metadata.GetParameter(
                    Assert.Single(
                        accessor.GetParameters(),
                        (handle ParameterHandle) -> metadata.GetParameter(handle)
                            .SequenceNumber == (
                            if accessorName == "get_Value" {
                                0
                            } else {
                                1
                            }
                        )
                    )
                )
                Assert.Contains(
                    contractParameter.GetCustomAttributes(),
                    (handle CustomAttributeHandle) -> GetCustomAttributeTypeName(
                        metadata,
                        handle
                    ) == "System.Runtime.CompilerServices.NullableAttribute"
                )
            }
        }
    }

    @Fact
    func AbstractTupleIndexerParameter_EmitsTupleNamesInBothAssemblies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "TupleIndexer.ref.dll")
        let dll = fixture.Compile(`package TupleIndexer
public abstract class Base {
    public abstract prop this[position (row int32, column int32)] (value int32, valid bool) { get; set; }
}`, "TupleIndexer", false, "/refout:" + reference)
        for path in[]string{dll, reference} {
            using let pe = PEReader(File.OpenRead(path))
            let metadata = pe.GetMetadataReader()
            let owner = metadata.GetTypeDefinition(
                Assert.Single(
                    metadata.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> metadata.GetString(
                        metadata.GetTypeDefinition(handle).Name
                    ) == "Base"
                )
            )
            for accessorName in[]string{"get_Item", "set_Item"} {
                let accessor = metadata.GetMethodDefinition(
                    Assert.Single(
                        owner.GetMethods(),
                        (handle MethodDefinitionHandle) -> metadata.GetString(
                            metadata.GetMethodDefinition(handle).Name
                        ) == accessorName
                    )
                )
                let parameter = metadata.GetParameter(
                    Assert.Single(
                        accessor.GetParameters(),
                        (handle ParameterHandle) -> metadata.GetParameter(handle).SequenceNumber == 1
                    )
                )
                Assert.Contains(
                    parameter.GetCustomAttributes(),
                    (handle CustomAttributeHandle) -> GetCustomAttributeTypeName(
                        metadata,
                        handle
                    ) == "System.Runtime.CompilerServices.TupleElementNamesAttribute"
                )
                let contractParameter = metadata.GetParameter(
                    Assert.Single(
                        accessor.GetParameters(),
                        (handle ParameterHandle) -> metadata.GetParameter(handle)
                            .SequenceNumber == (
                            if accessorName == "get_Item" {
                                0
                            } else {
                                2
                            }
                        )
                    )
                )
                Assert.Contains(
                    contractParameter.GetCustomAttributes(),
                    (handle CustomAttributeHandle) -> GetCustomAttributeTypeName(
                        metadata,
                        handle
                    ) == "System.Runtime.CompilerServices.TupleElementNamesAttribute"
                )
            }
        }
    }

    @Theory
    @InlineData("class Missing : Base { }", "get_Value")
    @InlineData("open class Missing : Base { }", "get_Value")
    @InlineData("class Missing : Base { public prop Value int32 { get; set; } }", "get_Value")
    @InlineData("class Missing : Base { public override prop Value int32 -> 7 }", "set_Value")
    @InlineData(
        "abstract class Hidden : Base { public open prop Value int32 { get; set; } } class Missing : Hidden { public override prop Value int32 { get; set; } }",
        "get_Value"
    )
    func ConcreteDerivedMustImplementEveryRequiredAccessor(declaration string, accessor string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let result = fixture.TryCompile(
            "package MissingAccessor\nabstract class Base { public abstract prop Value int32 { get; set; } }" +
                declaration,
            "MissingAccessor",
            false
        )
        Assert.NotEqual(0, result.Code)
        Assert.Contains("GS0387", result.Output, StringComparison.Ordinal)
        Assert.Contains(accessor, result.Output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("class Invalid { public abstract prop Value int32 { get; set; } }")
    @InlineData("abstract class Invalid { public abstract prop Value int32 { get -> 7 } }")
    @InlineData("abstract class Invalid { public open abstract prop Value int32 { get; init; } }")
    @InlineData("abstract class Invalid { private abstract prop Value int32 { get; set; } }")
    @InlineData("abstract class Invalid { public abstract prop Value int32 }")
    @InlineData("shared class Invalid { public abstract prop Value int32 { get; set; } }")
    func InvalidAbstractDeclarations_AreLocatedDiagnostics(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let result = fixture.TryCompile("package InvalidAbstract\n" + declaration, "InvalidAbstract", false)
        Assert.NotEqual(0, result.Code)
        Assert.Contains("GS0620", result.Output, StringComparison.Ordinal)
        Assert.Contains("Value", result.Output, StringComparison.Ordinal)
    }

    @Fact
    func ConcreteOpenInitAutosInAbstractOwnersAndLegacyGetterContractsRemainUnchanged() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package AbstractControls
public abstract class Base { public open prop Value int32 { get; init; } }
public class Item : Base { public init() { this.Value = 9 } }
public open class Legacy { public open prop Name int32 { get; } }
public class LegacyItem : Legacy { public override prop Name int32 -> 7 }`, "AbstractControls", false)
        Verify(dll)
        let assembly = EmittedFixture.Load(dll)
        let property = RequiredProperty(RequiredType(assembly, "AbstractControls.Base"), "Value")
        Assert.False(property.GetMethod!!.IsAbstract)
        Assert.False(property.SetMethod!!.IsAbstract)
        Assert.NotNull(property.GetMethod!!.GetMethodBody())
        Assert.Single(
            RequiredType(assembly, "AbstractControls.Base").GetFields(
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
            )
        )
        Assert.True(RequiredProperty(RequiredType(assembly, "AbstractControls.Legacy"), "Name").GetMethod!!.IsAbstract)
        let item object? = Activator.CreateInstance(RequiredType(assembly, "AbstractControls.Item"))
        Assert.Equal(9, property.GetValue(item))
    }

    private func LogProduct(path string) -> this.output.WriteLine(
        "sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path
    )

    shared {
        private func AssertAbstractIndexerReflection(actual Type, expected Type) {
            Assert.True(actual.IsAbstract)
            Assert.Empty(
                actual.GetFields(
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
            )
            let expectedProperty = RequiredProperty(expected, "Item")
            let property = RequiredProperty(actual, "Item")
            Assert.Equal(expectedProperty.PropertyType, property.PropertyType)
            Assert.Equal(
                expectedProperty.GetIndexParameters().Select((parameter ParameterInfo) -> parameter.Name),
                property.GetIndexParameters().Select((parameter ParameterInfo) -> parameter.Name)
            )
            for expectedAccessor in expectedProperty.GetAccessors() {
                let accessor MethodInfo? = actual.GetMethod(expectedAccessor.Name)
                AssertAbstractAccessor(accessor, newSlot: true)
                Assert.Equal(expectedAccessor.ReturnType, accessor!!.ReturnType)
                Assert.Equal(
                    expectedAccessor.ReturnParameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName),
                    accessor!!.ReturnParameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName)
                )
                Assert.Equal(
                    expectedAccessor
                        .ReturnParameter
                        .GetCustomAttributesData()
                        .Select((attribute CustomAttributeData) -> attribute.AttributeType.FullName),
                    accessor!!
                        .ReturnParameter
                        .GetCustomAttributesData()
                        .Select((attribute CustomAttributeData) -> attribute.AttributeType.FullName)
                )
                let parameters = accessor!!.GetParameters()
                Assert.Equal(expectedAccessor.GetParameters().Length, parameters.Length)
                for pair in expectedAccessor.GetParameters().Zip(parameters) {
                    Assert.Equal(pair.First.Name, pair.Second.Name)
                    Assert.Equal(pair.First.ParameterType, pair.Second.ParameterType)
                    Assert.Equal(pair.First.Attributes, pair.Second.Attributes)
                    Assert.Equal(pair.First.RawDefaultValue, pair.Second.RawDefaultValue)
                }
                Assert.True(parameters[1].IsOptional)
                Assert.True(parameters[1].HasDefaultValue)
                Assert.Equal(1, parameters[1].RawDefaultValue)
            }
        }

        private func AssertAbstractIndexerMetadata(path string, expected Type) {
            using let pe = PEReader(File.OpenRead(path))
            let metadata = pe.GetMetadataReader()
            let owner = metadata.GetTypeDefinition(
                Assert.Single(
                    metadata.TypeDefinitions,
                    (handle TypeDefinitionHandle) -> metadata.GetString(
                        metadata.GetTypeDefinition(handle).Name
                    ) == "Base"
                )
            )
            let indexer = metadata.GetPropertyDefinition(Assert.Single(owner.GetProperties()))
            let handles = indexer.GetAccessors()
            for handle in[]MethodDefinitionHandle{handles.Getter, handles.Setter}.Where(
                (handle MethodDefinitionHandle) -> !handle.IsNil
            ) {
                let method = metadata.GetMethodDefinition(handle)
                Assert.Equal(0, method.RelativeVirtualAddress)
                let accessor MethodInfo? = expected.GetMethod(metadata.GetString(method.Name))
                Assert.Equal(accessor!!.Attributes, method.Attributes)
                var signature = metadata.GetBlobReader(method.Signature)
                Assert.Equal(0x20, int32(signature.ReadByte()))
                Assert.Equal(accessor!!.GetParameters().Length, signature.ReadCompressedInteger())
                if accessor!!.ReturnParameter.GetRequiredCustomModifiers().Length != 0 {
                    Assert.Equal(0x1f, int32(signature.ReadByte()))
                    let codedType = signature.ReadCompressedInteger()
                    Assert.Equal(1, codedType & 3)
                    let modifier = metadata.GetTypeReference(MetadataTokens.TypeReferenceHandle(codedType >> 2))
                    Assert.Equal("System.Runtime.CompilerServices", metadata.GetString(modifier.Namespace))
                    Assert.Equal("IsExternalInit", metadata.GetString(modifier.Name))
                }
                Assert.Equal(
                    if accessor!!.ReturnType == typeof(Void) {
                        0x01
                    } else {
                        0x08
                    },
                    int32(signature.ReadByte())
                )
                for parameter in accessor!!.GetParameters() {
                    Assert.Equal(0x08, int32(signature.ReadByte()))
                }
                Assert.Equal(0, signature.RemainingBytes)
                let rows = method.GetParameters().Select(metadata.GetParameter).ToArray()
                Assert.Equal(accessor!!.GetParameters().Length, rows.Length)
                Assert.Equal(
                    accessor!!.GetParameters().Select((parameter ParameterInfo) -> parameter.Position + 1),
                    rows.Select((parameter MetadataParameter) -> parameter.SequenceNumber)
                )
                Assert.Equal(
                    accessor!!.GetParameters().Select((parameter ParameterInfo) -> parameter.Name),
                    rows.Select((parameter MetadataParameter) -> metadata.GetString(parameter.Name))
                )
                Assert.Equal(
                    accessor!!.GetParameters().Select((parameter ParameterInfo) -> parameter.Attributes),
                    rows.Select((parameter MetadataParameter) -> parameter.Attributes)
                )
                let column = metadata.GetParameter(
                    Assert.Single(
                        method.GetParameters(),
                        (parameter ParameterHandle) -> metadata.GetParameter(parameter).SequenceNumber == 2
                    )
                )
                Assert.Equal("column", metadata.GetString(column.Name))
                Assert.Equal(ParameterAttributes.Optional | ParameterAttributes.HasDefault, column.Attributes)
                Assert.False(column.GetDefaultValue().IsNil)
                let constant = metadata.GetConstant(column.GetDefaultValue())
                Assert.Equal(ConstantTypeCode.Int32, constant.TypeCode)
                Assert.Equal(1, metadata.GetBlobReader(constant.Value).ReadInt32())
            }
        }

        private func RequiredType(assembly Assembly, name string) Type -> assembly.GetType(name) ??
            throw InvalidOperationException("Missing emitted type " + name)

        private func RequiredProperty(type Type, name string) PropertyInfo -> type.GetProperty(
            name,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
        ) ??
            throw InvalidOperationException("Missing emitted property " + name)

        private func Run(assembly Assembly) object? -> RequiredType(assembly, "AbstractProperties.Driver").GetMethod(
            "Run"
        )!!.Invoke(nil, nil)

        private func CompareContract(original Type, actual Type, name string, init bool) {
            let expected = RequiredProperty(original, name)
            let property = RequiredProperty(actual, name)
            Assert.True(actual.IsAbstract)
            Assert.Equal(expected.PropertyType.IsGenericParameter, property.PropertyType.IsGenericParameter)
            for getter in[]bool{true, false} {
                let accessor MethodInfo? = if getter {
                    property.GetMethod
                } else {
                    property.SetMethod
                }
                let reference MethodInfo? = if getter {
                    expected.GetMethod
                } else {
                    expected.SetMethod
                }
                AssertAbstractAccessor(accessor, newSlot: true)
                Assert.Equal(reference!!.Attributes, accessor!!.Attributes)
                Assert.Equal(
                    reference!!.ReturnParameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName),
                    accessor!!.ReturnParameter.GetRequiredCustomModifiers().Select((type Type) -> type.FullName)
                )
            }
            Assert.Equal(
                init,
                property.SetMethod!!
                    .ReturnParameter
                    .GetRequiredCustomModifiers()
                    .Any((type Type) -> type.FullName == "System.Runtime.CompilerServices.IsExternalInit")
            )
        }

        private func AssertAbstractAccessor(accessor MethodInfo?, newSlot bool) {
            Assert.NotNull(accessor)
            Assert.True(accessor!!.IsAbstract)
            Assert.True(accessor!!.IsVirtual)
            Assert.False(accessor!!.IsFinal)
            Assert.True(accessor!!.IsPublic)
            Assert.True(accessor!!.IsSpecialName)
            Assert.Equal(newSlot, (accessor!!.Attributes & MethodAttributes.NewSlot) != 0)
            Assert.Null(accessor!!.GetMethodBody())
        }

        private func ReadCovariantAbstractGetterShape(path string)(
            Attributes MethodAttributes,
            HasBody bool,
            MethodImplCount int32,
            DeclarationName string
        ) {
            using let pe = PEReader(File.OpenRead(path))
            let metadata = pe.GetMetadataReader()
            let ownerHandle = Assert.Single(
                metadata.TypeDefinitions,
                (handle TypeDefinitionHandle) -> metadata.GetString(metadata.GetTypeDefinition(handle).Name) == "Middle"
            )
            let owner = metadata.GetTypeDefinition(ownerHandle)
            let getterHandle = Assert.Single(
                owner.GetMethods(),
                (handle MethodDefinitionHandle) -> metadata.GetString(
                    metadata.GetMethodDefinition(handle).Name
                ) == "get_Item"
            )
            let getter = metadata.GetMethodDefinition(getterHandle)
            let implementation = Assert.Single(
                owner.GetMethodImplementations(),
                (handle MethodImplementationHandle) -> metadata.GetMethodImplementation(handle)
                    .MethodBody == getterHandle
            )
            let declaration = metadata.GetMethodImplementation(implementation).MethodDeclaration
            let declarationName = switch declaration.Kind {
                case HandleKind.MethodDefinition: metadata.GetString(
                    metadata.GetMethodDefinition(MethodDefinitionHandle(declaration)).Name
                )
                case HandleKind.MemberReference: metadata.GetString(
                    metadata.GetMemberReference(MemberReferenceHandle(declaration)).Name
                )
                default: throw InvalidOperationException(
                    "Unexpected covariant property declaration handle " + declaration.Kind.ToString()
                )
            }
            return (getter.Attributes, getter.RelativeVirtualAddress != 0, 1, declarationName)
        }

        private func AssertCovariantSlotShape(
            expected(Attributes MethodAttributes, HasBody bool, MethodImplCount int32, DeclarationName string),
            actual(Attributes MethodAttributes, HasBody bool, MethodImplCount int32, DeclarationName string)
        ) {
            Assert.Equal(expected.Attributes, actual.Attributes)
            Assert.Equal(expected.MethodImplCount, actual.MethodImplCount)
            Assert.Equal(expected.DeclarationName, actual.DeclarationName)
        }

        private func GetCustomAttributeTypeName(metadata MetadataReader, handle CustomAttributeHandle) string {
            let constructor = metadata.GetCustomAttribute(handle).Constructor
            let owner = switch constructor.Kind {
                case HandleKind.MemberReference: metadata.GetMemberReference(MemberReferenceHandle(constructor)).Parent
                case HandleKind.MethodDefinition: EntityHandle(
                    metadata.GetMethodDefinition(MethodDefinitionHandle(constructor)).GetDeclaringType()
                )
                default: default(EntityHandle)
            }
            return switch owner.Kind {
                case HandleKind.TypeReference: metadata.GetString(
                    metadata.GetTypeReference(TypeReferenceHandle(owner)).Namespace
                ) +
                    "." +
                    metadata.GetString(metadata.GetTypeReference(TypeReferenceHandle(owner)).Name)
                case HandleKind.TypeDefinition: metadata.GetString(
                    metadata.GetTypeDefinition(TypeDefinitionHandle(owner)).Namespace
                ) +
                    "." +
                    metadata.GetString(metadata.GetTypeDefinition(TypeDefinitionHandle(owner)).Name)
                default: string.Empty
            }
        }

        private func Verify(dll string, references ...string) {
            Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"))
            IlVerifier.Verify(dll, references)
        }
    }
}
