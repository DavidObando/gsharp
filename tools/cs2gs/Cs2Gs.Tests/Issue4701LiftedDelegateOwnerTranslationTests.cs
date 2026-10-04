// <copyright file="Issue4701LiftedDelegateOwnerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Lifted source delegates do not split an external extension's owner and attributes.</summary>
[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue4701LiftedDelegateOwnerTranslationTests
{
    private const string Source = """
        using System;

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
        }
        """;

    [Fact]
    public void LiftedDelegates_RetainOwnerAttributesSignaturesAndOnceOnlyEffects()
    {
        LoadedCSharpProject project = Load(Source);
        using var nativeImage = new MemoryStream();
        var emitted = project.Compilation.Emit(nativeImage);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        Assembly native = EmittedFixture.Load(nativeImage.ToArray());
        AssertMetadataAndRuntime(native, lifted: false);

        CompilationUnit unit = Translate(project);
        AssertCompiled(unit, nativeImage.ToArray(), assembly => AssertMetadataAndRuntime(assembly, lifted: true));
    }

    [Theory]
    [InlineData("private delegate Box Callback(int value);", "Callback", "Callback")]
    [InlineData("private delegate void Callback(Box[] values);", "Callback", "Callback")]
    [InlineData("private delegate (Box Value, int Count) Callback(int value);", "Callback", "Callback")]
    [InlineData("private delegate Second Callback(int value); private delegate Box Second(int value);", "Callback", "Callback")]
    [InlineData("", "GenericContainer<Box>.Callback", "GenericContainer<Box>.Callback")]
    public void DelegatesExposingPrivateTypes_KeepHelperAndFilterOnlyInaccessibleAttributes(
        string declaration,
        string attributeType,
        string signatureType)
    {
        (CompilationUnit unit, byte[] nativeImage) = AssertPrivateExposure(declaration, attributeType, signatureType);
        AssertCompiled(unit, nativeImage, assembly =>
        {
            Type emittedOwner = assembly.GetType("Issue4701.Owner");
            Assert.NotNull(emittedOwner);
            MethodInfo signature = emittedOwner.GetMethod("Signature", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(signature);
            Assert.True(signature.IsPrivate);
            MethodInfo tagged = emittedOwner.GetMethod("Tagged");
            Assert.NotNull(tagged);
            Assert.NotNull(MarkerType(tagged.GetCustomAttributesData()));
            Type program = Assert.Single(assembly.GetExportedTypes(), type => type.Name == "<Program>");
            MethodInfo forwarded = program.GetMethod("Tagged");
            Assert.NotNull(forwarded);
            Assert.True(forwarded.IsDefined(typeof(ExtensionAttribute), inherit: false));
            Assert.DoesNotContain(forwarded.GetCustomAttributesData(), attribute => attribute.AttributeType.Name == "MarkerAttribute");
            Assert.True(forwarded.IsDefined(typeof(ObsoleteAttribute), inherit: false));
            Assert.DoesNotContain(
                assembly.GetExportedTypes().SelectMany(type => type.GetMethods()),
                method => method.Name == "Signature");
            Assert.Equal(3, assembly.GetType("Issue4701.Probe").GetMethod("Run").Invoke(null, null));
        });
    }

    [Theory]
    [InlineData("private delegate T Callback<T>(T value) where T : Box;", "Callback<>", "Callback<Box>")]
    [InlineData("private delegate T Callback<T>(T value) where T : Box;", "Callback<Box>", "Callback<Box>")]
    [InlineData("private delegate Callback Callback(Callback other, Box value);", "Callback", "Callback")]
    public void DelegateBoundaryGaps_PreserveNativeValidPrivateExposurePolicy(
        string declaration,
        string attributeType,
        string signatureType)
    {
        // Policy-only controls (#4757/#4758/#4759): typeof and private constraints
        // have independent naming, compiler-recursion and CLR-accessibility gaps.
        AssertPrivateExposure(declaration, attributeType, signatureType);
    }

    private static (CompilationUnit Unit, byte[] NativeImage) AssertPrivateExposure(
        string declaration,
        string attributeType,
        string signatureType)
    {
        string source = $$"""
            using System;
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
                    {{declaration}}
                    private static int Signature(this string value, {{signatureType}} callback) => value.Length;
                    [Marker(typeof({{attributeType}}))]
                    [Obsolete("retained")]
                    public static int Tagged(this string value) => value.Length;
                }
                public static class Probe
                {
                    public static int Run() => "abc".Tagged();
                }
            }
            """;
        LoadedCSharpProject project = Load(source);
        using var native = new MemoryStream();
        var emitted = project.Compilation.Emit(native);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        Assert.True(native.Length > 0);
        Assembly original = EmittedFixture.Load(native.ToArray());
        Assert.Equal(3, original.GetType("Issue4701.Probe").GetMethod("Run").Invoke(null, null));

        CompilationUnit unit = Translate(project);
        TypeDeclaration owner = Assert.Single(unit.Members.OfType<TypeDeclaration>(), type => type.Name == "Owner");
        Assert.Contains(owner.Members.OfType<MethodDeclaration>(), method => method.Name == "Signature");
        Assert.DoesNotContain(unit.Members.OfType<MethodDeclaration>(), method => method.Name == "Signature");
        MethodDeclaration helper = Assert.Single(owner.Members.OfType<MethodDeclaration>(), method => method.Name == "Tagged");
        Assert.Contains(helper.Attributes, attribute => attribute.Name.Contains("Marker", StringComparison.Ordinal));
        MethodDeclaration companion = Assert.Single(unit.Members.OfType<MethodDeclaration>(), method => method.Name == "Tagged");
        Assert.NotNull(companion.Receiver);
        Assert.DoesNotContain(companion.Attributes, attribute => attribute.Name == "ExtensionOwner");
        Assert.DoesNotContain(companion.Attributes, attribute => attribute.Name.Contains("Marker", StringComparison.Ordinal));
        Assert.Contains(companion.Attributes, attribute => attribute.Name.Contains("Obsolete", StringComparison.Ordinal));
        return (unit, native.ToArray());
    }

    [Fact]
    public void ExpandingGenericDelegate_PolicyVisitsDefinitionAndActualArguments()
    {
        const string source = """
            using System;
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
            }
            """;
        LoadedCSharpProject project = Load(source);
        using var native = new MemoryStream();
        var emitted = project.Compilation.Emit(native);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        Assert.True(native.Length > 0);
        Assembly original = EmittedFixture.Load(native.ToArray());
        Assert.Equal(6, original.GetType("Issue4701.Probe").GetMethod("Run").Invoke(null, null));

        // gsc's recursive-delegate typeof query is tracked in #4757. This
        // native-valid control exercises the actual translator exposure policy.
        CompilationUnit unit = Translate(project);
        TypeDeclaration owner = Assert.Single(unit.Members.OfType<TypeDeclaration>(), type => type.Name == "Owner");
        MethodDeclaration safe = Assert.Single(unit.Members.OfType<MethodDeclaration>(), method => method.Name == "Safe");
        Assert.Contains(safe.Attributes, attribute => attribute.Name == "ExtensionOwner");
        Assert.Contains(safe.Attributes, attribute => attribute.Name.Contains("Marker", StringComparison.Ordinal));
        Assert.DoesNotContain(owner.Members.OfType<MethodDeclaration>(), method => method.Name == "Safe");
        Assert.Contains(owner.Members.OfType<MethodDeclaration>(), method => method.Name == "Unsafe");
        MethodDeclaration unsafeCompanion = Assert.Single(unit.Members.OfType<MethodDeclaration>(), method => method.Name == "Unsafe");
        Assert.DoesNotContain(unsafeCompanion.Attributes, attribute => attribute.Name.Contains("Marker", StringComparison.Ordinal));
        Assert.DoesNotContain(unsafeCompanion.Attributes, attribute => attribute.Name == "ExtensionOwner");
    }

    [Fact]
    public void ImportedPrivateDelegate_DoesNotAcquireSourceLiftingAccessibility()
    {
        LoadedCSharpProject source = Load(Source);
        using var image = new MemoryStream();
        var emitted = source.Compilation.Emit(image);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        CSharpCompilation consumer = CSharpCompilation.Create(
            "Issue4701.Import",
            references: CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromImage(image.ToArray())),
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithMetadataImportOptions(MetadataImportOptions.All));
        INamedTypeSymbol sourceOwner = source.Compilation.GetTypeByMetadataName("Issue4701.Owner");
        INamedTypeSymbol importedOwner = consumer.GetTypeByMetadataName("Issue4701.Owner");
        Assert.NotNull(sourceOwner);
        Assert.NotNull(importedOwner);
        INamedTypeSymbol sourceDelegate = Assert.Single(sourceOwner.GetTypeMembers("PrivateDelegate"));
        INamedTypeSymbol importedDelegate = Assert.Single(importedOwner.GetTypeMembers("PrivateDelegate"));
        Assert.Equal(Accessibility.Private, importedDelegate.DeclaredAccessibility);
        Assert.DoesNotContain(importedDelegate.Locations, location => location.IsInSource);

        // A policy-unit control for imported metadata; the source side's full
        // translation/emission/consumer/runtime path is exercised above.
        MethodInfo exposure = Assert.Single(
            typeof(CSharpToGSharpTranslator).GetMethods(BindingFlags.NonPublic | BindingFlags.Static),
            method => method.Name == "NamesPrivateNestedType" && method.GetParameters().Length == 2);
        Assert.Equal(false, exposure.Invoke(null, new object[] { sourceDelegate, sourceOwner }));
        Assert.Equal(true, exposure.Invoke(null, new object[] { importedDelegate, importedOwner }));
    }

    private static string[] ExtensionNames() => new[]
    {
        "M", "ReturnTagged", "ParameterTagged", "Create", "Apply", "Generic", "Array",
        "TupleChoice", "GenericOwner", "GenericTagged", "Imported", "NestedTagged",
    };

    private static void AssertMetadataAndRuntime(Assembly assembly, bool lifted)
    {
        Type owner = Assert.Single(assembly.GetTypes(), type => type.FullName == "Issue4701.Owner");
        Assert.True(owner.IsAbstract && owner.IsSealed);
        Assert.True(owner.IsDefined(typeof(ExtensionAttribute), inherit: false));
        Assert.DoesNotContain(assembly.GetExportedTypes(), type => type.Name == "<Program>");
        MethodInfo[] declarations = assembly.GetTypes().SelectMany(type =>
            type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.DeclaredOnly)).ToArray();
        Assert.NotEmpty(declarations);
        foreach (string name in ExtensionNames())
        {
            MethodInfo method = Assert.Single(declarations, method => method.Name == name);
            Assert.Equal(owner, method.DeclaringType);
            Assert.True(method.IsDefined(typeof(ExtensionAttribute), inherit: false), name);
            Assert.Equal(
                name is "Create" or "Apply" or "Generic" or "Array" or "TupleChoice",
                method.IsPrivate);
        }

        // Source delegates intentionally flatten; compare each argument to its actual
        // emitted delegate, not the native nested CLR name. Imports retain CLR identity.
        Type callback = lifted
            ? assembly.GetType("Issue4701.Owner_PrivateDelegate")
            : owner.GetNestedType("PrivateDelegate", BindingFlags.NonPublic);
        Assert.NotNull(callback);
        Assert.False(callback.IsVisible);
        Assert.Equal(lifted, !callback.IsNested);
        MethodInfo m = Assert.Single(declarations, method => method.Name == "M");
        Assert.Equal(callback, MarkerType(m.GetCustomAttributesData()));
        Assert.True(m.IsDefined(typeof(ObsoleteAttribute), inherit: false));
        MethodInfo returned = Assert.Single(declarations, method => method.Name == "ReturnTagged");
        Assert.Equal(callback, MarkerType(returned.ReturnParameter.GetCustomAttributesData()));
        MethodInfo parameter = Assert.Single(declarations, method => method.Name == "ParameterTagged");
        Assert.Equal(callback, MarkerType(Assert.Single(parameter.GetParameters(), p => p.Name == "extra").GetCustomAttributesData()));
        Assert.Equal(callback, Assert.Single(declarations, method => method.Name == "Create").ReturnType);
        Assert.Equal(callback, Assert.Single(declarations, method => method.Name == "Apply").GetParameters()[1].ParameterType);
        Assert.Equal(callback.MakeArrayType(), Assert.Single(declarations, method => method.Name == "Array").GetParameters()[1].ParameterType);
        Assert.Equal(
            callback,
            Assert.Single(declarations, method => method.Name == "TupleChoice").GetParameters()[1].ParameterType.GetGenericArguments()[0]);

        MethodInfo generic = Assert.Single(declarations, method => method.Name == "GenericOwner");
        Type genericCallback = generic.GetParameters()[1].ParameterType;
        Assert.Equal(typeof(int), genericCallback.GetMethod("Invoke").ReturnType);
        Assert.Equal(typeof(int), Assert.Single(genericCallback.GetMethod("Invoke").GetParameters()).ParameterType);
        Assert.Equal(genericCallback, MarkerType(Assert.Single(declarations, method => method.Name == "GenericTagged").GetCustomAttributesData()));
        Assert.Equal(typeof(EventHandler), MarkerType(Assert.Single(declarations, method => method.Name == "Imported").GetCustomAttributesData()));
        Type nestedCallback = MarkerType(Assert.Single(declarations, method => method.Name == "NestedTagged").GetCustomAttributesData());
        Assert.Equal(
            lifted ? "Issue4701.Owner_Container_Callback" : "Issue4701.Owner+Container+Callback",
            nestedCallback.FullName);
        Assert.False(nestedCallback.IsVisible);

        Type probe = assembly.GetType("Issue4701.Probe");
        Assert.NotNull(probe);
        MethodInfo run = probe.GetMethod("Run", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(run);
        Assert.Equal("10|29|1|1|3|7|3|3|3|3", run.Invoke(null, null));
    }

    private static Type MarkerType(IList<CustomAttributeData> attributes)
    {
        CustomAttributeData marker = Assert.Single(attributes, attribute => attribute.AttributeType.Name == "MarkerAttribute");
        return Assert.IsAssignableFrom<Type>(Assert.Single(marker.ConstructorArguments).Value);
    }

    private static void AssertStrictIl(string assembly)
    {
        var arguments = new List<string>
        {
            "tool", "run", "ilverify", assembly, "-s", "System.Private.CoreLib",
        };
        foreach (string reference in Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll"))
        {
            arguments.Add("-r");
            arguments.Add(reference);
        }

        ProcessRunResult result = ProcessRunner.Run("dotnet", arguments, new IlVerifyRunner().RepoRoot);
        Assert.False(result.TimedOut, result.Output);
        Assert.True(result.ExitCode == 0, result.Output);
    }

    private static void AssertCompiled(CompilationUnit unit, byte[] nativeImage, Action<Assembly> assert)
    {
        string printed = GSharpPrinter.Print(unit);
        string compiler = GscInvoker.Resolve(null, "Release", AppContext.BaseDirectory);
        Assert.NotNull(compiler);
        string directory = Directory.CreateTempSubdirectory("gs_issue4701_owner_delegate_").FullName;
        try
        {
            string source = Path.Combine(directory, "Delegates.gs");
            string assembly = Path.Combine(directory, "Delegates.dll");
            string nativeAssembly = Path.Combine(directory, "Native.dll");
            File.WriteAllBytes(nativeAssembly, nativeImage);
            AssertStrictIl(nativeAssembly);
            File.WriteAllText(source, printed);
            GscResult compiled = new GscInvoker(compiler).Compile(
                new[] { source }, assembly, TargetKind.Library, System.Array.Empty<string>());
            Assert.True(compiled.ExitCode == 0, compiled.Output + Environment.NewLine + printed);
            Assert.True(File.Exists(assembly), compiled.Output + Environment.NewLine + printed);
            AssertStrictIl(assembly);
            assert(EmittedFixture.Load(assembly));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static LoadedCSharpProject Load(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("DelegateOwner.cs", source) }, CSharpProjectLoader.RuntimeReferences(), "Issue4701.Native");
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static CompilationUnit Translate(LoadedCSharpProject project)
    {
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return unit;
    }
}
