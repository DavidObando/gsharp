// <copyright file="Issue4765AbstractPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.Tests;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4765AbstractPropertyEmitTests
{
    private readonly ITestOutputHelper output;

    public Issue4765AbstractPropertyEmitTests(ITestOutputHelper output) => this.output = output;

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(true, true, true)]
    public void TranslatedAbstractContracts_MatchRoslynMetadataDispatchAndCopy(bool record, bool generic, bool partial)
    {
        var name = partial ? "package" : "Value";
        var parameterType = generic ? "T" : "int";
        var baseUse = generic ? "R<int>" : "R";
        var kind = record ? "record" : "class";
        var source = $$"""
            namespace AbstractProperties {
                public static class Counter {
                    public static int Calls;
                    public static int Next() => ++Calls;
                }
                public abstract {{(partial ? "partial " : "")}}{{kind}} R{{(generic ? "<T>" : "")}}{{(record && !partial ? "(" + parameterType + " " + name + ")" : "")}} {
                    public abstract {{parameterType}} {{name}} { get; {{(record ? "init" : "set")}}; }
                }
                public sealed {{kind}} Item : {{baseUse}}, Foreign.Readable {
                    public override int {{name}} { get; {{(record ? "init" : "set")}}; } = Counter.Next();
                    private int stamp = Counter.Next();
                    public int Stamp => stamp;
                    public Item(int value){{(record ? ": base(value)" : "")}} { }
                }
                public static class Driver {
                    public static string Run() {
                        {{baseUse}} root = new Item(7);
                        {{(record ? "var copy = ((Item)root) with { " + name + " = Counter.Next() }; return root." + name + " + \",\" + copy." + name + " + \",\" + ((Item)root).Stamp + \",\" + copy.Stamp + \",\" + Counter.Calls;" : "root." + name + " = Counter.Next(); return root." + name + " + \",\" + ((Item)root).Stamp + \",\" + Counter.Calls;")}}
                    }
                }
            }
            """;
        var sources = partial && record
            ? new[]
            {
                ("Header.cs", $$"""
                    namespace AbstractProperties {
                        public abstract partial record R{{(generic ? "<T>" : "")}}({{parameterType}} {{name}});
                    }
                    """),
                ("Body.cs", source),
            }
            : new[] { ("Body.cs", source) };
        using var nativeContract = new CSharpFixture("namespace Foreign { public interface Readable { int Stamp { get; } } }");
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(nativeContract.AssemblyPath)).ToArray();
        var compilation = CSharpCompilation.Create(
            "RoslynBaseline",
            sources.Select(sourceFile => CSharpSyntaxTree.ParseText(sourceFile.Item2, path: sourceFile.Item1)),
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.DoesNotContain(compilation.GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var baselinePath = Path.Combine(fixture.Directory, "RoslynBaseline.dll");
        using (var stream = File.Create(baselinePath))
        {
            var emitted = compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics));
        }

        var translatedFiles = compilation.SyntaxTrees.Select(tree =>
        {
            var document = new LoadedDocument(tree.FilePath, tree, compilation.GetSemanticModel(tree));
            var context = new TranslationContext(compilation, document.SemanticModel, document.FilePath);
            var text = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            return text;
        }).ToArray();
        var translated = string.Join("\n", translatedFiles);
        this.output.WriteLine(translated);
        Assert.Contains("abstract prop ", translated, StringComparison.Ordinal);
        var extraSources = translatedFiles.Skip(1).Select((text, index) =>
        {
            var path = Path.Combine(fixture.Directory, "Part" + index + ".gs");
            File.WriteAllText(path, text);
            return path;
        }).ToArray();
        var dll = fixture.Compile(translatedFiles[0], "TranslatedAbstractProperties", false,
            new[] { "/r:" + nativeContract.AssemblyPath }.Concat(extraSources).ToArray());
        this.LogProduct(baselinePath);
        this.LogProduct(dll);
        Verify(dll, nativeContract.AssemblyPath);
        Verify(baselinePath, nativeContract.AssemblyPath);
        var baseline = EmittedFixture.LoadTogether(nativeContract.AssemblyPath, baselinePath)[1];
        var actual = EmittedFixture.LoadTogether(nativeContract.AssemblyPath, dll)[1];
        var originalBase = RequiredType(baseline, "AbstractProperties.R" + (generic ? "`1" : ""));
        var actualBase = RequiredType(actual, "AbstractProperties.R" + (generic ? "`1" : ""));
        Assert.Empty(actualBase.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly));
        CompareContract(originalBase, actualBase, name, init: record);
        var actualItem = RequiredType(actual, "AbstractProperties.Item");
        var itemProperty = RequiredProperty(actualItem, name);
        Assert.False(itemProperty.GetMethod.IsAbstract);
        Assert.False(itemProperty.SetMethod.IsAbstract);
        Assert.Equal(record, itemProperty.SetMethod.ReturnParameter.GetRequiredCustomModifiers().Any(type => type.FullName == "System.Runtime.CompilerServices.IsExternalInit"));
        Assert.Contains(actualItem.GetFields(BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly), field => field.FieldType == typeof(int));
        var expected = record ? "1,3,2,2,3" : "3,2,3";
        Assert.Equal(expected, Run(baseline));
        Assert.Equal(expected, Run(actual));
    }

    [Theory]
    [InlineData("set")]
    [InlineData("init")]
    public void NativeExplicitAbstractAndReabstractProperties_AreStorageFree(string write)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile($$"""
            package NativeAbstract
            public abstract class Base {
                public abstract prop Value int32 { get; {{write}}; }
            }
            public abstract class Retained : Base { }
            public abstract class Middle : Retained {
                public abstract override prop Value int32 { get; {{write}}; }
            }
            public class Item : Middle {
                public override prop Value int32 { get; {{write}}; }
                public init(value int32) { this.Value = value }
            }
            public class Driver {
                shared {
                    public func Run() int32 {
                        let item Base = Item(7)
                        return item.Value
                    }
                }
            }
            """, "NativeAbstract", false);
        this.LogProduct(dll);
        Verify(dll);
        var assembly = EmittedFixture.Load(dll);
        var parent = RequiredType(assembly, "NativeAbstract.Base");
        var middle = RequiredType(assembly, "NativeAbstract.Middle");
        Assert.Empty(parent.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly));
        Assert.Empty(middle.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly));
        foreach (var type in new[] { parent, middle })
        {
            var property = RequiredProperty(type, "Value");
            AssertAbstractAccessor(property.GetMethod, newSlot: type == parent);
            AssertAbstractAccessor(property.SetMethod, newSlot: type == parent);
            Assert.Equal(write == "init", property.SetMethod.ReturnParameter.GetRequiredCustomModifiers().Any(modifier => modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit"));
        }

        Assert.Equal(7, RequiredType(assembly, "NativeAbstract.Driver").GetMethod("Run").Invoke(null, null));
    }

    [Fact]
    public void CovariantReabstractGetter_MatchesRoslynInImplementationAndReferenceMetadata()
    {
        const string nativeSource = """
            namespace CovariantAbstract {
                public class Value { }
                public class NarrowValue : Value { }
                public abstract class Base { public abstract Value Item { get; } }
                public abstract class Middle : Base { public abstract override NarrowValue Item { get; } }
            }
            """;
        using var native = new CSharpFixture(nativeSource);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "CovariantAbstract.ref.dll");
        var dll = fixture.Compile("""
            package CovariantAbstract
            public open class Value { }
            public class NarrowValue : Value { }
            public abstract class Base { public abstract prop Item Value { get; } }
            public abstract class Middle : Base { public abstract override prop Item NarrowValue { get; } }
            """, "CovariantAbstract", false, "/refout:" + reference);

        Verify(native.AssemblyPath);
        Verify(dll);
        var expected = ReadCovariantAbstractGetterShape(native.AssemblyPath);
        Assert.True((expected.Attributes & MethodAttributes.NewSlot) != 0);
        foreach (var path in new[] { dll, reference })
        {
            this.LogProduct(path);
            Assert.Equal(expected, ReadCovariantAbstractGetterShape(path));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedCovariantGetter_MatchesReferencedRoslynContract(bool reabstract)
    {
        using var contract = new CSharpFixture("""
            namespace ImportedCovariant {
                public abstract class Base { public abstract object Item { get; } }
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var references = ReferenceResolver.HostTrustedPlatformAssemblyPaths()
            .Select(path => MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(contract.AssemblyPath));
        var compilation = CSharpCompilation.Create(
            "ImportedCovariantRoslyn",
            new[] { CSharpSyntaxTree.ParseText(reabstract
                ? """
                    namespace ImportedCovariant {
                        public abstract class Middle : Base {
                            public abstract override string Item { get; }
                        }
                    }
                    """
                : """
                    namespace ImportedCovariant {
                        public class Middle : Base {
                            public override string Item => "x";
                        }
                    }
                    """) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var expected = Path.Combine(fixture.Directory, "ImportedCovariantRoslyn.dll");
        using (var stream = File.Create(expected))
        {
            var emitted = compilation.Emit(stream);
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics));
        }

        var expectedReference = Path.Combine(fixture.Directory, "ImportedCovariantRoslyn.ref.dll");
        using (var stream = File.Create(expectedReference))
        {
            var emitted = compilation.Emit(
                stream,
                options: new Microsoft.CodeAnalysis.Emit.EmitOptions(metadataOnly: true));
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics));
        }

        var reference = Path.Combine(fixture.Directory, "ImportedCovariant.ref.dll");
        var dll = fixture.Compile(reabstract
            ? """
                package ImportedCovariant
                public abstract class Middle : Base {
                    public abstract override prop Item string { get; }
                }
                """
            : """
                package ImportedCovariant
                public class Middle : Base {
                    public override prop Item string -> "x"
                }
                """, "ImportedCovariant", false, "/r:" + contract.AssemblyPath, "/refout:" + reference);

        Verify(expected, contract.AssemblyPath);
        Verify(dll, contract.AssemblyPath);
        var expectedShape = ReadCovariantAbstractGetterShape(expected);
        var expectedReferenceShape = ReadCovariantAbstractGetterShape(expectedReference);
        Assert.True((expectedShape.Attributes & MethodAttributes.NewSlot) != 0);
        this.LogProduct(dll);
        this.LogProduct(reference);
        var actualShape = ReadCovariantAbstractGetterShape(dll);
        var actualReferenceShape = ReadCovariantAbstractGetterShape(reference);
        AssertCovariantSlotShape(expectedShape, actualShape);
        AssertCovariantSlotShape(expectedReferenceShape, actualReferenceShape);
        Assert.Equal(!reabstract, actualShape.HasBody);
        Assert.False(actualReferenceShape.HasBody);
    }

    [Fact]
    public void InheritedGenericOverrideDischargesTheOriginalAccessorSlots()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package GenericAbstract
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
            }
            """, "GenericAbstract", false);
        this.LogProduct(dll);
        Verify(dll);
        var assembly = EmittedFixture.Load(dll);
        Assert.False(RequiredType(assembly, "GenericAbstract.Middle`1").IsAbstract);
        Assert.False(RequiredType(assembly, "GenericAbstract.Item").IsAbstract);
        Assert.Equal(13, RequiredType(assembly, "GenericAbstract.Driver").GetMethod("Run").Invoke(null, null));
    }

    [Fact]
    public void ExplicitReabstractOverridePreservesRoslynImportedSlotsAndProtectedInit()
    {
        using var native = new CSharpFixture("""
            namespace ImportedContracts {
                public abstract class Contract<T> {
                    public abstract T Value { get; protected init; }
                }
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package ImportedAbstract
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
            }
            """, "ImportedAbstract", false, "/r:" + native.AssemblyPath);
        this.LogProduct(native.AssemblyPath);
        this.LogProduct(dll);
        Verify(native.AssemblyPath);
        Verify(dll, native.AssemblyPath);
        var assembly = EmittedFixture.LoadTogether(native.AssemblyPath, dll)[1];
        var bridge = RequiredType(assembly, "ImportedAbstract.Bridge");
        Assert.Empty(bridge.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
        var property = RequiredProperty(bridge, "Value");
        AssertAbstractAccessor(property.GetMethod, newSlot: false);
        Assert.True(property.SetMethod.IsFamily);
        Assert.True(property.SetMethod.IsAbstract);
        Assert.False((property.SetMethod.Attributes & MethodAttributes.NewSlot) != 0);
        Assert.Equal("value", Assert.Single(property.SetMethod.GetParameters()).Name);
        Assert.Equal("System.Runtime.CompilerServices.IsExternalInit", Assert.Single(property.SetMethod.ReturnParameter.GetRequiredCustomModifiers()).FullName);
        Assert.Equal(11, RequiredType(assembly, "ImportedAbstract.Driver").GetMethod("Run").Invoke(null, null));
    }

    [Fact]
    public void RoslynGetterOnlyContractAndInitializedOverrideStayGetterOnly()
    {
        const string source = """
            namespace GetterContract {
                public abstract class Base { public abstract int Value { get; } }
                public sealed class Item : Base {
                    public override int Value { get; } = 17;
                }
                public static class Driver { public static int Run() { Base value = new Item(); return value.Value; } }
            }
            """;
        using var reference = new CSharpFixture(source);
        var compilation = CSharpCompilation.Create(
            "GetterBaseline",
            new[] { CSharpSyntaxTree.ParseText(source) },
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var tree = Assert.Single(compilation.SyntaxTrees);
        var document = new LoadedDocument("Getter.cs", tree, compilation.GetSemanticModel(tree));
        var context = new TranslationContext(compilation, document.SemanticModel, document.FilePath);
        var translated = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(translated, "GetterContract", false, "/r:" + reference.AssemblyPath);
        this.LogProduct(reference.AssemblyPath);
        this.LogProduct(dll);
        Verify(dll, reference.AssemblyPath);
        var expected = reference.Load();
        var actual = EmittedFixture.Load(dll);
        var contract = RequiredProperty(RequiredType(actual, "GetterContract.Base"), "Value");
        AssertAbstractAccessor(contract.GetMethod, newSlot: true);
        Assert.Null(contract.SetMethod);
        Assert.Empty(RequiredType(actual, "GetterContract.Base").GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.DeclaredOnly));
        var item = RequiredProperty(RequiredType(actual, "GetterContract.Item"), "Value");
        Assert.Null(item.SetMethod);
        Assert.False(item.GetMethod.IsAbstract);
        Assert.Equal(RequiredProperty(RequiredType(expected, "GetterContract.Item"), "Value").GetMethod.Attributes, item.GetMethod.Attributes);
        Assert.Equal(17, RequiredType(expected, "GetterContract.Driver").GetMethod("Run").Invoke(null, null));
        Assert.Equal(17, RequiredType(actual, "GetterContract.Driver").GetMethod("Run").Invoke(null, null));
    }

    [Fact]
    public void AbstractInitContract_ImplementationAndReferenceMetadataAgree()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "AbstractApi.ref.dll");
        var dll = fixture.Compile("""
            package AbstractApi
            public abstract class Base[T] {
                public abstract prop Value T { get; init; }
            }
            """, "AbstractApi", false, "/refout:" + reference);
        Verify(dll);
        foreach (var path in new[] { dll, reference })
        {
            using var stream = File.OpenRead(path);
            using var pe = new PEReader(stream);
            var metadata = pe.GetMetadataReader();
            var owner = metadata.GetTypeDefinition(Assert.Single(metadata.TypeDefinitions,
                handle => metadata.GetString(metadata.GetTypeDefinition(handle).Name) == "Base`1"));
            Assert.Empty(owner.GetFields());
            var property = metadata.GetPropertyDefinition(Assert.Single(owner.GetProperties()));
            var accessors = property.GetAccessors();
            foreach (var handle in new[] { accessors.Getter, accessors.Setter })
            {
                Assert.False(handle.IsNil);
                var method = metadata.GetMethodDefinition(handle);
                Assert.Equal(MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig
                    | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot, method.Attributes);
                Assert.Equal(0, method.RelativeVirtualAddress);
            }

            var setter = metadata.GetMethodDefinition(accessors.Setter);
            Assert.Equal("value", metadata.GetString(metadata.GetParameter(Assert.Single(setter.GetParameters())).Name));
            var signature = metadata.GetBlobReader(setter.Signature);
            Assert.Equal(0x20, signature.ReadByte());
            Assert.Equal(1, signature.ReadCompressedInteger());
            Assert.Equal(0x1f, signature.ReadByte());
            var codedType = signature.ReadCompressedInteger();
            Assert.Equal(1, codedType & 3);
            var modifier = metadata.GetTypeReference(MetadataTokens.TypeReferenceHandle(codedType >> 2));
            Assert.Equal("System.Runtime.CompilerServices", metadata.GetString(modifier.Namespace));
            Assert.Equal("IsExternalInit", metadata.GetString(modifier.Name));
            Assert.Equal(0x01, signature.ReadByte());
            this.LogProduct(path);
        }
    }

    [Theory]
    [InlineData("get")]
    [InlineData("set")]
    [InlineData("init")]
    public void NativeAbstractIndexerDefaults_MatchRoslynAndDownstreamCalls(string kind)
    {
        var accessors = kind == "get" ? "get;" : "get; " + kind + ";";
        const string contractName = "OptionalAbstractIndexers";
        var contract = $$"""
            namespace {{contractName}} {
                public abstract class Base {
                    public abstract int this[int row, int column = 1] { {{accessors}} }
                }
            }
            """;
        var consumer = $$"""
            namespace {{contractName}} {
                public sealed class Item : Base {
                    private int value = 42;
                    public override int this[int row, int column] {
                        get { return value + row + column; }
                        {{(kind == "get" ? "" : kind + " { this.value = value; }")}}
                    }
                }
                public static class Driver {
                    public static int Run() {
                        Base item = new Item();
                        {{(kind == "set" ? "item[4] = 50;" : "")}}
                        return item[4];
                    }
                }
            }
            """;

        // The oracle is an untransformed Roslyn contract, not cs2gs output or
        // another G# product; the real gsc driver emits both implementation/ref PE.
        using var native = new CSharpFixture(contract + consumer);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "OptionalAbstractIndexers.ref.dll");
        var dll = fixture.Compile($$"""
            package {{contractName}}
            public abstract class Base {
                public abstract prop this[row int32, column int32 = 1] int32 { {{accessors}} }
            }
            """, contractName, false, "/refout:" + reference);
        this.LogProduct(native.AssemblyPath);
        Verify(native.AssemblyPath);
        Verify(dll);
        var expected = RequiredType(native.Load(), contractName + ".Base");
        AssertAbstractIndexerReflection(RequiredType(EmittedFixture.Load(dll), contractName + ".Base"), expected);
        foreach (var path in new[] { dll, reference })
        {
            this.LogProduct(path);
            AssertAbstractIndexerMetadata(path, expected);
        }

        var nativeRun = RequiredType(native.Load(), contractName + ".Driver").GetMethod("Run");
        var result = kind == "set" ? 55 : 47;
        Assert.Equal(result, nativeRun.Invoke(null, null));
        foreach (var path in new[] { dll, reference })
        {
            var caller = fixture.CompileCSharp(consumer, path == dll ? "ImplementationCaller" : "ReferenceCaller", path);
            this.LogProduct(caller);
            Verify(caller, dll);
            var actual = EmittedFixture.LoadTogether(dll, caller);
            var actualRun = RequiredType(actual[1], contractName + ".Driver").GetMethod("Run");
            Assert.Equal(result, actualRun.Invoke(null, null));

            if (kind is "set" or "init")
            {
                var item = Activator.CreateInstance(RequiredType(actual[1], contractName + ".Item"));
                var property = RequiredProperty(RequiredType(actual[0], contractName + ".Base"), "Item");
                property.SetMethod.Invoke(item, new object[] { 4, Type.Missing, 60 });
                Assert.Equal(65, property.GetMethod.Invoke(item, new object[] { 4, Type.Missing }));
            }
        }
    }

    [Fact]
    public void AbstractNullableIndexerParameter_EmitsNullableAttributeInBothAssemblies()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "NullableIndexer.ref.dll");
        var dll = fixture.Compile("""
            package NullableIndexer
            public abstract class Base {
                public abstract prop this[key string?] int32 { get; }
            }
            """, "NullableIndexer", false, "/refout:" + reference);

        foreach (var path in new[] { dll, reference })
        {
            using var pe = new PEReader(File.OpenRead(path));
            var metadata = pe.GetMetadataReader();
            var owner = metadata.GetTypeDefinition(Assert.Single(
                metadata.TypeDefinitions,
                handle => metadata.GetString(metadata.GetTypeDefinition(handle).Name) == "Base"));
            var getter = metadata.GetMethodDefinition(Assert.Single(
                owner.GetMethods(),
                handle => metadata.GetString(metadata.GetMethodDefinition(handle).Name) == "get_Item"));
            var parameter = metadata.GetParameter(Assert.Single(
                getter.GetParameters(),
                handle => metadata.GetString(metadata.GetParameter(handle).Name) == "key"));
            Assert.Contains(
                parameter.GetCustomAttributes(),
                handle => GetCustomAttributeTypeName(metadata, handle) == "System.Runtime.CompilerServices.NullableAttribute");
        }
    }

    private static void AssertAbstractIndexerReflection(Type actual, Type expected)
    {
        Assert.True(actual.IsAbstract);
        Assert.Empty(actual.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
        var expectedProperty = RequiredProperty(expected, "Item");
        var property = RequiredProperty(actual, "Item");
        Assert.Equal(expectedProperty.PropertyType, property.PropertyType);
        Assert.Equal(expectedProperty.GetIndexParameters().Select(parameter => parameter.Name),
            property.GetIndexParameters().Select(parameter => parameter.Name));
        foreach (var expectedAccessor in expectedProperty.GetAccessors())
        {
            var accessor = actual.GetMethod(expectedAccessor.Name);
            AssertAbstractAccessor(accessor, newSlot: true);
            Assert.Equal(expectedAccessor.ReturnType, accessor.ReturnType);
            Assert.Equal(expectedAccessor.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName),
                accessor.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName));
            Assert.Equal(expectedAccessor.ReturnParameter.GetCustomAttributesData().Select(attribute => attribute.AttributeType.FullName),
                accessor.ReturnParameter.GetCustomAttributesData().Select(attribute => attribute.AttributeType.FullName));
            var parameters = accessor.GetParameters();
            Assert.Equal(expectedAccessor.GetParameters().Length, parameters.Length);
            foreach (var pair in expectedAccessor.GetParameters().Zip(parameters))
            {
                Assert.Equal(pair.First.Name, pair.Second.Name);
                Assert.Equal(pair.First.ParameterType, pair.Second.ParameterType);
                Assert.Equal(pair.First.Attributes, pair.Second.Attributes);
                Assert.Equal(pair.First.RawDefaultValue, pair.Second.RawDefaultValue);
            }

            Assert.True(parameters[1].IsOptional);
            Assert.True(parameters[1].HasDefaultValue);
            Assert.Equal(1, parameters[1].RawDefaultValue);
        }
    }

    private static void AssertAbstractIndexerMetadata(string path, Type expected)
    {
        using var pe = new PEReader(File.OpenRead(path));
        var metadata = pe.GetMetadataReader();
        var owner = metadata.GetTypeDefinition(Assert.Single(metadata.TypeDefinitions,
            handle => metadata.GetString(metadata.GetTypeDefinition(handle).Name) == "Base"));
        var indexer = metadata.GetPropertyDefinition(Assert.Single(owner.GetProperties()));
        var handles = indexer.GetAccessors();
        foreach (var handle in new[] { handles.Getter, handles.Setter }.Where(handle => !handle.IsNil))
        {
            var method = metadata.GetMethodDefinition(handle);
            Assert.Equal(0, method.RelativeVirtualAddress);
            var accessor = expected.GetMethod(metadata.GetString(method.Name));
            Assert.Equal(accessor.Attributes, method.Attributes);
            var signature = metadata.GetBlobReader(method.Signature);
            Assert.Equal(0x20, signature.ReadByte());
            Assert.Equal(accessor.GetParameters().Length, signature.ReadCompressedInteger());
            if (accessor.ReturnParameter.GetRequiredCustomModifiers().Length != 0)
            {
                Assert.Equal(0x1f, signature.ReadByte());
                var codedType = signature.ReadCompressedInteger();
                Assert.Equal(1, codedType & 3);
                var modifier = metadata.GetTypeReference(MetadataTokens.TypeReferenceHandle(codedType >> 2));
                Assert.Equal("System.Runtime.CompilerServices", metadata.GetString(modifier.Namespace));
                Assert.Equal("IsExternalInit", metadata.GetString(modifier.Name));
            }

            Assert.Equal(accessor.ReturnType == typeof(void) ? 0x01 : 0x08, signature.ReadByte());
            foreach (var parameter in accessor.GetParameters())
            {
                Assert.Equal(0x08, signature.ReadByte());
            }

            Assert.Equal(0, signature.RemainingBytes);
            var rows = method.GetParameters().Select(metadata.GetParameter).ToArray();
            Assert.Equal(accessor.GetParameters().Length, rows.Length);
            Assert.Equal(accessor.GetParameters().Select(parameter => parameter.Position + 1), rows.Select(parameter => parameter.SequenceNumber));
            Assert.Equal(accessor.GetParameters().Select(parameter => parameter.Name), rows.Select(parameter => metadata.GetString(parameter.Name)));
            Assert.Equal(accessor.GetParameters().Select(parameter => parameter.Attributes), rows.Select(parameter => parameter.Attributes));
            var column = metadata.GetParameter(Assert.Single(method.GetParameters(),
                parameter => metadata.GetParameter(parameter).SequenceNumber == 2));
            Assert.Equal("column", metadata.GetString(column.Name));
            Assert.Equal(ParameterAttributes.Optional | ParameterAttributes.HasDefault, column.Attributes);
            Assert.False(column.GetDefaultValue().IsNil);
            var constant = metadata.GetConstant(column.GetDefaultValue());
            Assert.Equal(ConstantTypeCode.Int32, constant.TypeCode);
            Assert.Equal(1, metadata.GetBlobReader(constant.Value).ReadInt32());
        }
    }

    [Theory]
    [InlineData("class Missing : Base { }", "get_Value")]
    [InlineData("open class Missing : Base { }", "get_Value")]
    [InlineData("class Missing : Base { public prop Value int32 { get; set; } }", "get_Value")]
    [InlineData("class Missing : Base { public override prop Value int32 -> 7 }", "set_Value")]
    [InlineData("abstract class Hidden : Base { public open prop Value int32 { get; set; } } class Missing : Hidden { public override prop Value int32 { get; set; } }", "get_Value")]
    public void ConcreteDerivedMustImplementEveryRequiredAccessor(string declaration, string accessor)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var result = fixture.TryCompile("""
            package MissingAccessor
            abstract class Base { public abstract prop Value int32 { get; set; } }
            """ + declaration, "MissingAccessor", false);
        Assert.NotEqual(0, result.Code);
        Assert.Contains("GS0387", result.Output, StringComparison.Ordinal);
        Assert.Contains(accessor, result.Output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("class Invalid { public abstract prop Value int32 { get; set; } }")]
    [InlineData("abstract class Invalid { public abstract prop Value int32 { get -> 7 } }")]
    [InlineData("abstract class Invalid { public open abstract prop Value int32 { get; init; } }")]
    [InlineData("abstract class Invalid { private abstract prop Value int32 { get; set; } }")]
    [InlineData("abstract class Invalid { public abstract prop Value int32 }")]
    [InlineData("shared class Invalid { public abstract prop Value int32 { get; set; } }")]
    public void InvalidAbstractDeclarations_AreLocatedDiagnostics(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var result = fixture.TryCompile("package InvalidAbstract\n" + declaration, "InvalidAbstract", false);
        Assert.NotEqual(0, result.Code);
        Assert.Contains("GS0620", result.Output, StringComparison.Ordinal);
        Assert.Contains("Value", result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public void ConcreteOpenInitAutosInAbstractOwnersAndLegacyGetterContractsRemainUnchanged()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile("""
            package AbstractControls
            public abstract class Base { public open prop Value int32 { get; init; } }
            public class Item : Base { public init() { this.Value = 9 } }
            public open class Legacy { public open prop Name int32 { get; } }
            public class LegacyItem : Legacy { public override prop Name int32 -> 7 }
            """, "AbstractControls", false);
        Verify(dll);
        var assembly = EmittedFixture.Load(dll);
        var property = RequiredProperty(RequiredType(assembly, "AbstractControls.Base"), "Value");
        Assert.False(property.GetMethod.IsAbstract);
        Assert.False(property.SetMethod.IsAbstract);
        Assert.NotNull(property.GetMethod.GetMethodBody());
        Assert.Single(RequiredType(assembly, "AbstractControls.Base").GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly));
        Assert.True(RequiredProperty(RequiredType(assembly, "AbstractControls.Legacy"), "Name").GetMethod.IsAbstract);
        var item = Activator.CreateInstance(RequiredType(assembly, "AbstractControls.Item"));
        Assert.Equal(9, property.GetValue(item));
    }

    private static Type RequiredType(Assembly assembly, string name)
        => assembly.GetType(name) ?? throw new InvalidOperationException("Missing emitted type " + name);

    private static PropertyInfo RequiredProperty(Type type, string name)
        => type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            ?? throw new InvalidOperationException("Missing emitted property " + name);

    private static object Run(Assembly assembly)
        => RequiredType(assembly, "AbstractProperties.Driver").GetMethod("Run").Invoke(null, null);

    private static void CompareContract(Type original, Type actual, string name, bool init)
    {
        var expected = RequiredProperty(original, name);
        var property = RequiredProperty(actual, name);
        Assert.True(actual.IsAbstract);
        Assert.Equal(expected.PropertyType.IsGenericParameter, property.PropertyType.IsGenericParameter);
        foreach (var getter in new[] { true, false })
        {
            var accessor = getter ? property.GetMethod : property.SetMethod;
            var reference = getter ? expected.GetMethod : expected.SetMethod;
            AssertAbstractAccessor(accessor, newSlot: true);
            Assert.Equal(reference.Attributes, accessor.Attributes);
            Assert.Equal(reference.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName),
                accessor.ReturnParameter.GetRequiredCustomModifiers().Select(type => type.FullName));
        }

        Assert.Equal(init, property.SetMethod.ReturnParameter.GetRequiredCustomModifiers().Any(type => type.FullName == "System.Runtime.CompilerServices.IsExternalInit"));
    }

    private static void AssertAbstractAccessor(MethodInfo accessor, bool newSlot)
    {
        Assert.NotNull(accessor);
        Assert.True(accessor.IsAbstract);
        Assert.True(accessor.IsVirtual);
        Assert.False(accessor.IsFinal);
        Assert.True(accessor.IsPublic);
        Assert.True(accessor.IsSpecialName);
        Assert.Equal(newSlot, (accessor.Attributes & MethodAttributes.NewSlot) != 0);
        Assert.Null(accessor.GetMethodBody());
    }

    private static (MethodAttributes Attributes, bool HasBody, int MethodImplCount, string DeclarationName)
        ReadCovariantAbstractGetterShape(string path)
    {
        using var pe = new PEReader(File.OpenRead(path));
        var metadata = pe.GetMetadataReader();
        var ownerHandle = Assert.Single(metadata.TypeDefinitions,
            handle => metadata.GetString(metadata.GetTypeDefinition(handle).Name) == "Middle");
        var owner = metadata.GetTypeDefinition(ownerHandle);
        var getterHandle = Assert.Single(owner.GetMethods(),
            handle => metadata.GetString(metadata.GetMethodDefinition(handle).Name) == "get_Item");
        var getter = metadata.GetMethodDefinition(getterHandle);
        var implementation = Assert.Single(owner.GetMethodImplementations(),
            handle => metadata.GetMethodImplementation(handle).MethodBody == getterHandle);
        var declaration = metadata.GetMethodImplementation(implementation).MethodDeclaration;
        var declarationName = declaration.Kind switch
        {
            HandleKind.MethodDefinition => metadata.GetString(metadata.GetMethodDefinition((MethodDefinitionHandle)declaration).Name),
            HandleKind.MemberReference => metadata.GetString(metadata.GetMemberReference((MemberReferenceHandle)declaration).Name),
            _ => throw new InvalidOperationException("Unexpected covariant property declaration handle " + declaration.Kind),
        };
        return (getter.Attributes, getter.RelativeVirtualAddress != 0, 1, declarationName);
    }

    private static void AssertCovariantSlotShape(
        (MethodAttributes Attributes, bool HasBody, int MethodImplCount, string DeclarationName) expected,
        (MethodAttributes Attributes, bool HasBody, int MethodImplCount, string DeclarationName) actual)
    {
        Assert.Equal(expected.Attributes, actual.Attributes);
        Assert.Equal(expected.MethodImplCount, actual.MethodImplCount);
        Assert.Equal(expected.DeclarationName, actual.DeclarationName);
    }

    private static string GetCustomAttributeTypeName(MetadataReader metadata, CustomAttributeHandle handle)
    {
        var constructor = metadata.GetCustomAttribute(handle).Constructor;
        EntityHandle owner = constructor.Kind switch
        {
            HandleKind.MemberReference => metadata.GetMemberReference((MemberReferenceHandle)constructor).Parent,
            HandleKind.MethodDefinition => metadata.GetMethodDefinition((MethodDefinitionHandle)constructor).GetDeclaringType(),
            _ => default,
        };
        return owner.Kind switch
        {
            HandleKind.TypeReference => metadata.GetString(metadata.GetTypeReference((TypeReferenceHandle)owner).Namespace)
                + "." + metadata.GetString(metadata.GetTypeReference((TypeReferenceHandle)owner).Name),
            HandleKind.TypeDefinition => metadata.GetString(metadata.GetTypeDefinition((TypeDefinitionHandle)owner).Namespace)
                + "." + metadata.GetString(metadata.GetTypeDefinition((TypeDefinitionHandle)owner).Name),
            _ => string.Empty,
        };
    }

    private static void Verify(string dll, params string[] references)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        IlVerifier.Verify(dll, references);
    }

    private void LogProduct(string path)
        => this.output.WriteLine("sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path);
}
