// <copyright file="Issue4777InheritedDataEqualityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import System.Security.Cryptography
import SystemObject = System.Object
import Xunit
import Xunit.Abstractions

@Collection("IlVerifyPipeline")
class Issue4777InheritedDataEqualityTranslationTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func NativeRecordMatrix_RetainsStructuralDispatchInterfacesAndReferenceSignatures() {
        let compiler string? = LocalFunctionHoistTranslationTests.FindCompiler()
        let repo = GsharpTestProjectRunner.FindRepoRoot()!!
        Assert.NotNull(compiler)
        Assert.NotNull(repo)
        Assert.NotEqual("1", Environment.GetEnvironmentVariable(IlVerifyRunner.SkipEnvVar))
        let fixture = Path.Combine(AppContext.BaseDirectory, "Fixtures", "issue4777")
        let source = File.ReadAllText(Path.Combine(fixture, "Models.cs.txt"))
        let callerSource = File.ReadAllText(Path.Combine(fixture, "Consumer.cs.txt"))
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "issue4777",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let nativeDirectory = Path.Combine(directory, "native")
            let gsDirectory = Path.Combine(directory, "GS")
            let referenceDirectory = Path.Combine(directory, "ref")
            Directory.CreateDirectory(nativeDirectory)
            Directory.CreateDirectory(gsDirectory)
            Directory.CreateDirectory(referenceDirectory)
            let native = Path.Combine(nativeDirectory, "Contracts.dll")
            let translated = Path.Combine(gsDirectory, "Contracts.dll")
            let reference = Path.Combine(referenceDirectory, "Contracts.dll")
            let caller = Path.Combine(directory, "Consumer.dll")
            CompileNative(native, source)
            CompileNative(caller, callerSource, native)
            this.output.WriteLine(
                "Same final test DLL SHA256=" +
                    Hash(typeof(Issue4777InheritedDataEqualityTranslationTests).Assembly.Location)
            )
            this.output.WriteLine("Same native consumer SHA256=" + Hash(caller))
            this.VerifyStrictly(repo, native, native)
            this.AssertRuntime(native, caller)
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Models.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            this.output.WriteLine("FULL actual translated source:\n" + printed)
            let gs = Path.Combine(directory, "Models.gs")
            File.WriteAllText(gs, printed)
            let arguments = List[string]{
                compiler!!,
                "/target:library",
                "/assemblyname:Contracts",
                "/out:" + translated,
                "/refout:" + reference
            }
            arguments.AddRange(
                CSharpProjectLoader.RuntimeReferences().Select((item MetadataReference) -> ("/r:" + item.Display))
            )
            arguments.Add(gs)
            let result = ProcessRunner.Run("dotnet", arguments, workingDirectory: repo)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output + "\n" + printed)
            Assert.True(File.Exists(translated))
            Assert.True(File.Exists(reference))
            this.VerifyStrictly(repo, translated, translated)
            this.VerifyStrictly(repo, caller, translated)
            this.AssertRuntime(translated, caller)
            let referenceCaller = Path.Combine(directory, "ReferenceConsumer.dll")
            CompileNative(referenceCaller, callerSource, reference)
            this.VerifyStrictly(repo, referenceCaller, translated)
            this.AssertRuntime(translated, referenceCaller)
            let implementationMetadata = EqualityMetadata(translated)
            let referenceMetadata = EqualityMetadata(reference)
            this.output.WriteLine("Implementation equality metadata:\n" + string.Join("\n", implementationMetadata))
            this.output.WriteLine("Reference equality metadata:\n" + string.Join("\n", referenceMetadata))
            Assert.Equal(implementationMetadata, referenceMetadata)
            this.AssertNativeTypedSlots(native, translated)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    private func AssertRuntime(target string, caller string) {
        let context = AssemblyLoadContext("issue4777-" + Guid.NewGuid().ToString("N"), isCollectible: true)
        try {
            LoadActualImage(context, target)
            let consumer = LoadActualImage(context, caller)
            let consumerType Type? = consumer.GetType("MatrixConsumer", throwOnError: true)
            let run MethodInfo? = consumerType!!.GetMethod("Run")
            Assert.NotNull(run)
            Assert.Equal(true, run!!.Invoke(nil, nil))
            this.output.WriteLine(
                "Real native consumer passed all hierarchy/generic/nested/nullable/operator assertions: " + Hash(target)
            )
        } finally {
            context.Unload()
        }
    }

    private func AssertNativeTypedSlots(native string, translated string) {
        let contexts = []AssemblyLoadContext{
            AssemblyLoadContext("issue4777-native-slots", isCollectible: true),
            AssemblyLoadContext("issue4777-GS-slots", isCollectible: true)
        }
        try {
            let images = []Assembly{LoadActualImage(contexts[0], native), LoadActualImage(contexts[1], translated)}
            let Snapshot = func (assembly Assembly)[]string {
                return assembly
                    .GetExportedTypes()
                    .SelectMany(
                    func (type Type) IEnumerable[string] {
                        return type
                            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
                            .Where(
                            (method MethodInfo) -> method.Name == "Equals" && method.GetParameters()
                                .Length == 1 &&
                                method
                                .GetParameters()[0]
                                .ParameterType != typeof(object)
                        )
                            .Select(
                            (method MethodInfo) -> {
                                let parameter = Assert.Single(method.GetParameters())
                                return type.FullName + "|" + method.ToString() + "|" + method.Attributes.ToString() +
                                    "|" +
                                    method
                                    .GetBaseDefinition()
                                    .DeclaringType!!.FullName +
                                    "|" +
                                    parameter.Name +
                                    "|" +
                                    parameter
                                    .Attributes
                                    .ToString() + "|" + NullabilityInfoContext().Create(parameter).ReadState.ToString()
                            }
                        )
                    }
                )
                    .OrderBy((value string) -> value, StringComparer.Ordinal)
                    .ToArray()
            }
            let expected = Snapshot(images[0])
            Assert.NotEmpty(expected)
            Assert.Equal(expected, Snapshot(images[1]))
            this.output.WriteLine(
                "Exact native self/base slots, flags, owners, parameter names/ref kinds/nullability retained."
            )
        } finally {
            for context in contexts {
                context.Unload()
            }
        }
    }

    private func VerifyStrictly(repo string, image string, targetReference string) {
        let arguments = List[string]{"tool", "run", "ilverify", image, "-s", "System.Private.CoreLib", "--statistics"}
        for reference in Directory
            .GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            .Append(targetReference)
            .Distinct() {
            arguments.Add("-r")
            arguments.Add(reference)
        }
        let result = ProcessRunner.Run("dotnet", arguments, workingDirectory: repo)
        this.output.WriteLine("Strict unsuppressed verifier:\n" + result.Output)
        Assert.False(result.TimedOut)
        Assert.True(result.ExitCode == 0, result.Output)
        Assert.Contains("All Classes and Methods", result.Output, StringComparison.Ordinal)
        Assert.DoesNotContain("[IL]: Error", result.Output, StringComparison.Ordinal)
    }

    private class EqualitySignatureProvider : ISignatureTypeProvider[string, object] {
        func GetArrayType(elementType string, shape ArrayShape) string -> elementType + "[" + shape.Rank.ToString() +
            ";" +
            string.Join(",", shape.Sizes) + ";" + string.Join(",", shape.LowerBounds) + "]"

        func GetByReferenceType(elementType string) string -> elementType + "&"

        func GetFunctionPointerType(signature MethodSignature[string]) string -> signature.Header.ToString() +
            "|" +
            signature.ReturnType +
            "(" +
            string.Join(",", signature.ParameterTypes) + ")"

        func GetGenericInstantiation(genericType string, typeArguments ImmutableArray[string]) string -> genericType +
            "[" +
            string.Join(",", typeArguments) + "]"

        func GetGenericMethodParameter(genericContext object, index int32) string -> "!!" + index.ToString()

        func GetGenericTypeParameter(genericContext object, index int32) string -> "!" + index.ToString()

        func GetModifiedType(modifier string, unmodifiedType string, isRequired bool) string -> unmodifiedType +
            (
            if isRequired {
                " modreq("
            } else {
                " modopt("
            }
        ) +
            modifier +
            ")"

        func GetPinnedType(elementType string) string -> elementType + " pinned"

        func GetPointerType(elementType string) string -> elementType + "*"

        func GetPrimitiveType(typeCode PrimitiveTypeCode) string -> typeCode.ToString()

        func GetSZArrayType(elementType string) string -> elementType + "[]"

        func GetTypeFromDefinition(reader MetadataReader, handle TypeDefinitionHandle, rawTypeKind uint8) string {
            return rawTypeKind.ToString() + ":" + DefinitionName(reader, handle)
        }

        func GetTypeFromReference(reader MetadataReader, handle TypeReferenceHandle, rawTypeKind uint8) string {
            return rawTypeKind.ToString() + ":" + ReferenceName(reader, handle)
        }

        func GetTypeFromSpecification(
            reader MetadataReader,
            genericContext object,
            handle TypeSpecificationHandle,
            rawTypeKind uint8
        ) string -> reader
            .GetTypeSpecification(handle).DecodeSignature(this, genericContext)

        shared {
            private func DefinitionName(reader MetadataReader, handle TypeDefinitionHandle) string {
                let type = reader.GetTypeDefinition(handle)
                let parent = type.GetDeclaringType()
                return if parent.IsNil {
                    reader.GetString(type.Namespace) + "." + reader.GetString(type.Name)
                } else {
                    DefinitionName(reader, parent) + "+" + reader.GetString(type.Name)
                }
            }

            private func ReferenceName(reader MetadataReader, handle TypeReferenceHandle) string {
                let type = reader.GetTypeReference(handle)
                return if type.ResolutionScope.Kind == HandleKind.TypeReference {
                    ReferenceName(reader, TypeReferenceHandle(type.ResolutionScope)) + "+" + reader.GetString(type.Name)
                } else {
                    reader.GetString(type.Namespace) + "." + reader.GetString(type.Name)
                }
            }
        }
    }

    shared {
        private func CompileNative(path string, source string, references ...string) {
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(path),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                CSharpProjectLoader.RuntimeReferences().Concat(
                    references.Select((path string) -> MetadataReference.CreateFromFile(path))
                ),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithDeterministic(true)
            )
            using let image = File.Create(path)
            let result = compilation.Emit(image)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }

        private func EqualityMetadata(path string)[]string {
            using let image = File.OpenRead(path)
            using let pe = PEReader(image)
            let metadata = pe.GetMetadataReader()
            let rows = List[string]()
            for typeHandle in metadata.TypeDefinitions {
                let type = metadata.GetTypeDefinition(typeHandle)
                for parameterHandle in type.GetGenericParameters() {
                    let parameter = metadata.GetGenericParameter(parameterHandle)
                    rows.Add(
                        metadata.GetString(type.Name) + "|generic-parameter|" + parameter.Index.ToString() +
                            "|" +
                            metadata.GetString(parameter.Name) + "|" + parameter.Attributes.ToString()
                    )
                }
                for implementationHandle in type.GetMethodImplementations() {
                    let implementation = metadata.GetMethodImplementation(implementationHandle)
                    rows.Add(
                        metadata.GetString(type.Name) +
                            "|method-implementation|" +
                            MethodReference(metadata, implementation.MethodBody) +
                            "|" +
                            MethodReference(metadata, implementation.MethodDeclaration)
                    )
                }
                for methodHandle in type.GetMethods() {
                    let method = metadata.GetMethodDefinition(methodHandle)
                    if metadata.GetString(method.Name) != "Equals" {
                        continue
                    }
                    let signature = method.DecodeSignature(EqualitySignatureProvider(), default(object))
                    rows.Add(
                        metadata.GetString(type.Name) + "|" + method.Attributes.ToString() +
                            "|" +
                            signature.ReturnType +
                            "(" +
                            string.Join(",", signature.ParameterTypes) + ")" + "|" + signature.Header.ToString() +
                            "|" +
                            signature
                            .GenericParameterCount
                            .ToString()
                    )
                    for parameterHandle in method.GetParameters() {
                        let parameter = metadata.GetParameter(parameterHandle)
                        rows.Add(
                            parameter.SequenceNumber.ToString() + "|" + metadata.GetString(parameter.Name) +
                                "|" +
                                parameter
                                .Attributes
                                .ToString()
                        )
                        for attributeHandle in parameter.GetCustomAttributes() {
                            let attribute = metadata.GetCustomAttribute(attributeHandle)
                            rows.Add(
                                "parameter-attribute|" + Convert.ToHexString(metadata.GetBlobBytes(attribute.Value))
                            )
                        }
                    }
                }
            }
            Assert.NotEmpty(rows)
            return rows.ToArray()
        }

        private func MethodReference(reader MetadataReader, handle EntityHandle) string {
            let provider = EqualitySignatureProvider()
            var owner string
            var name string
            var signature MethodSignature[string]
            if handle.Kind == HandleKind.MethodDefinition {
                let method = reader.GetMethodDefinition(MethodDefinitionHandle(handle))
                owner = provider.GetTypeFromDefinition(reader, method.GetDeclaringType(), 0)
                name = reader.GetString(method.Name)
                signature = method.DecodeSignature(provider, default(object))
            } else {
                Assert.Equal(HandleKind.MemberReference, handle.Kind)
                let method = reader.GetMemberReference(MemberReferenceHandle(handle))
                let genericContext = SystemObject()
                owner = switch method.Parent.Kind {
                    case HandleKind.TypeDefinition: provider.GetTypeFromDefinition(
                        reader,
                        TypeDefinitionHandle(method.Parent),
                        0
                    )
                    case HandleKind.TypeReference: provider.GetTypeFromReference(
                        reader,
                        TypeReferenceHandle(method.Parent),
                        0
                    )
                    case HandleKind.TypeSpecification: provider.GetTypeFromSpecification(
                        reader,
                        genericContext,
                        TypeSpecificationHandle(method.Parent),
                        0
                    )
                    default: throw InvalidOperationException(
                        "Unexpected equality declaration owner: " + method.Parent.Kind.ToString()
                    )
                }
                name = reader.GetString(method.Name)
                signature = method.DecodeMethodSignature(provider, genericContext)
            }
            return owner + "|" + name + "|" + signature.ReturnType + "(" + string.Join(",", signature.ParameterTypes) +
                ")|" +
                signature
                .Header
                .ToString()
        }

        private func LoadActualImage(context AssemblyLoadContext, path string) Assembly {
            using let image = MemoryStream(File.ReadAllBytes(path))
            using let pe = PEReader(image, PEStreamOptions.LeaveOpen)
            let metadata = pe.GetMetadataReader()
            let expectedMvid = metadata.GetGuid(metadata.GetModuleDefinition().Mvid)
            image.Position = 0
            let assembly = context.LoadFromStream(image)
            Assert.Equal(expectedMvid, assembly.ManifestModule.ModuleVersionId)
            return assembly
        }

        private func Hash(path string) string -> Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
    }
}
