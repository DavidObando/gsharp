// <copyright file="Issue3413NestedPrivateClassTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import Xunit

/// Issue #3413 nested private class declaration preservation.
@Collection("IlVerifyPipeline")
class Issue3413NestedPrivateClassTranslationTests {
    @Fact
    func PipelineFailureDetails_MissingArtifactPreservesOriginalFailure() {
        let result = RunResult{RunId: "missing-run"}
        let app = AppResult{Stages: {StageResult{Stage: "compile", Status: "failed"}}, Artifacts: {"missing.json"}}
        let details = PipelineFailureDetails(AppContext.BaseDirectory, result, app)
        Assert.Contains("compile=failed", details, StringComparison.Ordinal)
        Assert.Contains("Artifact unavailable:", details, StringComparison.Ordinal)
    }

    @Fact
    func EntryAndGenericNestedClasses_RetainStructuralOwnersAndPrivateVisibility() {
        let (unit, context) = Translate(Source)
        let program = unit.Members.OfType[TypeDeclaration]().Single((type TypeDeclaration) -> type.Name == "Program")
        let entryHelper = program
            .Members
            .OfType[TypeDeclaration]()
            .Single((type TypeDeclaration) -> type.Name == "EntryHelper")
        Assert.Equal(Visibility.Private, entryHelper.Visibility)
        Assert.Single(entryHelper.TypeParameters!!)
        Assert.Contains(
            SharedMembers(program).OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Main"
        )
        let genericOwner = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((type TypeDeclaration) -> type.Name == "GenericOwner")
        let genericHelper = genericOwner
            .Members
            .OfType[TypeDeclaration]()
            .Single((type TypeDeclaration) -> type.Name == "Helper")
        Assert.Equal(Visibility.Private, genericHelper.Visibility)
        Assert.Single(genericOwner.TypeParameters!!)
        Assert.Single(genericHelper.TypeParameters!!)
        Assert.DoesNotContain(
            unit.Members.OfType[TypeDeclaration](),
            (type TypeDeclaration) -> (type.Name is "EntryHelper" or "Helper")
        )
        let extensionOwner = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((type TypeDeclaration) -> type.Name == "ExtensionOwner")
        let cache = Assert.Single(extensionOwner.Members.OfType[TypeDeclaration]())
        Assert.Equal("Cache", cache.Name)
        Assert.Equal(Visibility.Private, cache.Visibility)
        Assert.Single(cache.TypeParameters!!)
        let extensionShared = SharedMembers(extensionOwner)
        Assert.Equal(
            Visibility.Private,
            extensionShared
                .OfType[FieldDeclaration]()
                .Single((field FieldDeclaration) -> field.Name == "cache")
                .Visibility
        )
        // Issue #4676: an extension on an EXTERNAL receiver (`this T`, `int`, `string`)
        // is lifted with its real body and hosted on the owner through
        // `@ExtensionOwner`, which reaches the owner's private nested type and
        // field. It is not kept as an in-owner helper plus a public forwarding
        // companion on the package's `<Program>`.
        let extensionNames[]string = []string{
            "Identity",
            "AddCached",
            "DelayIdentityAsync",
            "DelayAsync",
            "LengthAsync",
            "DelayTextAsync",
            "ValueAsync",
            "ValueNoteAsync",
            "ValueLengthAsync",
            "ValueDelayAsync"
        }
        for name in extensionNames {
            let lifted = Assert.Single(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == name
            )
            Assert.NotNull(lifted.Receiver)
            Assert.Contains(lifted.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
            Assert.True(lifted.Body != nil || lifted.ExpressionBody != nil, name)
            Assert.DoesNotContain(
                extensionShared.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == name
            )
        }
        let rendered = GSharpPrinter.Print(unit)
        Assert.Contains("private class EntryHelper[T]", rendered, StringComparison.Ordinal)
        Assert.Contains("private class Cache[T]", rendered, StringComparison.Ordinal)
        Assert.Contains("private var cache Cache[int32]", rendered, StringComparison.Ordinal)
        Assert.Contains("func (value T) Identity[T]() T -> Cache[T].Echo(value)", rendered, StringComparison.Ordinal)
        Assert.Contains(
            "func (value int32) AddCached() int32 -> value + ExtensionOwner.cache.Value",
            rendered,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("ExtensionOwner.Identity", rendered, StringComparison.Ordinal)
        Assert.Contains("class GenericOwner[TOuter]", rendered, StringComparison.Ordinal)
        // Issue #4674: `Helper` is a C# `sealed` class whose `protected override`
        // members take their accessibility from the base, so it stays non-`open`.
        Assert.Contains("private class Helper[TInner]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("open class Helper[TInner]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(
            context.Diagnostics,
            (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
        )
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ExtensionUsingPrivateNestedGenericHelper_IsHostedOnItsOwnerAndBinds() {
        const source = `using System;

namespace Issue3413
{
    public static class Program
    {
        public static void Main() => Console.WriteLine(42.Identity());
    }

    public static class ExtensionOwner
    {
        private static class Cache<T>
        {
            public static T Echo(T value) => value;
        }

        public static T Identity<T>(this T value) => Cache<T>.Echo(value);
    }
}`
        let (unit, _) = Translate(source)
        let owner = unit
            .Members
            .OfType[TypeDeclaration]()
            .Single((type TypeDeclaration) -> type.Name == "ExtensionOwner")
        let cache = Assert.Single(owner.Members.OfType[TypeDeclaration]())
        let rendered = GSharpPrinter.Print(unit)
        TranslationTestValidation.AssertBinds(rendered)
        Assert.Equal(Visibility.Private, cache.Visibility)
        // Issue #4676: the real body is lifted and hosted on the owner; the owner keeps
        // no `Identity` helper and the package gets no forwarding companion.
        Assert.Empty(SharedMembers(owner).OfType[MethodDeclaration]())
        let identity = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Identity"
        )
        Assert.Contains(identity.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
        Assert.Contains("private shared class Cache[T]", rendered, StringComparison.Ordinal)
        Assert.Contains("@ExtensionOwner(typeof(ExtensionOwner))", rendered, StringComparison.Ordinal)
        Assert.Contains("func (value T) Identity[T]() T -> Cache[T].Echo(value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("ExtensionOwner.Identity", rendered, StringComparison.Ordinal)
    }

    @Fact
    func PrivateExtensionWhoseSignatureOrAttributesNameAPrivateNestedType_StaysAnInOwnerHelper() {
        // gsc binds a function's receiver, parameter and return types, and its attributes
        // (`[Marker(typeof(Box))]`), before it resolves `@ExtensionOwner`, so a lifted function could not name the private `Box`; the
        // in-owner helper can. (A public method cannot expose a private type, so such a
        // method is never API.) A method whose signature names no private nested type is
        // still lifted and hosted on its owner.
        const source = `using System;
using System.Collections.Generic;

namespace Issue3413
{
    public static class Program
    {
        public static void Main() => Console.WriteLine(Owner.Run("ok"));
    }

    public sealed class Outer<T>
    {
        public sealed class Inner
        {
        }
    }

    [AttributeUsage(AttributeTargets.Method | AttributeTargets.ReturnValue | AttributeTargets.Parameter | AttributeTargets.GenericParameter)]
    public sealed class MarkerAttribute : Attribute
    {
        public MarkerAttribute(Type type)
        {
            Type = type;
        }

        public MarkerAttribute(object value)
        {
            Value = value;
        }

        public MarkerAttribute(Type[] types)
        {
            Types = types;
        }

        public Type[] Types { get; }

        public Type Type { get; }

        public object Value { get; }
    }

    public static class Owner
    {
        private sealed class Box
        {
            public int N;
        }

        private enum Mode
        {
            Fast,
        }

        [Marker(typeof(Box))]
        private static int Tagged(this string value) => 1;

        [Marker(typeof(Box))]
        public static int PublicTagged(this string value) => 4;

        [return: Marker(typeof(Box))]
        public static int PublicReturnTagged(this string value) => 6;

        public static int PublicParameterTagged(this string value, [Marker(typeof(Box))] int x) => 7;

        [Marker(typeof(Box))]
        [Obsolete("use something else")]
        public static int PublicTaggedAndObsolete(this string value, [Marker(typeof(Box))] [System.Diagnostics.CodeAnalysis.NotNull] string note) => 9;

        public static int GenericTagged<[Marker(typeof(Box))] T>(this string value, T item) => 10;

        [Marker((Type[])null)]
        private static int NullArray(this string value) => 5;

        [Marker(Mode.Fast)]
        private static int Moded(this string value) => 2;

        [Marker(new object[] { new[] { Mode.Fast } })]
        private static int Nested(this string value) => 3;

        private static Box Make(this string value, Box seed) => seed;

        private static int Deep(this string value, Outer<Box>.Inner arg) => 8;

        private static int Count(this string value, List<Box> boxes) => boxes.Count;

        private static int Sum(this string value, Box[] boxes) => boxes.Length;

        public static string Echo(this string value) => value;

        public static int Run(string value) =>
            value.Make(new Box()).N + value.Deep(new Outer<Box>.Inner()) + value.Count(new List<Box>()) + value.Sum(new Box[0]) + value.Tagged() + value.Moded() + value.Nested() + value.PublicTagged() + value.PublicReturnTagged() + value.PublicParameterTagged(1) + value.PublicTaggedAndObsolete("") + value.GenericTagged(1) + value.NullArray();
    }
}`
        let (unit, _) = Translate(source)
        let rendered = GSharpPrinter.Print(unit)
        let owner = unit.Members.OfType[TypeDeclaration]().Single((type TypeDeclaration) -> type.Name == "Owner")
        let shared = SharedMembers(owner)
        for name in[]string{"Make", "Count", "Sum", "Deep", "Tagged", "Moded", "Nested"} {
            Assert.Contains(shared.OfType[MethodDeclaration](), (method MethodDeclaration) -> method.Name == name)
            Assert.DoesNotContain(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == name
            )
        }
        // A PUBLIC extension whose only mention of the private type is an attribute (method,
        // return or parameter target) is legal C# and API: it keeps the in-owner helper, with
        // its attributes, AND its public forwarding companion (so it is still discoverable as an
        // extension), and the companion, at top level where `Box` is out of scope, carries none
        // of the source attributes.
        for name in[]string{"PublicTagged", "PublicReturnTagged", "PublicParameterTagged"} {
            let publicHelper = Assert.Single(
                shared.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == name
            )
            Assert.NotEmpty(
                publicHelper.Attributes.Concat(
                    publicHelper.Parameters.SelectMany(
                        func (parameter Parameter) IEnumerable[AttributeUse] {
                            return parameter.Attributes
                        }
                    )
                )
            )
            let companion = Assert.Single(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == name
            )
            Assert.NotNull(companion.Receiver)
            Assert.Empty(companion.Attributes)
            Assert.Empty(
                companion.Parameters.SelectMany(
                    func (parameter Parameter) IEnumerable[AttributeUse] {
                        return parameter.Attributes
                    }
                )
            )
        }
        // A type-parameter attribute is not translated, so it does not pull the extension into
        // the helper scheme: it is lifted onto the owner like any other external-receiver extension.
        Assert.DoesNotContain(
            shared.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "GenericTagged"
        )
        Assert.Contains(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "GenericTagged"
        )
        // Only the attributes that name the private type are left off the companion: an unrelated
        // API-significant attribute in the same position survives (method and parameter).
        let obsoleteCompanion = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "PublicTaggedAndObsolete"
        )
        Assert.Contains(obsoleteCompanion.Attributes, (attribute AttributeUse) -> attribute.Name.Contains("Obsolete"))
        Assert.DoesNotContain(
            obsoleteCompanion.Attributes,
            (attribute AttributeUse) -> attribute.Name.Contains("Marker")
        )
        let noteParameter = Assert.Single(
            obsoleteCompanion.Parameters,
            (parameter Parameter) -> parameter.Name == "note"
        )
        Assert.Contains(noteParameter.Attributes, (attribute AttributeUse) -> attribute.Name.Contains("NotNull"))
        Assert.DoesNotContain(noteParameter.Attributes, (attribute AttributeUse) -> attribute.Name.Contains("Marker"))
        // A null array argument (`[Marker(null)]` for a `Type[]` parameter) names no type and
        // must not break the check (its `Values` is the default array): the method is lifted.
        Assert.Contains(
            Assert.Single(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == "NullArray"
            )
                .Attributes,
            (attribute AttributeUse) -> attribute.Name == "ExtensionOwner"
        )
        let echo = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Echo"
        )
        Assert.Contains(echo.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func PrivateExtensionOnExternalReceiver_IsLiftedAndHostedOnItsOwner() {
        const source = `using System;

namespace Issue3413
{
    public static class Program
    {
        public static void Main() => Console.WriteLine(Owner.Run("ok"));
    }

    public static class Owner
    {
        private sealed class Cache
        {
        }

        private static string Secret(this string value) => value + "!";

        public static string Run(string value) => value.Secret();
    }
}`
        let (unit, _) = Translate(source)
        let rendered = GSharpPrinter.Print(unit)
        let owner = unit.Members.OfType[TypeDeclaration]().Single((type TypeDeclaration) -> type.Name == "Owner")
        // Issue #4676: a `private` extension on an external receiver is lifted like
        // any other and hosted on its owner, where the owner's own `Run` still
        // reaches it. It stays `private`, so it is not API.
        let secret = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Secret"
        )
        Assert.Equal(Visibility.Private, secret.Visibility)
        Assert.Contains(secret.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
        Assert.DoesNotContain(
            SharedMembers(owner).OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Secret"
        )
        Assert.Contains("func Run(value string) string -> value.Secret()", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func OwnerScoped_ExtensionsRespectInstanceCollisionsAndKeepTheirNames() {
        const source = `using System;

namespace Issue3413
{
    public static class Program
    {
        public static void Main() => Console.WriteLine(new Host().Describe());
    }

    public sealed class Host
    {
        public string Describe() => "instance";

        public string func_() => "instance keyword";
    }

    public static class OwnerScoped
    {
        private sealed class Cache
        {
        }

        public static string Describe(this Host host) => "extension";

        public static string Format(this string value) => "owner";

        public static string @func(this Host host) => "extension keyword";

        public static string @func(this string value) => "owner keyword";
    }

    public static class Sibling
    {
        public static string Shout(this string value) => "sibling";

        public static string func_(this string value) => "sibling keyword";
    }
}`
        let (unit, _) = Translate(source)
        let rendered = GSharpPrinter.Print(unit)
        let owner = unit.Members.OfType[TypeDeclaration]().Single((type TypeDeclaration) -> type.Name == "OwnerScoped")
        let shared = SharedMembers(owner)
        // The receiver `Host` is OWNED by the project, so an extension on it is moved
        // into `Host` and could not reach the owner's private nested type: that case
        // keeps the owner-scoped scheme. `Describe` collides with `Host`'s own
        // instance method, so it stays an in-owner static helper.
        Assert.Contains(shared.OfType[MethodDeclaration](), (method MethodDeclaration) -> method.Name == "Describe")
        Assert.DoesNotContain(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Describe"
        )
        // Issue #4676: an extension on an EXTERNAL receiver is lifted and hosted on its
        // owner; the owner keeps no helper copy.
        Assert.DoesNotContain(shared.OfType[MethodDeclaration](), (method MethodDeclaration) -> method.Name == "Format")
        let format = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Format"
        )
        Assert.Contains(format.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
        let shout = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "Shout"
        )
        Assert.Contains(shout.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
        Assert.Single(unit.Members.OfType[MethodDeclaration](), (method MethodDeclaration) -> method.Name == "func_")
        Assert.DoesNotContain(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "func__"
        )
        // ADR-0170: the metadata-visible `@func` extension keeps its CLR name via the
        // escape; the legal func_ members keep their own names.
        let externalEscaped = Assert.Single(
            unit.Members.OfType[MethodDeclaration](),
            (method MethodDeclaration) -> method.Name == "$$func" && method.Attributes.Any(
                (attribute AttributeUse) -> attribute.Name == "ExtensionOwner"
            )
        )
        Assert.Equal("string", GSharpPrinter.RenderTypeReference(externalEscaped.Receiver!!.Type))
        Assert.Contains(shared.OfType[MethodDeclaration](), (method MethodDeclaration) -> method.Name == "$$func")
        Assert.Contains("OwnerScoped.$$func(host)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func PrivateNestedOwners_InSiblingProjects_EachHostTheirOwnExtension() {
        let first = CSharpProjectLoader.LoadInMemory([](string, string){("First.cs", `namespace Shared;

public static class First
{
    private sealed class Cache
    {
    }

    public static object Convert(this object value, dynamic argument) => argument;
}`)}, CSharpProjectLoader.RuntimeReferences(), "Z.Dependency")
        Assert.True(first.BoundWithoutErrors, string.Join(Environment.NewLine, first.ErrorDiagnostics))
        using let firstImage = MemoryStream()
        let firstEmit = first.Compilation.Emit(firstImage)
        Assert.True(firstEmit.Success, string.Join(Environment.NewLine, firstEmit.Diagnostics))
        let firstReference MetadataReference = MetadataReference.CreateFromImage(firstImage.ToArray())
        let second = CSharpProjectLoader.LoadInMemory([](string, string){("Second.cs", `namespace Shared;

public static class Second
{
    private sealed class Cache
    {
    }

    public static object Convert(this object value, object argument) => argument;
}`)}, CSharpProjectLoader.RuntimeReferences().Append(firstReference).ToList(), "A.Dependent")
        Assert.True(second.BoundWithoutErrors, string.Join(Environment.NewLine, second.ErrorDiagnostics))
        let printedFirst = TranslateProject(first, []CSharpCompilation{first.Compilation})
        let printedSecond = TranslateProject(second, []CSharpCompilation{first.Compilation, second.Compilation})
        // Issue #4676: extensions on an EXTERNAL receiver (`object`) are not forwarded
        // through a companion any more, so there is no cross-project companion to
        // deduplicate: each project hosts its own function on its own owner, exactly
        // like the two C# methods, and each project binds.
        Assert.Contains("@ExtensionOwner(typeof(First))", printedFirst, StringComparison.Ordinal)
        Assert.Contains("func (value object) Convert(argument object) object", printedFirst, StringComparison.Ordinal)
        Assert.Contains("@ExtensionOwner(typeof(Second))", printedSecond, StringComparison.Ordinal)
        Assert.Contains("func (value object) Convert(argument object) object", printedSecond, StringComparison.Ordinal)
        Assert.DoesNotContain("First.Convert", printedFirst + printedSecond, StringComparison.Ordinal)
        Assert.DoesNotContain("Second.Convert", printedFirst + printedSecond, StringComparison.Ordinal)
        // They are separate assemblies, so each binds on its own (binding them together
        // would put both `Convert(object, object)` in one package).
        TranslationTestValidation.AssertBinds(printedFirst)
        TranslationTestValidation.AssertBinds(printedSecond)
    }

    @Fact
    func ExtensionsOnNonPublicAndExternOwners_AreHostedOnTheirOwners() {
        const source = `using System;
using System.Runtime.InteropServices;

namespace Issue3413
{
    public static class Program
    {
        public static void Main()
        {
            Console.WriteLine("a".InternalEcho());
            Console.WriteLine("b".FileEcho());
        }
    }

    internal static class InternalOwner
    {
        private sealed class Cache
        {
        }

        public static string InternalEcho(this string value) => value;
    }

    file static class FileOwner
    {
        private sealed class Cache
        {
        }

        public static string FileEcho(this string value) => value;
    }

    public static class NativeOwner
    {
        private sealed class Cache
        {
        }

        [DllImport("libc")]
        public static extern int NativeAbs(this int value);
    }
}`
        let (unit, _) = Translate(source)
        let rendered = GSharpPrinter.Print(unit)
        // Issue #4676: internal, file-local and P/Invoke extension owners need no
        // special case; each extension is lifted and hosted on its own owner, so
        // none leaves a public forwarding companion behind.
        for (name, owner) in[](string, string){
            ("InternalEcho", "InternalOwner"),
            ("FileEcho", "FileOwner"),
            ("NativeAbs", "NativeOwner")
        } {
            let lifted = Assert.Single(
                unit.Members.OfType[MethodDeclaration](),
                (method MethodDeclaration) -> method.Name == name
            )
            Assert.Contains(lifted.Attributes, (attribute AttributeUse) -> attribute.Name == "ExtensionOwner")
            Assert.Contains("@ExtensionOwner(typeof($owner))", rendered, StringComparison.Ordinal)
        }
        Assert.Contains("func (value string) InternalEcho() string -> value", rendered, StringComparison.Ordinal)
        Assert.Contains("func (value int32) NativeAbs() int32;", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("InternalOwner.InternalEcho", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("FileOwner.FileEcho", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    async func Pipeline_CompilesVerifiesRunsAndEmitsNestedPrivateGenericMetadata() {
        let compiler string? = FindCompiler()
        if compiler == nil || !IlVerifyToolAvailable() {
            return
        }
        let sourceRoot = NewDirectory("scratch-projects")
        File.WriteAllText(Path.Combine(sourceRoot, "Directory.Build.props"), "<Project></Project>")
        let projectDirectory = Path.Combine(sourceRoot, "Issue3413")
        Directory.CreateDirectory(projectDirectory)
        let projectPath = Path.Combine(projectDirectory, "Issue3413.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`)
        File.WriteAllText(Path.Combine(projectDirectory, "Program.cs"), Source)
        let goldenPath = Path.Combine(projectDirectory, "baseline.stdout.golden")
        File.WriteAllText(goldenPath, `42
1
42
6
4
9
4
async
`)
        let outputRoot = NewDirectory("pipeline-tests")
        let app = CorpusApp("test/Issue3413", projectPath, TargetKind.Exe, stdoutGolden: goldenPath)
        let pipeline = MigrationPipeline(
            PipelineOptions{
                GscPath: compiler,
                OutputRoot: outputRoot,
                SourceRoot: sourceRoot,
                Config: "Release",
                CompileViaSdk: false
            },
            []IMigrationStage{TranslateStage(), CompileStage(), IlVerifyStage(), TestParityStage()}
        )
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        let appDirectory = Path.Combine(outputRoot, result.RunId, MigrationPipeline.SanitizeAppId(app.Id))
        let translated = string.Join(
            Environment.NewLine,
            Directory.GetFiles(appDirectory, "*.gs", SearchOption.AllDirectories).Select(File.ReadAllText)
        )
        Assert.Contains("class Program", translated, StringComparison.Ordinal)
        Assert.Contains("private class EntryHelper[T]", translated, StringComparison.Ordinal)
        Assert.Contains("private class Cache[T]", translated, StringComparison.Ordinal)
        // Issue #4676: every extension on the owner is one lifted function hosted on it
        // through `@ExtensionOwner`; no helper copy and no forwarding companion. (A
        // bound method group of an async extension, `Func<Task<int>> f = "x".M;`,
        // is a separate gsc gap, #4699, so the fixture calls them directly.)
        Assert.Contains("@ExtensionOwner(typeof(ExtensionOwner))", translated, StringComparison.Ordinal)
        Assert.Contains("async func (value T) DelayIdentityAsync[T]() T", translated, StringComparison.Ordinal)
        Assert.Contains("return Cache[T].Echo(value)", translated, StringComparison.Ordinal)
        Assert.Contains("async func (value int32) ValueAsync() ValueTask[int32]", translated, StringComparison.Ordinal)
        Assert.Contains("async func (value int32) ValueNoteAsync() ValueTask", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("ExtensionOwner.DelayIdentityAsync", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("ExtensionOwner.ValueAsync", translated, StringComparison.Ordinal)
        Assert.Contains("class GenericOwner[TOuter]", translated, StringComparison.Ordinal)
        Assert.Contains("private class Helper[TInner]", translated, StringComparison.Ordinal)
        Assert.DoesNotContain("open class Helper[TInner]", translated, StringComparison.Ordinal)
        if !appResult.Succeeded {
            Assert.Fail(PipelineFailureDetails(outputRoot, result, appResult))
        }
        Assert.Equal(
            []string{"passed", "passed", "passed", "passed"},
            appResult.Stages.Select((stage StageResult) -> stage.Status).ToArray()
        )
        let assemblyPath = Path.Combine(appDirectory, "Issue3413.dll")
        Assert.True(File.Exists(assemblyPath), "Expected emitted assembly at '$assemblyPath'.")
        let assembly = Assembly.Load(File.ReadAllBytes(assemblyPath))
        let program = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Program")
        Assert.Equal(program, assembly.EntryPoint?.DeclaringType)
        let entryHelper = Assert.Single(
            program.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            (type Type) -> type.Name.StartsWith("EntryHelper", StringComparison.Ordinal)
        )
        Assert.True(entryHelper.IsNestedPrivate)
        Assert.Equal(program, entryHelper.DeclaringType)
        Assert.Single(entryHelper.GetGenericArguments())
        let extensionOwner = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "ExtensionOwner")
        let cache = Assert.Single(
            extensionOwner.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            (type Type) -> type.Name.StartsWith("Cache", StringComparison.Ordinal)
        )
        Assert.True(cache.IsNestedPrivate)
        Assert.Equal(extensionOwner, cache.DeclaringType)
        Assert.Single(cache.GetGenericArguments())
        Assert.True(extensionOwner.GetField("cache", BindingFlags.NonPublic | BindingFlags.Static)!!.IsPrivate)
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("Identity", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("AddCached", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("DelayIdentityAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("DelayAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("LengthAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("DelayTextAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueNoteAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueLengthAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        Assert.Equal(
            extensionOwner,
            extensionOwner.GetMethod("ValueDelayAsync", BindingFlags.Public | BindingFlags.Static)!!.DeclaringType
        )
        let genericOwner = Assert.Single(
            assembly.GetTypes(),
            (type Type) -> type.Name.StartsWith("GenericOwner", StringComparison.Ordinal)
        )
        let genericHelper = Assert.Single(
            genericOwner.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic),
            (type Type) -> type.Name.StartsWith("Helper", StringComparison.Ordinal)
        )
        Assert.True(genericHelper.IsNestedPrivate)
        Assert.Equal(genericOwner, genericHelper.DeclaringType)
        let genericArguments = genericHelper.GetGenericArguments()
        Assert.Equal(2, genericArguments.Length)
        Assert.Equal(
            0,
            genericHelper.GetMethod("EchoOuter", BindingFlags.NonPublic | BindingFlags.Instance)!!
                .ReturnType
                .GenericParameterPosition
        )
        Assert.Equal(
            1,
            genericHelper.GetMethod("EchoInner", BindingFlags.NonPublic | BindingFlags.Instance)!!
                .ReturnType
                .GenericParameterPosition
        )
    }

    @Fact
    func PrivateNestedExtensionBody_IsHostedOnItsOwnerAcrossProjectBoundary() {
        let producer = CSharpProjectLoader.LoadInMemory([](string, string){("Producer.cs", `namespace Issue3413;

public static class Extensions
{
    private sealed class Box<T>
    {
        public static T Echo(T value) => value;
    }

    public static T Echo<T>(this T value) => Box<T>.Echo(value);
}`)}, CSharpProjectLoader.RuntimeReferences(), "Issue3413.Producer")
        Assert.True(producer.BoundWithoutErrors, string.Join(Environment.NewLine, producer.ErrorDiagnostics))
        using let image = MemoryStream()
        let emit = producer.Compilation.Emit(image)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let producerReference MetadataReference = MetadataReference.CreateFromImage(image.ToArray())
        let consumer = CSharpProjectLoader.LoadInMemory([](string, string){("Consumer.cs", `using Issue3413;

namespace Consumer;

public static class Use
{
    public static string Run(string value) => value.Echo();
}`)}, CSharpProjectLoader.RuntimeReferences().Append(producerReference).ToList(), "Issue3413.Consumer")
        Assert.True(consumer.BoundWithoutErrors, string.Join(Environment.NewLine, consumer.ErrorDiagnostics))
        let siblings[]CSharpCompilation = []CSharpCompilation{producer.Compilation, consumer.Compilation}
        let producerDocument = Assert.Single(producer.Documents)
        let consumerDocument = Assert.Single(consumer.Documents)
        let printedProducer = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                producerDocument,
                TranslationContext(
                    producer.Compilation,
                    producerDocument.SemanticModel,
                    producerDocument.FilePath,
                    siblings
                )
            )
        )
        let printedConsumer = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                consumerDocument,
                TranslationContext(
                    consumer.Compilation,
                    consumerDocument.SemanticModel,
                    consumerDocument.FilePath,
                    siblings
                )
            )
        )
        // Issue #4676: the producer's extension is one lifted function hosted on its owner
        // (which reaches the private `Box`), not an in-owner helper plus a companion.
        Assert.Contains("private class Box[T]", printedProducer, StringComparison.Ordinal)
        Assert.Contains("@ExtensionOwner(typeof(Extensions))", printedProducer, StringComparison.Ordinal)
        Assert.Contains("func (value T) Echo[T]() T -> Box[T].Echo(value)", printedProducer, StringComparison.Ordinal)
        Assert.DoesNotContain("Extensions.Echo", printedProducer, StringComparison.Ordinal)
        Assert.Contains("value.Echo()", printedConsumer, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(printedProducer, printedConsumer)
    }

    shared {
        private const Source string = `using System;
using System.Threading.Tasks;

namespace Issue3413
{
    public static class Program
    {
        private sealed class EntryHelper<T>
        {
            public EntryHelper(T value)
            {
                Value = value;
            }

            public T Value { get; }
        }

        public static void Main()
        {
            Console.WriteLine(new EntryHelper<int>(42).Value);
            Console.WriteLine(1.Identity());
            Console.WriteLine(35.AddCached());
            Console.WriteLine(6.DelayIdentityAsync().GetAwaiter().GetResult());
            7.DelayAsync().GetAwaiter().GetResult();
            Console.WriteLine("four".LengthAsync().GetAwaiter().GetResult());
            "later".DelayTextAsync().GetAwaiter().GetResult();
            Console.WriteLine(9.ValueAsync().AsTask().GetAwaiter().GetResult());
            10.ValueNoteAsync().AsTask().GetAwaiter().GetResult();
            Console.WriteLine("five".ValueLengthAsync().AsTask().GetAwaiter().GetResult());
            "later".ValueDelayAsync().AsTask().GetAwaiter().GetResult();
            Console.WriteLine("async");
        }
    }

    public static class ExtensionOwner
    {
        private sealed class Cache<T>
        {
            public Cache(T value)
            {
                Value = value;
            }

            public T Value { get; }

            public static T Echo(T value) => value;
        }

        private static Cache<int> cache = new Cache<int>(7);

        public static T Identity<T>(this T value) => Cache<T>.Echo(value);

        public static int AddCached(this int value) => value + cache.Value;

        public static async Task<T> DelayIdentityAsync<T>(this T value)
        {
            await Task.Yield();
            return Cache<T>.Echo(value);
        }

        public static async Task DelayAsync(this int value)
        {
            await Task.Yield();
        }

        public static async Task<int> LengthAsync(this string value)
        {
            await Task.Yield();
            return value.Length;
        }

        public static async Task DelayTextAsync(this string value)
        {
            await Task.Yield();
        }

        public static async ValueTask<int> ValueAsync(this int value)
        {
            await Task.Yield();
            return value;
        }

        public static async ValueTask ValueNoteAsync(this int value)
        {
            await Task.Yield();
        }

        public static async ValueTask<int> ValueLengthAsync(this string value)
        {
            await Task.Yield();
            return value.Length;
        }

        public static async ValueTask ValueDelayAsync(this string value)
        {
            await Task.Yield();
        }
    }

    public sealed class GenericOwner<TOuter>
    {
        private sealed class Helper<TInner> : LateBase<TOuter, TInner>
        {
            protected override TOuter EchoOuter(TOuter value) => value;

            protected override TInner EchoInner(TInner value) => value;
        }
    }

    public class LateBase<TOuter, TInner> : Root<TOuter, TInner>
    {
        protected override TOuter EchoOuter(TOuter value) => value;

        protected override TInner EchoInner(TInner value) => value;
    }

    public abstract class Root<TOuter, TInner>
    {
        protected abstract TOuter EchoOuter(TOuter value);

        protected abstract TInner EchoInner(TInner value);
    }
}`

        // ADR-0195 / issue #4674: the shared members of a type are the body of a `shared class`
        // (a C# static class), and the `shared { }` block of any other class.
        private func SharedMembers(type TypeDeclaration) IReadOnlyList[GMember] -> if type.IsShared {
            type.Members
        } else {
            Assert.Single(type.Members.OfType[SharedBlock]()).Members
        }

        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: "Program.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Issue3413.Translation",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.ConsoleApplication).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument(tree.FilePath, tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return (CSharpToGSharpTranslator().TranslateDocument(document, context), context)
        }

        private func TranslateProject(project LoadedCSharpProject, siblings IReadOnlyList[CSharpCompilation]) string {
            let translator = CSharpToGSharpTranslator()
            return string.Join(
                Environment.NewLine,
                project.Documents.Select(
                    (document LoadedDocument) -> {
                        let context = TranslationContext(
                            project.Compilation,
                            document.SemanticModel,
                            document.FilePath,
                            siblings
                        )
                        return GSharpPrinter.Print(translator.TranslateDocument(document, context))
                    }
                )
            )
        }

        private func IlVerifyToolAvailable() bool {
            try {
                return !IlVerifyRunner.IsEnabled || IlVerifyRunner().EnsureToolAvailable()
            } catch {
                return false
            }
        }

        private func NewDirectory(category string) string {
            let root = Path.Combine(AppContext.BaseDirectory, category, "issue3413", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func PipelineFailureDetails(outputRoot string, result RunResult, app AppResult) string -> string.Join(
            "; ",
            app.Stages.Select((stage StageResult) -> stage.Stage + "=" + stage.Status)
        ) +
            Environment.NewLine +
            string
            .Join(
            Environment.NewLine,
            app.Artifacts.Select((path string) -> ReadArtifact(Path.Combine(outputRoot, result.RunId, path)))
        )

        private func ReadArtifact(path string) string {
            try {
                return File.ReadAllText(path)
            } catch (error IOException) {
                return "Artifact unavailable: '$path' (${error.Message})"
            } catch (error UnauthorizedAccessException) {
                return "Artifact unavailable: '$path' (${error.Message})"
            }
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
