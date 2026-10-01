// <copyright file="Issue4589ExplicitPropertyAccessorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4589: gsc emitted computed-body property accessors (including
/// explicit-interface ones) without <see cref="MethodAttributes.SpecialName"/>.
/// C# marks every property accessor SpecialName, and so did gsc's own
/// metadata-only (reference assembly) path, so reflection consumers such as
/// <see cref="RefCapabilities.IsPropertyAccessor"/> did not recognize the
/// accessor of a G#-compiled explicit-interface property. These tests read the
/// emitted MethodDef flags through reflection.
/// </summary>
public class Issue4589ExplicitPropertyAccessorEmitTests
{
    private const string Source = @"package Issue4589

interface IProbe {
    prop Value int32 { get }
    prop Other int32 { get set }
}

open class Probe : IProbe {
    private prop(IProbe) Value int32 -> 0
    private prop(IProbe) Other int32 { get { return 1 } set { } }
    prop Computed int32 -> 2
    prop Both int32 { get { return 3 } set { } }
    open prop Virtual int32 -> 4
    shared {
        prop StaticComputed int32 { get { return 5 } set { } }
    }
    prop Auto int32
    prop this[index int32] int32 -> index
}

struct ValueProbe {
    prop Computed int32 -> 6
}
";

    [Theory]
    [InlineData("Probe", "Issue4589.IProbe.Value")]
    [InlineData("Probe", "Issue4589.IProbe.Other")]
    [InlineData("Probe", "Computed")]
    [InlineData("Probe", "Both")]
    [InlineData("Probe", "Virtual")]
    [InlineData("Probe", "StaticComputed")]
    [InlineData("Probe", "Auto")]
    [InlineData("Probe", "Item")]
    [InlineData("ValueProbe", "Computed")]
    public void PropertyAccessors_AreSpecialName(string typeName, string propertyName)
    {
        var type = CompileToAssembly().GetTypes().Single(t => t.Name == typeName);
        var property = type
            .GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Single(p => p.Name == propertyName);

        var accessors = new[] { property.GetMethod, property.SetMethod }.OfType<MethodInfo>().ToArray();
        Assert.NotEmpty(accessors);
        foreach (var accessor in accessors)
        {
            Assert.True(accessor.IsSpecialName, $"{accessor.Name} should be SpecialName (attributes: {accessor.Attributes})");
            Assert.True(RefCapabilities.IsPropertyAccessor(accessor), accessor.Name);
        }
    }

    [Fact]
    public void OrdinaryMethod_IsNotSpecialName()
    {
        const string MethodSource = @"package Issue4589Method

class Holder {
    func get_Value() int32 {
        return 0
    }
}
";
        var type = CompileToAssembly(MethodSource).GetTypes().Single(t => t.Name == "Holder");
        var method = type.GetMethod("get_Value", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        Assert.NotNull(method);
        Assert.False(method.IsSpecialName);
        Assert.False(RefCapabilities.IsPropertyAccessor(method));
    }

    private static Assembly CompileToAssembly(string source = Source)
    {
        using var peStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var result = compilation.Emit(peStream);
        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        peStream.Position = 0;
        return new AssemblyLoadContext(nameof(Issue4589ExplicitPropertyAccessorEmitTests), isCollectible: true)
            .LoadFromStream(peStream);
    }
}
