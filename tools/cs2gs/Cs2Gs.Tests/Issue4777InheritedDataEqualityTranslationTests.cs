// <copyright file="Issue4777InheritedDataEqualityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using System.Security.Cryptography;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace Cs2Gs.Tests;

[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue4777InheritedDataEqualityTranslationTests
{
    private readonly ITestOutputHelper output;

    public Issue4777InheritedDataEqualityTranslationTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void NativeRecordMatrix_RetainsStructuralDispatchInterfacesAndReferenceSignatures()
    {
        string compiler = LocalFunctionHoistTranslationTests.FindCompiler();
        string repo = GsharpTestProjectRunner.FindRepoRoot();
        Assert.NotNull(compiler);
        Assert.NotNull(repo);
        Assert.NotEqual("1", Environment.GetEnvironmentVariable(IlVerifyRunner.SkipEnvVar));
        string fixture = Path.Combine(AppContext.BaseDirectory, "Fixtures", "issue4777");
        string source = File.ReadAllText(Path.Combine(fixture, "Models.cs"));
        string callerSource = File.ReadAllText(Path.Combine(fixture, "Consumer.cs"));
        string directory = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", "issue4777", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string nativeDirectory = Path.Combine(directory, "native");
            string gsDirectory = Path.Combine(directory, "GS");
            string referenceDirectory = Path.Combine(directory, "ref");
            Directory.CreateDirectory(nativeDirectory);
            Directory.CreateDirectory(gsDirectory);
            Directory.CreateDirectory(referenceDirectory);
            string native = Path.Combine(nativeDirectory, "Contracts.dll");
            string translated = Path.Combine(gsDirectory, "Contracts.dll");
            string reference = Path.Combine(referenceDirectory, "Contracts.dll");
            string caller = Path.Combine(directory, "Consumer.dll");
            CompileNative(native, source);
            CompileNative(caller, callerSource, native);
            this.output.WriteLine("Same final test DLL SHA256=" + Hash(typeof(Issue4777InheritedDataEqualityTranslationTests).Assembly.Location));
            this.output.WriteLine("Same native consumer SHA256=" + Hash(caller));
            this.VerifyStrictly(repo, native, native);
            this.AssertRuntime(native, caller);

            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Models.cs", source) });
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            this.output.WriteLine("FULL actual translated source:\n" + printed);
            string gs = Path.Combine(directory, "Models.gs");
            File.WriteAllText(gs, printed);
            var arguments = new List<string>
            {
                compiler, "/target:library", "/assemblyname:Contracts", "/out:" + translated, "/refout:" + reference,
            };
            arguments.AddRange(CSharpProjectLoader.RuntimeReferences().Select(item => "/r:" + item.Display));
            arguments.Add(gs);
            ProcessRunResult result = ProcessRunner.Run("dotnet", arguments, workingDirectory: repo);
            Assert.False(result.TimedOut, result.Output);
            Assert.True(result.ExitCode == 0, result.Output + "\n" + printed);
            Assert.True(File.Exists(translated));
            Assert.True(File.Exists(reference));
            this.VerifyStrictly(repo, translated, translated);
            this.VerifyStrictly(repo, caller, translated);
            this.AssertRuntime(translated, caller);
            string referenceCaller = Path.Combine(directory, "ReferenceConsumer.dll");
            CompileNative(referenceCaller, callerSource, reference);
            this.VerifyStrictly(repo, referenceCaller, translated);
            this.AssertRuntime(translated, referenceCaller);
            string[] implementationMetadata = EqualityMetadata(translated);
            string[] referenceMetadata = EqualityMetadata(reference);
            this.output.WriteLine("Implementation equality metadata:\n" + string.Join("\n", implementationMetadata));
            this.output.WriteLine("Reference equality metadata:\n" + string.Join("\n", referenceMetadata));
            Assert.Equal(implementationMetadata, referenceMetadata);
            this.AssertNativeTypedSlots(native, translated);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void CompileNative(string path, string source, params string[] references)
    {
        var compilation = CSharpCompilation.Create(
            Path.GetFileNameWithoutExtension(path),
            new[] { CSharpSyntaxTree.ParseText(source) },
            CSharpProjectLoader.RuntimeReferences().Concat(references.Select(path => MetadataReference.CreateFromFile(path))),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithDeterministic(true));
        using var image = File.Create(path);
        var result = compilation.Emit(image);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string[] EqualityMetadata(string path)
    {
        using var image = File.OpenRead(path);
        using var pe = new PEReader(image);
        MetadataReader metadata = pe.GetMetadataReader();
        var rows = new List<string>();
        foreach (var typeHandle in metadata.TypeDefinitions)
        {
            var type = metadata.GetTypeDefinition(typeHandle);
            foreach (var parameterHandle in type.GetGenericParameters())
            {
                var parameter = metadata.GetGenericParameter(parameterHandle);
                rows.Add(metadata.GetString(type.Name) + "|generic-parameter|"
                    + parameter.Index + "|" + metadata.GetString(parameter.Name) + "|" + parameter.Attributes);
            }

            foreach (var implementationHandle in type.GetMethodImplementations())
            {
                var implementation = metadata.GetMethodImplementation(implementationHandle);
                rows.Add(metadata.GetString(type.Name) + "|method-implementation|"
                    + MethodReference(metadata, implementation.MethodBody) + "|"
                    + MethodReference(metadata, implementation.MethodDeclaration));
            }

            foreach (var methodHandle in type.GetMethods())
            {
                var method = metadata.GetMethodDefinition(methodHandle);
                if (metadata.GetString(method.Name) != "Equals")
                {
                    continue;
                }

                var signature = method.DecodeSignature(new EqualitySignatureProvider(), (object)null);
                rows.Add(metadata.GetString(type.Name) + "|" + method.Attributes + "|"
                    + signature.ReturnType + "(" + string.Join(",", signature.ParameterTypes) + ")"
                    + "|" + signature.Header + "|" + signature.GenericParameterCount);
                foreach (var parameterHandle in method.GetParameters())
                {
                    var parameter = metadata.GetParameter(parameterHandle);
                    rows.Add(parameter.SequenceNumber + "|" + metadata.GetString(parameter.Name) + "|" + parameter.Attributes);
                    foreach (var attributeHandle in parameter.GetCustomAttributes())
                    {
                        var attribute = metadata.GetCustomAttribute(attributeHandle);
                        rows.Add("parameter-attribute|" + Convert.ToHexString(metadata.GetBlobBytes(attribute.Value)));
                    }
                }
            }
        }

        Assert.NotEmpty(rows);
        return rows.ToArray();
    }

    private static string MethodReference(MetadataReader reader, EntityHandle handle)
    {
        var provider = new EqualitySignatureProvider();
        string owner;
        string name;
        MethodSignature<string> signature;
        if (handle.Kind == HandleKind.MethodDefinition)
        {
            var method = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
            owner = provider.GetTypeFromDefinition(reader, method.GetDeclaringType(), 0);
            name = reader.GetString(method.Name);
            signature = method.DecodeSignature(provider, (object)null);
        }
        else
        {
            Assert.Equal(HandleKind.MemberReference, handle.Kind);
            var method = reader.GetMemberReference((MemberReferenceHandle)handle);
            owner = method.Parent.Kind switch
            {
                HandleKind.TypeDefinition => provider.GetTypeFromDefinition(reader, (TypeDefinitionHandle)method.Parent, 0),
                HandleKind.TypeReference => provider.GetTypeFromReference(reader, (TypeReferenceHandle)method.Parent, 0),
                HandleKind.TypeSpecification => provider.GetTypeFromSpecification(reader, null, (TypeSpecificationHandle)method.Parent, 0),
                _ => throw new InvalidOperationException("Unexpected equality declaration owner: " + method.Parent.Kind),
            };
            name = reader.GetString(method.Name);
            signature = method.DecodeMethodSignature(provider, (object)null);
        }

        return owner + "|" + name + "|" + signature.ReturnType + "("
            + string.Join(",", signature.ParameterTypes) + ")|" + signature.Header;
    }

    private void AssertRuntime(string target, string caller)
    {
        var context = new AssemblyLoadContext("issue4777-" + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(Path.GetFullPath(target));
            Assert.Equal(Path.GetFullPath(target), assembly.Location);
            var consumer = context.LoadFromAssemblyPath(Path.GetFullPath(caller));
            Type consumerType = consumer.GetType("MatrixConsumer", throwOnError: true);
            MethodInfo run = consumerType.GetMethod("Run");
            Assert.NotNull(run);
            Assert.Equal(true, run.Invoke(null, null));
            this.output.WriteLine("Real native consumer passed all hierarchy/generic/nested/nullable/operator assertions: " + Hash(target));
        }
        finally
        {
            context.Unload();
        }
    }

    private void AssertNativeTypedSlots(string native, string translated)
    {
        var contexts = new[]
        {
            new AssemblyLoadContext("issue4777-native-slots", isCollectible: true),
            new AssemblyLoadContext("issue4777-GS-slots", isCollectible: true),
        };
        try
        {
            var images = new[]
            {
                contexts[0].LoadFromAssemblyPath(Path.GetFullPath(native)),
                contexts[1].LoadFromAssemblyPath(Path.GetFullPath(translated)),
            };
            string[] Snapshot(Assembly assembly) => assembly.GetExportedTypes().SelectMany(type =>
                type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                    .Where(method => method.Name == "Equals" && method.GetParameters().Length == 1
                        && method.GetParameters()[0].ParameterType != typeof(object))
                    .Select(method =>
                    {
                        ParameterInfo parameter = Assert.Single(method.GetParameters());
                        return type.FullName + "|" + method + "|" + method.Attributes
                            + "|" + method.GetBaseDefinition().DeclaringType.FullName
                            + "|" + parameter.Name + "|" + parameter.Attributes
                            + "|" + new NullabilityInfoContext().Create(parameter).ReadState;
                    })).OrderBy(value => value, StringComparer.Ordinal).ToArray();
            string[] expected = Snapshot(images[0]);
            Assert.NotEmpty(expected);
            Assert.Equal(expected, Snapshot(images[1]));
            this.output.WriteLine("Exact native self/base slots, flags, owners, parameter names/ref kinds/nullability retained.");
        }
        finally
        {
            foreach (var context in contexts)
            {
                context.Unload();
            }
        }
    }

    private void VerifyStrictly(string repo, string image, string targetReference)
    {
        var arguments = new List<string> { "tool", "run", "ilverify", image, "-s", "System.Private.CoreLib", "--statistics" };
        foreach (string reference in Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll").Append(targetReference).Distinct())
        {
            arguments.Add("-r");
            arguments.Add(reference);
        }

        ProcessRunResult result = ProcessRunner.Run("dotnet", arguments, workingDirectory: repo);
        this.output.WriteLine("Strict unsuppressed verifier:\n" + result.Output);
        Assert.False(result.TimedOut);
        Assert.True(result.ExitCode == 0, result.Output);
        Assert.Contains("All Classes and Methods", result.Output, StringComparison.Ordinal);
        Assert.DoesNotContain("[IL]: Error", result.Output, StringComparison.Ordinal);
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    private sealed class EqualitySignatureProvider : ISignatureTypeProvider<string, object>
    {
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[" + shape.Rank + ";" + string.Join(",", shape.Sizes) + ";" + string.Join(",", shape.LowerBounds) + "]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetFunctionPointerType(MethodSignature<string> signature) => signature.Header + "|" + signature.ReturnType + "(" + string.Join(",", signature.ParameterTypes) + ")";

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => genericType + "[" + string.Join(",", typeArguments) + "]";

        public string GetGenericMethodParameter(object genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType + (isRequired ? " modreq(" : " modopt(") + modifier + ")";

        public string GetPinnedType(string elementType) => elementType + " pinned";

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
        {
            return rawTypeKind + ":" + DefinitionName(reader, handle);
        }

        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
        {
            return rawTypeKind + ":" + ReferenceName(reader, handle);
        }

        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind)
            => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        private static string DefinitionName(MetadataReader reader, TypeDefinitionHandle handle)
        {
            var type = reader.GetTypeDefinition(handle);
            var parent = type.GetDeclaringType();
            return parent.IsNil
                ? reader.GetString(type.Namespace) + "." + reader.GetString(type.Name)
                : DefinitionName(reader, parent) + "+" + reader.GetString(type.Name);
        }

        private static string ReferenceName(MetadataReader reader, TypeReferenceHandle handle)
        {
            var type = reader.GetTypeReference(handle);
            return type.ResolutionScope.Kind == HandleKind.TypeReference
                ? ReferenceName(reader, (TypeReferenceHandle)type.ResolutionScope) + "+" + reader.GetString(type.Name)
                : reader.GetString(type.Namespace) + "." + reader.GetString(type.Name);
        }
    }
}
