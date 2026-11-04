// <copyright file="Issue3219StructPrivateInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3219: a value-kind struct literal (including the struct-target
/// structural projection) materialized declared field initializers as raw
/// `stfld`s at the construction site — including PRIVATE fields, which
/// the runtime rejects from outside the type with
/// (cref:System.FieldAccessException). The fix synthesizes a public
/// parameterless `.ctor` for value structs whose declared initializers
/// include a non-public field (running ALL declared initializers in-type),
/// and routes literal construction through it, skipping the injected
/// declared-initializer entries so initializer side effects run exactly once.
/// Structs whose initializers are all public keep the historical inline
/// emission (no synthesized ctor).
open class Issue3219StructPrivateInitializerEmitTests {
    @Fact
    func StructLiteral_PrivateDeclaredInitializer_RunsInType() {
        // Pre-fix: FieldAccessException — `stfld Box::Marker` executed in
        // <Main>$, outside the type.
        let result = EmittedOracle.Evaluate(`
struct Box {
    var Value int32
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
let box = Box{Value: 7}
box.ReadMarker()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func ConstructedGenericStructProjection_PreservesPrivateInitializer() {
        // The issue's projection repro at a constructed generic target:
        // pre-fix FieldAccessException on `Box`1<System.Int32>.Marker`.
        let result = EmittedOracle.Evaluate(`
struct Source { var Value int32 }
struct Box[T] {
    var Value T
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func ConstructedGenericStructProjection_CopiesPublicSlot() {
        // The projection's mapped public slot must still be written after the
        // synthesized ctor ran — discriminates against a ctor-only lowering
        // that drops the explicit member stores.
        let result = EmittedOracle.Evaluate(`
struct Source { var Value int32 }
struct Box[T] {
    var Value T
    private var Marker int32 = 11
}
let source = Source{Value: 7}
let box Box[int32] = source
box.Value
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PrivateInitializerSideEffect_RunsExactlyOnce() {
        // The literal's injected declared-initializer entries are skipped at
        // the call site when construction routes through the synthesized
        // ctor; a double-run would print the marker twice.
        let result = EmittedOracle.Evaluate(`
import System

func Mark() int32 {
    Counter.Hits = Counter.Hits + 1
    return 11
}

class Counter {
    shared {
        var Hits int32 = 0
    }
}

struct Box {
    var Value int32
    private var Marker int32 = Mark()
    func ReadMarker() int32 { return Marker }
}

let box = Box{Value: 7}
box.ReadMarker() * 100 + Counter.Hits
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1101, result.Value)
    }

    @Fact
    func ClassTarget_Control_StillRoutesThroughDefaultCtor() {
        // The issue's class-shaped repro: the class path already constructed
        // through the synthesized default ctor; pins it against regression.
        let result = EmittedOracle.Evaluate(`
class Source { var Value int32 }
class Box[T] {
    var Value T
    private var Marker int32 = 9
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func SynthesizedCtor_OnlyForNonPublicInitializerStructs() {
        // Scope containment: the struct with a private initialized field
        // carries exactly one parameterless .ctor; the all-public-initializer
        // struct keeps the historical ctor-less shape (inline emission).
        const source = `
struct Hidden {
    var Value int32
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
struct Open {
    var Value int32
    var Marker int32 = 11
}
let h = Hidden{Value: 1}
let o = Open{Value: 2}
h.ReadMarker() + o.Marker
`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let emitResult = compilation.Emit(peStream)
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join(
                "; ",
                emitResult.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Message)
            )
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let metadata = peReader.GetMetadataReader()
        var hiddenCtors = 0
        var openCtors = 0
        for typeHandle in metadata.TypeDefinitions {
            let typeDef = metadata.GetTypeDefinition(typeHandle)
            let typeName = metadata.GetString(typeDef.Name)
            if typeName != "Hidden" && typeName != "Open" {
                continue
            }
            let ctorCount = typeDef.GetMethods().Count(
                (m MethodDefinitionHandle) -> metadata.GetString(metadata.GetMethodDefinition(m).Name) == ".ctor"
            )
            if typeName == "Hidden" {
                hiddenCtors = ctorCount
            } else {
                openCtors = ctorCount
            }
        }
        Assert.Equal(1, hiddenCtors)
        Assert.Equal(0, openCtors)
    }

    @Fact
    func SynthesizedCtor_IncludedForPublicInitOnlyInitializerStructs() {
        // Issue #4742: a struct with a public `let` (`initonly`) field initializer
        // must also synthesize an owning `.ctor` so `stfld` on the `initonly`
        // field executes inside `.ctor` rather than at the outer literal site.
        const source = `
struct PublicLet {
    let Marker int32 = 11
    var Value int32
}
let p = PublicLet{Value: 2}
p.Marker + p.Value
`
        using let peStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let emitResult = compilation.Emit(peStream)
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join(
                "; ",
                emitResult.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Message)
            )
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream)
        let metadata = peReader.GetMetadataReader()
        var publicLetCtors = 0
        for typeHandle in metadata.TypeDefinitions {
            let typeDef = metadata.GetTypeDefinition(typeHandle)
            if metadata.GetString(typeDef.Name) != "PublicLet" {
                continue
            }
            publicLetCtors = typeDef.GetMethods().Count(
                (m MethodDefinitionHandle) -> metadata.GetString(metadata.GetMethodDefinition(m).Name) == ".ctor"
            )
        }
        Assert.Equal(1, publicLetCtors)
    }

    @Fact
    func NonMagicExplicitPublicLetFieldInitializer_StillBypassedForBareDeclaration() {
        // Issue #4742 review: adding public `let` initializers to the owning-ctor
        // synthesis predicate for explicit `S{}` literals must not cause bare
        // declarations (`var s S`) to invoke the full synthesized constructor
        // or run effectful non-magic initializers.
        let result = EmittedOracle.Evaluate(`
class Counter {
    shared {
        public var Hits int32
        public func Next() int32 {
            Hits += 1
            return 5
        }
    }
}

struct S {
    public let Count int32 = Counter.Next()
    public var Items []int32
}

func run() int32 {
    var bare S
    let explicitLiteral = S{}
    return bare.Count * 1000 + bare.Items.Length * 100 + explicitLiteral.Count * 10 + Counter.Hits
}

run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(51, result.Value)
    }

    @Fact
    func ZeroInitInExpressionTree_WithPublicLetAndAuthoredInit_MatchesOrdinaryConstruction() {
        // When `S` has a public `let` initializer, a magic-collection field, and
        // an authored parameterless `init()`, `LiteralInitializerMarkerCount` is
        // non-zero for explicit `S{}` literals, but zero-initialization (`Box{}`
        // omitting `Value S`) must still use zero storage in both ordinary code
        // and expression trees without invoking the hidden marker constructor.
        let result = EmittedOracle.Evaluate(`
import System
import System.Linq.Expressions

class Counter {
    shared {
        public var Hits int32
        public func Next() int32 {
            Hits += 1
            return 5
        }
    }
}

struct S {
    public let Count int32 = Counter.Next()
    public var Items []int32
    public init() {
        Count = 9
        Items = []int32{1, 2}
    }
}

data struct Box(Value S)

func run() int32 {
    let ordinary = Box{}
    let tree Expression[Func[Box]] = () -> Box{}
    let compiled = tree.Compile()()
    let explicitLiteral = S{}
    return ordinary.Value.Count * 10000 +
        ordinary.Value.Items.Length * 1000 +
        compiled.Value.Count * 100 +
        compiled.Value.Items.Length * 10 +
        explicitLiteral.Count +
        Counter.Hits * 100000
}

run()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(100005, result.Value)
    }
}
