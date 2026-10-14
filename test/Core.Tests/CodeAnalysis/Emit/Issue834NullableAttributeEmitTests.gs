// <copyright file="Issue834NullableAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.ObjectModel
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #834: a G# extension function whose parameter is typed as
/// `T?` for a reference (or class-constrained generic) type must emit
/// per-parameter `System.Runtime.CompilerServices.NullableAttribute(2)`
/// so a C# consumer using `nullable enable` sees the parameter as
/// annotated (CS8602 silenced). When all reference positions share the
/// same nullability flag, the emitter collapses them into a single
/// `NullableContextAttribute(b)` on the MethodDef and skips matching
/// per-position rows — exactly what Roslyn does for the equivalent C#
/// source.
open class Issue834NullableAttributeEmitTests {
    @Fact
    func ExtensionParameter_OnNullableGeneric_StampsNullableAttribute() {
        const Source = `package Issue834.Map

import System

func (self T?) Map[T class, U class](f (T) -> U) U? {
    if f == nil {
        throw ArgumentNullException("f")
    }

    if self == nil {
        return nil
    }

    return f(self!!)
}
`
        let asm = CompileToAssembly(Source, "Issue834.Map")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let map_ MethodInfo? = programType.GetMethod(
            "Map",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(map_)
        let parameters = map_!!.GetParameters()
        Assert.Equal(2, parameters.Length)
        // Either the per-method NullableContextAttribute = 2 collapses the
        // shape (both the `T?` self parameter, the `(T) -> U` reference
        // function, and the `U?` return all converge), or the receiver carries
        // its own NullableAttribute(2). Allow either compaction.
        let selfNullable = GetNullableAttributeValue(parameters[0])
        let methodContext = GetNullableContextAttributeValue(map_)
        Assert.True(
            selfNullable == (2 as uint8?) || methodContext == (2 as uint8?),
            "Map's `self` parameter must report nullable: selfNullable=$selfNullable, methodContext=$methodContext"
        )
    }

    @Fact
    func ExtensionFunction_UniformNullableShape_StampsNullableContextAttribute() {
        const Source = `package Issue834.UniformContext

import System

func (self T?) Filter[T class](predicate (T) -> bool) T? {
    if predicate == nil {
        throw ArgumentNullException("predicate")
    }

    if self == nil {
        return nil
    }

    if predicate(self!!) {
        return self
    }

    return nil
}
`
        let asm = CompileToAssembly(Source, "Issue834.UniformContext")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let filter MethodInfo? = programType.GetMethod(
            "Filter",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(filter)
        let methodContext = GetNullableContextAttributeValue(filter!!)
        // The most common byte across (T? return) + (T? self) + (Func<T, bool> predicate)
        // is `2` (annotated) — Roslyn collapses to NullableContextAttribute(2).
        Assert.Equal(uint8(2), methodContext)
        // With method-level default 2, the predicate parameter (single
        // NotAnnotated byte for the delegate ref slot) needs its own
        // NullableAttribute(1).
        let predicate = filter!!.GetParameters()[1]
        let predicateAttr = GetNullableAttributeValue(predicate)
        Assert.Equal(uint8(1), predicateAttr)
    }

    @Fact
    func ExtensionFunction_OnNullableReferenceType_StampsAnnotated() {
        // T? where the receiver is a concrete reference type (no generic).
        const Source = `package Issue834.StringMap

import System

func (self string?) MaybeShout() string? {
    if self == nil {
        return nil
    }

    return self + "!"
}
`
        let asm = CompileToAssembly(Source, "Issue834.StringMap")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let shout MethodInfo? = programType.GetMethod(
            "MaybeShout",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(shout)
        let selfParam = shout!!.GetParameters().Single()
        // Per-parameter annotation OR uniform method context.
        let selfAttr = GetNullableAttributeValue(selfParam)
        let methodContext = GetNullableContextAttributeValue(shout)
        Assert.True(
            selfAttr == (2 as uint8?) || methodContext == (2 as uint8?),
            "selfAttr=$selfAttr, methodContext=$methodContext"
        )
    }

    @Fact
    func NonNullableReferenceParameter_RelyOnAssemblyDefault() {
        // No `?` anywhere — the assembly-level NullableContextAttribute(1)
        // suffices, so we should emit NO per-parameter NullableAttribute and
        // NO per-method NullableContextAttribute. Verifies we do not bloat
        // metadata for the non-nullable case.
        const Source = `package Issue834.Plain

import System

func Echo(s string) string {
    return s
}
`
        let asm = CompileToAssembly(Source, "Issue834.Plain")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let echo MethodInfo? = programType.GetMethod(
            "Echo",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(echo)
        Assert.Null(GetNullableContextAttributeValue(echo!!))
        Assert.Null(GetNullableAttributeValue(echo!!.GetParameters()[0]))
    }

    @Fact
    func ValueTypeParameter_EmitsNoNullableAttribute() {
        const Source = `package Issue834.ValueParam

import System

func Add(x int32, y int32) int32 {
    return x + y
}
`
        let asm = CompileToAssembly(Source, "Issue834.ValueParam")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let add MethodInfo? = programType.GetMethod(
            "Add",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(add)
        Assert.Null(GetNullableContextAttributeValue(add!!))
        for p in add!!.GetParameters() {
            Assert.Null(GetNullableAttributeValue(p))
        }
    }

    @Fact
    func GenericIEnumerableNullableReceiver_StampsNullableAttribute() {
        // Receiver is `IEnumerable[T]?` over a generic T — exactly the
        // repro shape from the issue.
        const Source = `package Issue834.SliceFromNullable

import System
import System.Collections.Generic

func (source IEnumerable[T]?) ToSliceOrEmpty[T]() []T {
    if source == nil {
        return []T{}
    }

    var list = List[T]()
    for item in source!! {
        list.Add(item)
    }

    return list.ToArray()
}
`
        let asm = CompileToAssembly(Source, "Issue834.SliceFromNullable")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let toSlice MethodInfo? = programType.GetMethod(
            "ToSliceOrEmpty",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(toSlice)
        let sourceParam = toSlice!!.GetParameters().Single()
        // The receiver carries either a per-parameter NullableAttribute or a
        // method-level NullableContextAttribute that lifts it to annotated.
        let perParam = GetNullableAttributeArrayValue(sourceParam)
        let methodContext = GetNullableContextAttributeValue(toSlice)
        // Either way, the OUTER position for `source` must reflect "annotated".
        var outerByte uint8
        if perParam.Length > 0 {
            outerByte = perParam[0]
        } else if methodContext is uint8 ctx {
            outerByte = ctx
        } else {
            outerByte = uint8(0)
        }
        Assert.Equal(uint8(2), outerByte)
    }

    @Fact
    func NullableContextDecidedByMajority_NonNullParamsDefaultStaysOne() {
        // 1 nullable position, 2 non-nullable → majority is 1, so the
        // assembly default wins and NO NullableContextAttribute is needed
        // on the method. The single `s2` nullable parameter still requires
        // a per-parameter NullableAttribute(2).
        const Source = `package Issue834.Mixed

import System

func Compose(s1 string, s2 string?, s3 string) string {
    if s2 == nil {
        return s1 + s3
    }

    return s1 + s2!! + s3
}
`
        let asm = CompileToAssembly(Source, "Issue834.Mixed")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let compose MethodInfo? = programType.GetMethod(
            "Compose",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(compose)
        Assert.Null(GetNullableContextAttributeValue(compose!!))
        let parameters = compose!!.GetParameters()
        Assert.Null(GetNullableAttributeValue(parameters[0]))
        Assert.Equal(uint8(2), GetNullableAttributeValue(parameters[1]))
        Assert.Null(GetNullableAttributeValue(parameters[2]))
    }

    @Fact
    func StructConstrainedNullable_LowersToValueTypeNullableT_WithObliviousContextSlot() {
        // For `T?` over a `struct`-constrained TP, the signature lowers to
        // metadata-transparent `Nullable<T>`. T contributes one oblivious
        // generic-parameter slot, compacted into method context 0.
        const Source = `package Issue834.ValueOptional

import System

func (self T?) OrZero[T struct](defaultValue T) T {
    if !self.HasValue {
        return defaultValue
    }

    return self.Value
}
`
        let asm = CompileToAssembly(Source, "Issue834.ValueOptional")
        let programType = asm.GetTypes().Single((t Type) -> t.Name == "<Program>")
        let orZero MethodInfo? = programType.GetMethod(
            "OrZero",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(orZero)
        // No NullableAttribute on any value-type position.
        for p in orZero!!.GetParameters() {
            Assert.Null(GetNullableAttributeValue(p))
        }
        Assert.Equal(uint8(0), GetNullableContextAttributeValue(orZero!!))
    }

    @Fact
    func ConstructorNullableDelegateParameter_StampsNullableAttribute() {
        const Source = `package Issue834.Constructor

class Screen {
    init(factory (() -> object)?) {
    }
}`
        let asm = CompileToAssembly(Source, "Issue834.Constructor")
        let ctor = asm
            .GetTypes()
            .Single((t Type) -> t.Name == "Screen")
            .GetConstructors()
            .Single((c ConstructorInfo) -> c.GetParameters().Length == 1)
        let flags = GetNullableAttributeArrayValue(ctor.GetParameters().Single())
        Assert.NotEmpty(flags)
        Assert.Equal(uint8(2), flags[0])
        Assert.IsType[NullableTypeSymbol](ClrNullability.GetParameterTypeSymbol(ctor.GetParameters().Single()))
    }

    @Fact
    func ImportedConstructorNullableDelegateParameter_AcceptsNil() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue834ImportedConstructor")
        Directory.CreateDirectory(outputDir)
        let libraryPath = Path.Combine(outputDir, "Issue834.Constructor.Library.dll")
        let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Issue834.Constructor

class Screen {
    init(factory (() -> object)?) {
    }
}`))){IsLibrary = true}
        {
            using let output = File.Create(libraryPath)
            let result = library.Emit(
                output,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue834.Constructor.Library"
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        resolver.CurrentAssemblyName = "Issue834.Constructor.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Issue834.Constructor

func Make() Screen -> Screen(nil)`)))
        using let consumerOutput = MemoryStream()
        let consumerResult = consumer.Emit(
            consumerOutput,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue834.Constructor.Consumer"
        )
        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics))
    }

    @Fact
    func ImportedGenericMethodNullableDelegateParameter_AcceptsNullableDelegateVariableAndNil() {
        let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue834ImportedGenericMethod")
        Directory.CreateDirectory(outputDir)
        let modelPath = Path.Combine(outputDir, "Issue834.GenericMethod.Model.dll")
        let libraryPath = Path.Combine(outputDir, "Issue834.GenericMethod.Library.dll")
        let model = Compilation(SyntaxTree.Parse(SourceText.From(`package Issue834.GenericModel

class Book {
}

class Conversion {
}

interface ICancellation {
}`))){IsLibrary = true}
        {
            using let output = File.Create(modelPath)
            let result = model.Emit(
                output,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue834.GenericMethod.Model"
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        using let libraryResolver = ReferenceResolver.WithReferences([]string{modelPath})
        libraryResolver.CurrentAssemblyName = "Issue834.GenericMethod.Library"
        let library = Compilation(libraryResolver, SyntaxTree.Parse(SourceText.From(`package Issue834.GenericLibrary
import Issue834.GenericModel

class Runner[T ICancellation] {
    init() {
    }

    func Run(context T, callback ((Book, T, (Conversion) -> void) -> void)?) {
    }
}`))){IsLibrary = true}
        {
            using let output = File.Create(libraryPath)
            let result = library.Emit(
                output,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue834.GenericMethod.Library"
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let metadataResolver = PathAssemblyResolver(
            Directory.GetFiles(runtimeDir, "*.dll").Concat([]string{modelPath, libraryPath})
        )
        {
            using let metadataContext = MetadataLoadContext(metadataResolver, "System.Private.CoreLib")
            let assembly = metadataContext.LoadFromAssemblyPath(libraryPath)
            let parameter = assembly.GetType("Issue834.GenericLibrary.Runner`1")!!.GetMethod("Run")!!.GetParameters()
                .Single((parameter ParameterInfo) -> parameter.Name == "callback")
            Assert.IsType[NullableTypeSymbol](ClrNullability.GetParameterTypeSymbol(parameter))
        }
        using let resolver = ReferenceResolver.WithReferences([]string{modelPath, libraryPath})
        resolver.CurrentAssemblyName = "Issue834.GenericMethod.Consumer"
        let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Consumer
import Issue834.GenericLibrary
import Issue834.GenericModel

class SimpleCancellation : ICancellation {
}

class Use {
    func M() {
        let runner = Runner[SimpleCancellation]()
        var callback ((Book, SimpleCancellation, (Conversion) -> void) -> void)? = nil

        // Issue #2820: cover both nullable-variable and literal-nil binding
        // after substituting the imported generic receiver's T.
        runner.Run(SimpleCancellation(), callback)
        runner.Run(SimpleCancellation(), nil)
    }
}`)))
        using let consumerOutput = MemoryStream()
        let consumerResult = consumer.Emit(
            consumerOutput,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue834.GenericMethod.Consumer"
        )
        Assert.True(consumerResult.Success, string.Join(Environment.NewLine, consumerResult.Diagnostics))
    }

    @Fact
    func ClassUserAttribute_IsEmittedOnType() {
        let asm = CompileToAssembly(`package Issue834.TypeAttribute

@Obsolete("legacy")
class Legacy {
}`, "Issue834.TypeAttribute")
        let type = asm.GetTypes().Single((t Type) -> t.Name == "Legacy")
        Assert.Contains(
            type.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute.AttributeType == typeof(ObsoleteAttribute)
        )
    }

    @Fact
    func ImportedXunitCollectionAttribute_IsEmittedOnType() {
        using let resolver = ReferenceResolver.WithReferences([]string{typeof(CollectionAttribute).Assembly.Location})
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Issue834.XunitAttribute
import Xunit

@Collection("Serial")
class Tests {
}`))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: "Issue834.XunitAttribute")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        output.Position = 0
        let context = AssemblyLoadContext("Issue834.XunitAttribute", isCollectible: true)
        try {
            let asm = context.LoadFromStream(output)
            let type = asm.GetTypes().Single((t Type) -> t.Name == "Tests")
            Assert.Contains(
                type.GetCustomAttributesData(),
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .FullName == typeof(CollectionAttribute).FullName
            )
        } finally {
            context.Unload()
        }
    }

    @Fact
    func ImportedXunitCollectionDefinitionAttribute_EmitsNamedProperty() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(CollectionDefinitionAttribute).Assembly.Location}
        )
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Issue834.XunitNamedAttribute
import Xunit

@CollectionDefinition("Serial", DisableParallelization: true)
class SerialCollection {
}`))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(
            output,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue834.XunitNamedAttribute"
        )
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        output.Position = 0
        let context = AssemblyLoadContext("Issue834.XunitNamedAttribute", isCollectible: true)
        try {
            let asm = context.LoadFromStream(output)
            let type = asm.GetTypes().Single((t Type) -> t.Name == "SerialCollection")
            let attribute = Assert.Single(
                type.GetCustomAttributesData(),
                (attribute CustomAttributeData) -> attribute
                    .AttributeType
                    .FullName == typeof(CollectionDefinitionAttribute).FullName
            )
            Assert.Equal("DisableParallelization", Assert.Single(attribute.NamedArguments).MemberName)
            Assert.Equal(true, attribute.NamedArguments[0].TypedValue.Value)
        } finally {
            context.Unload()
        }
    }

    @Fact
    func ImportedAttributeWithSystemTypeConstructor_EmitsResolvableConstructor() {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(TypeCtorProbeAttribute).Assembly.Location}
        )
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`package Issue834.ImportedTypeAttribute
import GSharp.Core.Tests.CodeAnalysis.Emit

class Target {
}

@TypeCtorProbe(typeof(Target))
class Annotated {
}`))){IsLibrary = true}
        using let output = MemoryStream()
        let result = compilation.Emit(
            output,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue834.ImportedTypeAttribute"
        )
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        output.Position = 0
        let context = AssemblyLoadContext("Issue834.ImportedTypeAttribute", isCollectible: true)
        try {
            let asm = context.LoadFromStream(output)
            let type = asm.GetTypes().Single((t Type) -> t.Name == "Annotated")
            let attribute = Assert.Single(
                type.GetCustomAttributesData(),
                (attribute CustomAttributeData) -> attribute.AttributeType == typeof(TypeCtorProbeAttribute)
            )
            Assert.Equal("Target", (cast[Type](Assert.Single(attribute.ConstructorArguments).Value)).Name)
        } finally {
            context.Unload()
        }
    }

    shared {
        private func GetNullableAttributeValue(parameter ParameterInfo) uint8? {
            for ad in parameter.GetCustomAttributesData() {
                if ad
                    .AttributeType
                    ?.FullName != "System.Runtime.CompilerServices.NullableAttribute" ||
                    ad
                    .ConstructorArguments
                    .Count != 1 {
                    continue
                }
                let arg = ad.ConstructorArguments[0]
                if arg.Value is uint8 b {
                    return b
                }
                if arg.Value is ReadOnlyCollection[CustomAttributeTypedArgument]arr &&
                    arr.Count > 0 &&
                    arr[0].Value is uint8 first {
                    return first
                }
            }
            return nil
        }

        private func GetNullableAttributeArrayValue(parameter ParameterInfo)[]uint8 {
            for ad in parameter.GetCustomAttributesData() {
                if ad
                    .AttributeType
                    ?.FullName != "System.Runtime.CompilerServices.NullableAttribute" ||
                    ad
                    .ConstructorArguments
                    .Count != 1 {
                    continue
                }
                let arg = ad.ConstructorArguments[0]
                if arg.Value is uint8 b {
                    return []uint8{b}
                }
                if arg.Value is ReadOnlyCollection[CustomAttributeTypedArgument]arr {
                    let result = [arr.Count]uint8
                    for var i = 0; i < arr.Count; i++ {
                        if arr[i].Value is uint8 ab {
                            result[i] = ab
                        }
                    }
                    return result
                }
            }
            return Array.Empty[uint8]()
        }

        private func GetNullableContextAttributeValue(method MethodInfo?) uint8? {
            for ad in method!!.GetCustomAttributesData() {
                if ad
                    .AttributeType
                    ?.FullName != "System.Runtime.CompilerServices.NullableContextAttribute" ||
                    ad
                    .ConstructorArguments
                    .Count != 1 {
                    continue
                }
                if ad.ConstructorArguments[0].Value is uint8 b {
                    return b
                }
            }
            return nil
        }

        private func CompileToAssembly(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: false)
            return loadContext.LoadFromStream(peStream)
        }
    }
}

class TypeCtorProbeAttribute : Attribute {
    init(type Type) {
        this.Type = type
    }

    prop Type Type {
        get;
    }
}
