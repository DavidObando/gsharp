// <copyright file="Issue3219StructPrivateInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3219: a value-kind struct literal (including the struct-target
/// structural projection) materialized declared field initializers as raw
/// <c>stfld</c>s at the construction site — including PRIVATE fields, which
/// the runtime rejects from outside the type with
/// <see cref="System.FieldAccessException"/>. The fix synthesizes a public
/// parameterless <c>.ctor</c> for value structs whose declared initializers
/// include a non-public field (running ALL declared initializers in-type),
/// and routes literal construction through it, skipping the injected
/// declared-initializer entries so initializer side effects run exactly once.
/// Structs whose initializers are all public keep the historical inline
/// emission (no synthesized ctor).
/// </summary>
public class Issue3219StructPrivateInitializerEmitTests
{
    [Fact]
    public void StructLiteral_PrivateDeclaredInitializer_RunsInType()
    {
        // Pre-fix: FieldAccessException — `stfld Box::Marker` executed in
        // <Main>$, outside the type.
        var result = EmittedOracle.Evaluate(@"
struct Box {
    var Value int32
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
let box = Box{Value: 7}
box.ReadMarker()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void ConstructedGenericStructProjection_PreservesPrivateInitializer()
    {
        // The issue's projection repro at a constructed generic target:
        // pre-fix FieldAccessException on `Box`1<System.Int32>.Marker`.
        var result = EmittedOracle.Evaluate(@"
struct Source { var Value int32 }
struct Box[T] {
    var Value T
    private var Marker int32 = 11
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void ConstructedGenericStructProjection_CopiesPublicSlot()
    {
        // The projection's mapped public slot must still be written after the
        // synthesized ctor ran — discriminates against a ctor-only lowering
        // that drops the explicit member stores.
        var result = EmittedOracle.Evaluate(@"
struct Source { var Value int32 }
struct Box[T] {
    var Value T
    private var Marker int32 = 11
}
let source = Source{Value: 7}
let box Box[int32] = source
box.Value
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void PrivateInitializerSideEffect_RunsExactlyOnce()
    {
        // The literal's injected declared-initializer entries are skipped at
        // the call site when construction routes through the synthesized
        // ctor; a double-run would print the marker twice.
        var result = EmittedOracle.Evaluate(@"
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
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1101, result.Value);
    }

    [Fact]
    public void ClassTarget_Control_StillRoutesThroughDefaultCtor()
    {
        // The issue's class-shaped repro: the class path already constructed
        // through the synthesized default ctor; pins it against regression.
        var result = EmittedOracle.Evaluate(@"
class Source { var Value int32 }
class Box[T] {
    var Value T
    private var Marker int32 = 9
    func ReadMarker() int32 { return Marker }
}
let source = Source{Value: 7}
let box Box[int32] = source
box.ReadMarker()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void SynthesizedCtor_OnlyForNonPublicInitializerStructs()
    {
        // Scope containment: the struct with a private initialized field
        // carries exactly one parameterless .ctor; the all-public-initializer
        // struct keeps the historical ctor-less shape (inline emission).
        const string source = @"
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
";
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " +
            string.Join("; ", emitResult.Diagnostics.Select(diagnostic => diagnostic.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var metadata = peReader.GetMetadataReader();
        int hiddenCtors = 0, openCtors = 0;
        foreach (var typeHandle in metadata.TypeDefinitions)
        {
            var typeDef = metadata.GetTypeDefinition(typeHandle);
            var typeName = metadata.GetString(typeDef.Name);
            if (typeName != "Hidden" && typeName != "Open")
            {
                continue;
            }

            var ctorCount = typeDef.GetMethods()
                .Count(m => metadata.GetString(metadata.GetMethodDefinition(m).Name) == ".ctor");
            if (typeName == "Hidden")
            {
                hiddenCtors = ctorCount;
            }
            else
            {
                openCtors = ctorCount;
            }
        }

        Assert.Equal(1, hiddenCtors);
        Assert.Equal(0, openCtors);
    }
}
