// <copyright file="Issue4765ImportedPropertyInitOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.Tests;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4765ImportedPropertyInitOverrideTests
{
    private readonly ITestOutputHelper output;

    public Issue4765ImportedPropertyInitOverrideTests(ITestOutputHelper output) => this.output = output;

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void ImportedWriteAccessorKindMismatchIsRejected(bool baseInit, bool reabstract)
    {
        var contract = ContractSource(baseInit);
        var mirror = $$"""
            public {{(reabstract ? "abstract " : "")}}class Mirror : ImportedKinds.Contract<int> {
                public {{(reabstract ? "abstract " : "")}}override int Value { get; protected {{(baseInit ? "set" : "init")}}; }
            }
            """;
        var csharp = CSharpCompilation.Create(
            "MismatchMirror",
            new[] { CSharpSyntaxTree.ParseText(contract), CSharpSyntaxTree.ParseText(mirror) },
            ReferenceResolver.HostTrustedPlatformAssemblyPaths().Select(path => MetadataReference.CreateFromFile(path)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Contains(csharp.GetDiagnostics(), diagnostic => diagnostic.Id == "CS8853");
        using var reference = new CSharpFixture(contract);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ImportedInitKind
            import ImportedKinds
            public {{(reabstract ? "abstract " : "")}}class Bridge : Contract[int32] {
                public {{(reabstract ? "abstract " : "")}}override prop Value int32 { get; protected {{(baseInit ? "set" : "init")}}; }
            }
            """;
        var result = fixture.TryCompile(source, "ImportedInitKind", false, "/r:" + reference.AssemblyPath);
        var dll = Path.Combine(fixture.Directory, "ImportedInitKind.dll");
        this.Retain("mismatch-" + baseInit + "-" + reabstract, contract, source, reference.AssemblyPath, dll, result.Output);
        this.output.WriteLine("gsc exit " + result.Code + "\n" + result.Output);
        Verify(reference.AssemblyPath);
        if (result.Code == 0)
        {
            // Preserve the pre-fix wrong-slot witness before the rejection assertion fails.
            this.LogSetterMetadata(reference.AssemblyPath);
            this.LogSetterMetadata(dll);
            try
            {
                Verify(dll, reference.AssemblyPath);
                this.output.WriteLine("Unexpected accepted product: strict ILVerify GREEN");
            }
            catch (Exception exception)
            {
                this.output.WriteLine("Unexpected accepted product: strict ILVerify RED\n" + exception);
            }

            try
            {
                var assembly = EmittedFixture.LoadTogether(reference.AssemblyPath, dll)[1];
                var bridge = RequiredType(assembly, "ImportedInitKind.Bridge");
                this.output.WriteLine("Unexpected accepted product: CLR type loaded " + bridge);
                var original = bridge.BaseType ?? throw new InvalidOperationException("Missing imported base");
                var actualModifiers = RequiredProperty(bridge).GetSetMethod(nonPublic: true).ReturnParameter
                    .GetRequiredCustomModifiers().Select(type => type.FullName).ToArray();
                var expectedModifiers = RequiredProperty(original).GetSetMethod(nonPublic: true).ReturnParameter
                    .GetRequiredCustomModifiers().Select(type => type.FullName).ToArray();
                this.output.WriteLine("Imported setter modreq=[" + string.Join(",", expectedModifiers)
                    + "]; emitted setter modreq=[" + string.Join(",", actualModifiers) + "]");
                Assert.Equal(expectedModifiers, actualModifiers);
            }
            catch (Exception exception)
            {
                this.output.WriteLine("Unexpected accepted product: CLR reflection/contract metadata RED\n" + exception);
            }
        }

        Assert.NotEqual(0, result.Code);
        Assert.Contains("GS0185", result.Output, StringComparison.Ordinal);
        Assert.Contains("Value", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(dll));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void MatchingImportedWriteAccessorKindsPreserveSlotsAndDispatch(bool init, bool reabstract)
    {
        var contract = ContractSource(init);
        var write = init ? "init" : "set";
        using var reference = new CSharpFixture(contract);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ImportedInitKind
            import ImportedKinds
            {{(reabstract ? "public abstract class Bridge : Contract[int32] { public abstract override prop Value int32 { get; protected " + write + "; } }" : "")}}
            public class Item : {{(reabstract ? "Bridge" : "Contract[int32]")}} {
                public override prop Value int32 { get; protected {{write}}; }
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
            """;
        var dll = fixture.Compile(source, "ImportedInitKind", false, "/r:" + reference.AssemblyPath);
        this.Retain("matching-" + init + "-" + reabstract, contract, source, reference.AssemblyPath, dll, "");
        Verify(reference.AssemblyPath);
        Verify(dll, reference.AssemblyPath);
        var assemblies = EmittedFixture.LoadTogether(reference.AssemblyPath, dll);
        var original = RequiredType(assemblies[0], "ImportedKinds.Contract`1").MakeGenericType(typeof(int));
        var item = RequiredType(assemblies[1], "ImportedInitKind.Item");
        var setter = RequiredProperty(item).GetSetMethod(nonPublic: true);
        Assert.NotNull(setter);
        Assert.True(setter.IsFamily);
        Assert.False(setter.IsAbstract);
        Assert.False((setter.Attributes & MethodAttributes.NewSlot) != 0);
        Assert.Equal(RequiredProperty(original).GetSetMethod(nonPublic: true).ReturnParameter.GetRequiredCustomModifiers(),
            setter.ReturnParameter.GetRequiredCustomModifiers());
        if (reabstract)
        {
            var bridge = RequiredType(assemblies[1], "ImportedInitKind.Bridge");
            Assert.Empty(bridge.GetFields(BindingFlags.DeclaredOnly | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
            var requiredSetter = RequiredProperty(bridge).GetSetMethod(nonPublic: true);
            Assert.NotNull(requiredSetter);
            Assert.True(requiredSetter.IsAbstract);
            Assert.True(requiredSetter.IsVirtual);
            Assert.True(requiredSetter.IsFamily);
            Assert.False(requiredSetter.IsFinal);
            Assert.False((requiredSetter.Attributes & MethodAttributes.NewSlot) != 0);
            Assert.Null(requiredSetter.GetMethodBody());
            Assert.Equal(setter.ReturnParameter.GetRequiredCustomModifiers(), requiredSetter.ReturnParameter.GetRequiredCustomModifiers());
        }

        Assert.Equal(11, RequiredType(assemblies[1], "ImportedInitKind.Driver").GetMethod("Run").Invoke(null, null));
    }

    private static string ContractSource(bool init) => $$"""
        namespace ImportedKinds {
            public abstract class Contract<T> {
                public abstract T Value { get; protected {{(init ? "init" : "set")}}; }
            }
        }
        """;

    private static Type RequiredType(Assembly assembly, string name)
        => assembly.GetType(name) ?? throw new InvalidOperationException("Missing type " + name);

    private static PropertyInfo RequiredProperty(Type type)
        => type.GetProperty("Value", BindingFlags.DeclaredOnly | BindingFlags.Instance | BindingFlags.Public)
            ?? throw new InvalidOperationException("Missing Value property");

    private static void Verify(string dll, params string[] references)
    {
        Assert.NotEqual("1", Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY"));
        IlVerifier.Verify(dll, references);
    }

    private void LogSetterMetadata(string dll)
    {
        using var stream = File.OpenRead(dll);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        foreach (var handle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(handle);
            if (metadata.GetString(method.Name) == "set_Value")
            {
                this.output.WriteLine("Actual set_Value: " + method.Attributes
                    + "; RVA=" + method.RelativeVirtualAddress
                    + "; signature=" + Convert.ToHexString(metadata.GetBlobBytes(method.Signature)));
            }
        }
    }

    private void Retain(string name, string contract, string source, string reference, string dll, string diagnostics)
    {
        foreach (var path in new[] { reference, dll }.Where(File.Exists))
        {
            this.output.WriteLine("sha256 " + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) + " " + path);
        }

        var root = Environment.GetEnvironmentVariable("GSHARP_IMPORTED_INIT_PROOF_ROOT");
        if (string.IsNullOrEmpty(root))
        {
            return;
        }

        var directory = Path.Combine(root, name);
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "Contract.cs"), contract);
        File.WriteAllText(Path.Combine(directory, "Native.gs"), source);
        File.WriteAllText(Path.Combine(directory, "diagnostics.log"), diagnostics);
        File.Copy(reference, Path.Combine(directory, Path.GetFileName(reference)));
        if (File.Exists(dll))
        {
            File.Copy(dll, Path.Combine(directory, Path.GetFileName(dll)));
        }
    }
}
