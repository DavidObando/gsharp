// <copyright file="GsStubClassShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;
using static GSharp.GeneratorHost.Tests.StubTestSupport;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// ADR-0195 / issue #4674: a generator reads the stub through Roslyn, so the CLR shape of
/// a G# <c>abstract class</c> and <c>shared class</c> has to be the C# one
/// (<c>INamedTypeSymbol.IsAbstract</c> / <c>IsStatic</c>), or it can produce different
/// output than for the real type.
/// </summary>
public class GsStubClassShapeTests
{
    [Fact]
    public void AbstractAndSharedClasses_ReachAGeneratorAsAbstractAndStaticTypes()
    {
        var stub = Project(@"
package App

abstract class Walker {
    func Visit() int32 { return 1 }
}

abstract data class Shape(Sides int32)

shared class Helpers {
    func One() int32 { return 1 }
}

shared partial class Split {
    func A() int32 { return 1 }
}

class Plain {
    func Two() int32 { return 2 }
}
");

        AssertParses(stub);
        var compilation = BindStub(stub);

        Assert.True(compilation.GetTypeByMetadataName("App.Walker")!.IsAbstract, stub);
        Assert.True(compilation.GetTypeByMetadataName("App.Shape")!.IsAbstract, stub);
        Assert.False(compilation.GetTypeByMetadataName("App.Walker")!.IsStatic);

        var helpers = compilation.GetTypeByMetadataName("App.Helpers")!;
        Assert.True(helpers.IsStatic, stub);
        Assert.True(compilation.GetTypeByMetadataName("App.Split")!.IsStatic, stub);

        var plain = compilation.GetTypeByMetadataName("App.Plain")!;
        Assert.False(plain.IsAbstract);
        Assert.False(plain.IsStatic);
    }
}
