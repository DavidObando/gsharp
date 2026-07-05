// <copyright file="Issue2129InterfaceMemberAnnotationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2129: an attribute on an interface property (or event / method
/// signature) previously failed to parse (GS0005). Once parsing is fixed the
/// attribute must also be bound and emitted as a real CLR
/// <c>CustomAttribute</c> row on the generated interface member so that,
/// e.g., <c>[JsonPropertyName]</c> on an interface property survives to
/// metadata. These tests compile a self-contained interface carrying a
/// user-defined attribute on each member kind and read the emitted assembly's
/// real metadata via reflection — the same empirical technique used by the
/// param-attribute emit tests (issue #1913 / #2006).
/// </summary>
public class Issue2129InterfaceMemberAnnotationEmitTests
{
    private const string NoteAttributeDecl = @"
class NoteAttribute(Text string) : Attribute {
}
";

    [Fact]
    public void InterfaceProperty_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue2129Prop
import System
" + NoteAttributeDecl + @"

interface IPerson {
    @Note(""asin"")
    prop Asin string
}
";
        var asm = CompileToAssembly(Source, nameof(InterfaceProperty_UserAttribute_RoundTripsThroughReflection));
        var iface = asm.GetTypes().Single(t => t.Name == "IPerson");
        Assert.True(iface.IsInterface);
        var prop = iface.GetProperty("Asin", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(prop);

        var attrs = prop!.GetCustomAttributesData();
        var note = Assert.Single(attrs);
        Assert.Equal("NoteAttribute", note.AttributeType.Name);
        Assert.Equal("asin", note.ConstructorArguments.Single().Value);
    }

    [Fact]
    public void InterfaceEvent_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue2129Event
import System
" + NoteAttributeDecl + @"

interface IPerson {
    @Note(""evt"")
    event Changed Action
}
";
        var asm = CompileToAssembly(Source, nameof(InterfaceEvent_UserAttribute_RoundTripsThroughReflection));
        var iface = asm.GetTypes().Single(t => t.Name == "IPerson");
        var ev = iface.GetEvent("Changed", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(ev);

        var attrs = ev!.GetCustomAttributesData();
        var note = Assert.Single(attrs);
        Assert.Equal("NoteAttribute", note.AttributeType.Name);
        Assert.Equal("evt", note.ConstructorArguments.Single().Value);
    }

    [Fact]
    public void InterfaceMethodSignature_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue2129Method
import System
" + NoteAttributeDecl + @"

interface IPerson {
    @Note(""greet"")
    func Greet() string;
}
";
        var asm = CompileToAssembly(Source, nameof(InterfaceMethodSignature_UserAttribute_RoundTripsThroughReflection));
        var iface = asm.GetTypes().Single(t => t.Name == "IPerson");
        var method = iface.GetMethod("Greet", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(method);

        var attrs = method!.GetCustomAttributesData();
        var note = Assert.Single(attrs);
        Assert.Equal("NoteAttribute", note.AttributeType.Name);
        Assert.Equal("greet", note.ConstructorArguments.Single().Value);
    }

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        return loadContext.LoadFromStream(peStream);
    }
}
