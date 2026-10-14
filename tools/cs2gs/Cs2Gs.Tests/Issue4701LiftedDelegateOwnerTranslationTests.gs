// <copyright file="Issue4701LiftedDelegateOwnerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

/// Lifted source delegates do not split an external extension's owner and attributes.
@Collection("IlVerifyPipeline")
class Issue4701LiftedDelegateOwnerTranslationTests {
    @Fact
    func LiftedDelegates_RetainOwnerAttributesSignaturesAndOnceOnlyEffects() {
        let project = Load(Source)
        using let nativeImage = MemoryStream()
        let emitted = project.Compilation.Emit(nativeImage)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let native = EmittedFixture.Load(nativeImage.ToArray())
        AssertMetadataAndRuntime(native, lifted: false)
        let unit = Translate(project)
        AssertCompiled(
            unit,
            nativeImage.ToArray(),
            (assembly Assembly) -> AssertMetadataAndRuntime(assembly, lifted: true)
        )
    }

    @Theory
    @InlineData("private delegate Box Callback(int value);", "Callback", "Callback")
    @InlineData("private delegate void Callback(Box[] values);", "Callback", "Callback")
    @InlineData("private delegate (Box Value, int Count) Callback(int value);", "Callback", "Callback")
    @InlineData(
        "private delegate Second Callback(int value); private delegate Box Second(int value);",
        "Callback",
        "Callback"
    )
    @InlineData("", "GenericContainer<Box>.Callback", "GenericContainer<Box>.Callback")
    func DelegatesExposingPrivateTypes_KeepHelperAndFilterOnlyInaccessibleAttributes(
        declaration string,
        attributeType string,
        signatureType string
    ) {
        let (unit, nativeImage) = AssertPrivateExposure(declaration, attributeType, signatureType)
        AssertCompiled(
            unit,
            nativeImage,
            (assembly Assembly) -> {
                let emittedOwner Type? = assembly.GetType("Issue4701.Owner")
                Assert.NotNull(emittedOwner)
                let signature MethodInfo? = emittedOwner!!.GetMethod(
                    "Signature",
                    BindingFlags.NonPublic | BindingFlags.Static
                )
                Assert.NotNull(signature)
                Assert.True(signature!!.IsPrivate)
                let tagged MethodInfo? = emittedOwner!!.GetMethod("Tagged")
                Assert.NotNull(tagged)
                Assert.NotNull(MarkerType(tagged!!.GetCustomAttributesData()))
                let program = Assert.Single(assembly.GetExportedTypes(), (type Type) -> type.Name == "<Program>")
                let forwarded MethodInfo? = program.GetMethod("Tagged")
                Assert.NotNull(forwarded)
                Assert.True(forwarded!!.IsDefined(typeof(ExtensionAttribute), inherit: false))
                Assert.DoesNotContain(
                    forwarded!!.GetCustomAttributesData(),
                    (attribute CustomAttributeData) -> attribute.AttributeType.Name == "MarkerAttribute"
                )
                Assert.True(forwarded!!.IsDefined(typeof(ObsoleteAttribute), inherit: false))
                Assert.DoesNotContain(
                    assembly.GetExportedTypes().SelectMany(
                        func (type Type) IEnumerable[MethodInfo] {
                            return type.GetMethods()
                        }
                    ),
                    (method MethodInfo) -> method.Name == "Signature"
                )
                Assert.Equal(3, assembly.GetType("Issue4701.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
            }
        )
    }

    @Theory
    @InlineData("private delegate T Callback<T>(T value) where T : Box;", "Callback<>", "Callback<Box>")
    @InlineData("private delegate T Callback<T>(T value) where T : Box;", "Callback<Box>", "Callback<Box>")
    @InlineData("private delegate Callback Callback(Callback other, Box value);", "Callback", "Callback")
    func DelegateBoundaryGaps_PreserveNativeValidPrivateExposurePolicy(
        declaration string,
        attributeType string,
        signatureType string
    ) {
        // Policy-only controls (#4757/#4758/#4759): typeof and private constraints
        // have independent naming, compiler-recursion and CLR-accessibility gaps.
        AssertPrivateExposure(declaration, attributeType, signatureType)
    }

    @Fact
    func ExpandingGenericDelegate_PolicyVisitsDefinitionAndActualArguments() {
        const source = `using System;
namespace Issue4701
{
    public sealed class MarkerAttribute : Attribute
    {
        public MarkerAttribute(Type type) { }
    }
    public static class Owner
    {
        private class Box { }
        private delegate Callback<Callback<T>> Callback<T>(Callback<T> other);
        [Marker(typeof(Callback<int>))]
        public static int Safe(this string value) => value.Length;
        [Marker(typeof(Callback<Box>))]
        public static int Unsafe(this string value) => value.Length;
    }
    public static class Probe
    {
        public static int Run() => "abc".Safe() + "abc".Unsafe();
    }
}`
        let project = Load(source)
        using let native = MemoryStream()
        let emitted = project.Compilation.Emit(native)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        Assert.True(native.Length > int64(0))
        let original = EmittedFixture.Load(native.ToArray())
        Assert.Equal(6, original.GetType("Issue4701.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
        // gsc's recursive-delegate typeof query is tracked in #4757. This
        // native-valid control exercises the actual translator exposure policy.
        let unit = Translate(project)
        let owner = Assert.Single(
            unit.Members.OfType[TypeDeclaration](),
            (type TypeDeclaration) -> type.Name == "Owner"
        )
        let safe = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Safe"
        )
        Assert.Contains(safe.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
        Assert.Contains(
            safe.Attributes,
            (attribute AttributeUse) -> attribute.Name.Contains("Marker", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(
            owner.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Safe"
        )
        Assert.Contains(
            owner.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Unsafe"
        )
        let unsafeCompanion = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Unsafe"
        )
        Assert.DoesNotContain(
            unsafeCompanion.Attributes,
            (attribute AttributeUse) -> attribute.Name.Contains("Marker", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(
            unsafeCompanion.Attributes,
            (attribute AttributeUse) -> attribute.Name == "ExtensionOwner"
        )
    }

    @Fact
    func ImportedPrivateDelegate_DoesNotAcquireSourceLiftingAccessibility() {
        let source = Load(Source)
        using let image = MemoryStream()
        let emitted = source.Compilation.Emit(image)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let consumer = CSharpCompilation.Create(
            "Issue4701.Import",
            references: CSharpProjectLoader.RuntimeReferences().Append(
                MetadataReference.CreateFromImage(image.ToArray())
            ),
            options: CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithMetadataImportOptions(
                MetadataImportOptions.All
            )
        )
        let sourceOwner INamedTypeSymbol? = source.Compilation.GetTypeByMetadataName("Issue4701.Owner")
        let importedOwner INamedTypeSymbol? = consumer.GetTypeByMetadataName("Issue4701.Owner")
        Assert.NotNull(sourceOwner)
        Assert.NotNull(importedOwner)
        let sourceDelegate = Assert.Single(sourceOwner!!.GetTypeMembers("PrivateDelegate"))
        let importedDelegate = Assert.Single(importedOwner!!.GetTypeMembers("PrivateDelegate"))
        Assert.Equal(Accessibility.Private, importedDelegate.DeclaredAccessibility)
        Assert.DoesNotContain(
            importedDelegate.Locations,
            (location Microsoft.CodeAnalysis.Location) -> location.IsInSource
        )
        // A policy-unit control for imported metadata; the source side's full
        // translation/emission/consumer/runtime path is exercised above.
        let exposure = Assert.Single(
            typeof(CSharpToGSharpTranslator).GetMethods(BindingFlags.NonPublic | BindingFlags.Static),
            (method MethodInfo) -> method.Name == "NamesPrivateNestedType" && method.GetParameters().Length == 2
        )
        Assert.Equal(false, exposure.Invoke(nil, []object{sourceDelegate, sourceOwner!!}))
        Assert.Equal(true, exposure.Invoke(nil, []object{importedDelegate, importedOwner!!}))
    }

    shared {
        private const Source string = `using System;

namespace Issue4701
{
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.ReturnValue | AttributeTargets.Parameter)]
    public sealed class MarkerAttribute : Attribute
    {
        public MarkerAttribute(Type type) { Type = type; }
        public Type Type { get; }
    }

    public class GenericContainer<T>
    {
        public delegate int Callback(int value);
    }

    public static class Owner
    {
        private sealed class Cache { }
        private delegate int PrivateDelegate(int value);
        private delegate T Identity<T>(T value) where T : struct;
        private sealed class Container
        {
            public delegate int Callback(int value);
        }

        private static int calls;
        public static int Calls => calls;
        public static void Reset() { calls = 0; }
        private static int Next(int value) => value + 7;

        [Marker(typeof(PrivateDelegate))]
        [Obsolete("retained")]
        public static int M(this string value)
        {
            calls++;
            PrivateDelegate callback = Next;
            return callback(value.Length);
        }

        [return: Marker(typeof(PrivateDelegate))]
        public static int ReturnTagged(this string value) => value.Length;

        public static int ParameterTagged(this string value, [Marker(typeof(PrivateDelegate))] int extra) =>
            value.Length + extra;

        private static PrivateDelegate Create(this string value) => Next;
        private static int Apply(this string value, PrivateDelegate callback) => callback(value.Length);
        private static int Generic(this string value, Identity<int> callback) => callback(value.Length);
        private static int Array(this string value, PrivateDelegate[] callbacks) => callbacks[0](value.Length);
        private static PrivateDelegate TupleChoice(this string value, (PrivateDelegate Callback, int Bias) choice) =>
            choice.Callback;

        public static int GenericOwner(this string value, GenericContainer<int>.Callback callback) =>
            callback(value.Length);

        [Marker(typeof(GenericContainer<int>.Callback))]
        public static int GenericTagged(this string value) => value.Length;

        [Marker(typeof(EventHandler))]
        public static int Imported(this string value) => value.Length;

        [Marker(typeof(Container.Callback))]
        public static int NestedTagged(this string value) => value.Length;

        public static int RunPrivate(string value)
        {
            PrivateDelegate callback = value.Create();
            Identity<int> identity = n => n;
            return value.Apply(callback) + value.Array(new[] { callback })
                + value.TupleChoice((callback, 1))(value.Length) + value.Generic(identity);
        }
    }

    public static class Probe
    {
        private static int receivers;
        private static string Receiver() { receivers++; return "abc"; }

        public static string Run()
        {
            receivers = 0;
            Owner.Reset();
            int result = Receiver().M();
            return result + "|" + Owner.RunPrivate("ab") + "|" + Owner.Calls + "|" + receivers
                + "|" + "abc".ReturnTagged() + "|" + "abc".ParameterTagged(4)
                + "|" + "abc".GenericOwner(n => n) + "|" + "abc".GenericTagged()
                + "|" + "abc".Imported() + "|" + "abc".NestedTagged();
        }
    }
}`

        private func AssertPrivateExposure(declaration string, attributeType string, signatureType string)(
            Unit CompilationUnit,
            NativeImage[]uint8
        ) {
            let source = (`using System;
namespace Issue4701
{
    public class GenericContainer<T> { public delegate int Callback(int value); }
    public sealed class MarkerAttribute : Attribute
    {
        public MarkerAttribute(Type type) { }
    }
    public static class Owner
    {
        private class Box { }
        ` + "$declaration" + `
        private static int Signature(this string value, ` + "$signatureType" + ` callback) => value.Length;
        [Marker(typeof(` + "$attributeType" + `))]
        [Obsolete("retained")]
        public static int Tagged(this string value) => value.Length;
    }
    public static class Probe
    {
        public static int Run() => "abc".Tagged();
    }
}`)
            let project = Load(source)
            using let native = MemoryStream()
            let emitted = project.Compilation.Emit(native)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            Assert.True(native.Length > int64(0))
            let original = EmittedFixture.Load(native.ToArray())
            Assert.Equal(3, original.GetType("Issue4701.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil))
            let unit = Translate(project)
            let owner = Assert.Single(
                unit.Members.OfType[TypeDeclaration](),
                (type TypeDeclaration) -> type.Name == "Owner"
            )
            Assert.Contains(
                owner.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "Signature"
            )
            Assert.DoesNotContain(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "Signature"
            )
            let helper = Assert.Single(
                owner.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "Tagged"
            )
            Assert.Contains(
                helper.Attributes,
                (attribute AttributeUse) -> attribute.Name.Contains("Marker", StringComparison.Ordinal)
            )
            let companion = Assert.Single(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "Tagged"
            )
            Assert.NotNull(companion.Receiver)
            Assert.DoesNotContain(companion.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
            Assert.DoesNotContain(
                companion.Attributes,
                (attribute AttributeUse) -> attribute.Name.Contains("Marker", StringComparison.Ordinal)
            )
            Assert.Contains(
                companion.Attributes,
                (attribute AttributeUse) -> attribute.Name.Contains("Obsolete", StringComparison.Ordinal)
            )
            return (unit, native.ToArray())
        }

        private func ExtensionNames()[]string -> []string{
            "M",
            "ReturnTagged",
            "ParameterTagged",
            "Create",
            "Apply",
            "Generic",
            "Array",
            "TupleChoice",
            "GenericOwner",
            "GenericTagged",
            "Imported",
            "NestedTagged"
        }

        private func AssertMetadataAndRuntime(assembly Assembly, lifted bool) {
            let owner = Assert.Single(assembly.GetTypes(), (type Type) -> type.FullName == "Issue4701.Owner")
            Assert.True(owner.IsAbstract && owner.IsSealed)
            Assert.True(owner.IsDefined(typeof(ExtensionAttribute), inherit: false))
            Assert.DoesNotContain(assembly.GetExportedTypes(), (type Type) -> type.Name == "<Program>")
            let declarations = assembly
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly
                    )
                }
            )
                .ToArray()
            Assert.NotEmpty(declarations)
            for name in ExtensionNames() {
                let method = Assert.Single(declarations, (method MethodInfo) -> method.Name == name)
                Assert.Equal(owner, method.DeclaringType)
                Assert.True(method.IsDefined(typeof(ExtensionAttribute), inherit: false), name)
                Assert.Equal(
                    name == "Create" ||
                        name == "Apply" ||
                        name == "Generic" ||
                        name == "Array" ||
                        name == "TupleChoice",
                    method.IsPrivate
                )
            }
            // Source delegates intentionally flatten; compare each argument to its actual
            // emitted delegate, not the native nested CLR name. Imports retain CLR identity.
            let callback Type? = if lifted {
                assembly.GetType("Issue4701.Owner_PrivateDelegate")
            } else {
                owner.GetNestedType("PrivateDelegate", BindingFlags.NonPublic)
            }
            Assert.NotNull(callback)
            Assert.False(callback!!.IsVisible)
            Assert.Equal(lifted, !callback!!.IsNested)
            let m = Assert.Single(declarations, (method MethodInfo) -> method.Name == "M")
            Assert.Equal(callback, MarkerType(m.GetCustomAttributesData()))
            Assert.True(m.IsDefined(typeof(ObsoleteAttribute), inherit: false))
            let returned = Assert.Single(declarations, (method MethodInfo) -> method.Name == "ReturnTagged")
            Assert.Equal(callback, MarkerType(returned.ReturnParameter.GetCustomAttributesData()))
            let parameter = Assert.Single(declarations, (method MethodInfo) -> method.Name == "ParameterTagged")
            Assert.Equal(
                callback,
                MarkerType(
                    Assert.Single(parameter.GetParameters(), (p ParameterInfo) -> p.Name == "extra")
                        .GetCustomAttributesData()
                )
            )
            Assert.Equal(
                callback,
                Assert.Single(declarations, (method MethodInfo) -> method.Name == "Create").ReturnType
            )
            Assert.Equal(
                callback,
                Assert
                    .Single(declarations, (method MethodInfo) -> method.Name == "Apply")
                    .GetParameters()[1]
                    .ParameterType
            )
            Assert.Equal(
                callback!!.MakeArrayType(),
                Assert
                    .Single(declarations, (method MethodInfo) -> method.Name == "Array")
                    .GetParameters()[1]
                    .ParameterType
            )
            Assert.Equal(
                callback,
                Assert
                    .Single(declarations, (method MethodInfo) -> method.Name == "TupleChoice")
                    .GetParameters()[1]
                    .ParameterType
                    .GetGenericArguments()[0]
            )
            let generic = Assert.Single(declarations, (method MethodInfo) -> method.Name == "GenericOwner")
            let genericCallback = generic.GetParameters()[1].ParameterType
            Assert.Equal(typeof(int32), genericCallback.GetMethod("Invoke")!!.ReturnType)
            Assert.Equal(
                typeof(int32),
                Assert.Single(genericCallback.GetMethod("Invoke")!!.GetParameters()).ParameterType
            )
            Assert.Equal(
                genericCallback,
                MarkerType(
                    Assert.Single(declarations, (method MethodInfo) -> method.Name == "GenericTagged")
                        .GetCustomAttributesData()
                )
            )
            Assert.Equal(
                typeof(EventHandler),
                MarkerType(
                    Assert.Single(declarations, (method MethodInfo) -> method.Name == "Imported")
                        .GetCustomAttributesData()
                )
            )
            let nestedCallback = MarkerType(
                Assert.Single(declarations, (method MethodInfo) -> method.Name == "NestedTagged")
                    .GetCustomAttributesData()
            )
            Assert.Equal(
                if lifted {
                    "Issue4701.Owner_Container_Callback"
                } else {
                    "Issue4701.Owner+Container+Callback"
                },
                nestedCallback.FullName
            )
            Assert.False(nestedCallback.IsVisible)
            let probe Type? = assembly.GetType("Issue4701.Probe")
            Assert.NotNull(probe)
            let run MethodInfo? = probe!!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(run)
            Assert.Equal("10|29|1|1|3|7|3|3|3|3", run!!.Invoke(nil, nil))
        }

        private func MarkerType(attributes IList[CustomAttributeData]) Type {
            let marker = Assert.Single(
                attributes,
                (attribute CustomAttributeData) -> attribute.AttributeType.Name == "MarkerAttribute"
            )
            return Assert.IsAssignableFrom[Type](Assert.Single(marker.ConstructorArguments).Value)
        }

        private func AssertStrictIl(assembly string) {
            let arguments = List[string]{"tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib"}
            for reference in Directory.EnumerateFiles(
                Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
                "*.dll"
            ) {
                arguments.Add("-r")
                arguments.Add(reference)
            }
            let result = ProcessRunner.Run("dotnet", arguments, IlVerifyRunner().RepoRoot)
            Assert.False(result.TimedOut, result.Output)
            Assert.True(result.ExitCode == 0, result.Output)
        }

        private func AssertCompiled(unit CompilationUnit, nativeImage[]uint8, assert(Assembly) -> void) {
            let printed = GSharpPrinter.Print(unit)
            let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
            Assert.NotNull(compiler)
            let directory = Directory.CreateTempSubdirectory("gs_issue4701_owner_delegate_").FullName
            try {
                let source = Path.Combine(directory, "Delegates.gs")
                let assembly = Path.Combine(directory, "Delegates.dll")
                let nativeAssembly = Path.Combine(directory, "Native.dll")
                File.WriteAllBytes(nativeAssembly, nativeImage)
                AssertStrictIl(nativeAssembly)
                File.WriteAllText(source, printed)
                let compiled = GscInvoker(compiler!!).Compile(
                    []string{source},
                    assembly,
                    TargetKind.Library,
                    Array.Empty[string]()
                )
                Assert.True(compiled.ExitCode == 0, compiled.Output + Environment.NewLine + printed)
                Assert.True(File.Exists(assembly), compiled.Output + Environment.NewLine + printed)
                AssertStrictIl(assembly)
                assert(EmittedFixture.Load(assembly))
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Load(source string) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("DelegateOwner.cs", source)},
                CSharpProjectLoader.RuntimeReferences(),
                "Issue4701.Native"
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            return project
        }

        private func Translate(project LoadedCSharpProject) CompilationUnit {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return unit
        }
    }
}
