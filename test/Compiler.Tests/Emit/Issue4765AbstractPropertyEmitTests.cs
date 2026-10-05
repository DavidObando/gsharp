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
    [InlineData("class Missing : Base { }", "get_Value")]
    [InlineData("open class Missing : Base { }", "get_Value")]
    [InlineData("class Missing : Base { public prop Value int32 { get; set; } }", "get_Value")]
    [InlineData("class Missing : Base { public override prop Value int32 -> 7 }", "set_Value")]
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

    private static void Verify(string dll, params string[] references)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        IlVerifier.Verify(dll, references);
    }

    private void LogProduct(string path)
        => this.output.WriteLine("sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path);
}
