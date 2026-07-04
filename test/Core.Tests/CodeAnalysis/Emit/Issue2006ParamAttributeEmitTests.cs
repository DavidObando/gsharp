// <copyright file="Issue2006ParamAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2006 (round-3 rubber-duck re-review follow-up to #1913/#1993): two
/// more <c>TypeDefEmitter</c> emit paths mint Parameter rows but never call
/// <c>EmitUserAttributesOnParameters</c> — <c>AddPrimaryCtorParameterRows</c>
/// (used by both <c>EmitClassPrimaryConstructor</c> and
/// <c>EmitClassConstructorWithBaseInitializer</c>) and the delegate
/// <c>Invoke</c> parameter loop in <c>EmitDelegateTypeDef</c>. The binder
/// attaches the attribute to the <c>ParameterSymbol</c> correctly (proven by
/// AttributeUsage validation firing), but it silently never reaches the
/// emitted metadata. These tests read the compiled assembly's real Parameter
/// metadata via reflection (<see cref="ParameterInfo.GetCustomAttributes(bool)"/>)
/// — the same empirical technique used in <c>Issue1913ParamAttributeEmitTests</c>
/// — rather than just asserting the binder-level symbol.
/// </summary>
public class Issue2006ParamAttributeEmitTests
{
    private const string NoteAttributeDecl = @"
class NoteAttribute(Text string) : Attribute {
}
";

    [Fact]
    public void PrimaryCtorParameter_NoBaseInitializer_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue2006PrimCtor
import System
" + NoteAttributeDecl + @"

class Box(@Note(""prim"") z int32) {
}
";
        var asm = CompileToAssembly(Source, nameof(PrimaryCtorParameter_NoBaseInitializer_UserAttribute_RoundTripsThroughReflection));
        var box = asm.GetTypes().Single(t => t.Name == "Box");
        var ctor = box.GetConstructors().Single(c => c.GetParameters().Length == 1);
        var param = ctor.GetParameters()[0];
        Assert.Equal("z", param.Name);

        var attrs = param.GetCustomAttributes(true);
        Assert.Single(attrs);
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name);
        var textProp = attrs[0].GetType().GetField("Text") ?? (MemberInfo)attrs[0].GetType().GetProperty("Text");
        var textValue = textProp switch
        {
            FieldInfo f => f.GetValue(attrs[0]),
            PropertyInfo p => p.GetValue(attrs[0]),
            _ => null,
        };
        Assert.Equal("prim", textValue);
    }

    [Fact]
    public void PrimaryCtorParameter_WithBaseInitializer_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue2006PrimCtorBase
import System
" + NoteAttributeDecl + @"

open class Animal(Name string) {
}

class Dog(@Note(""derived"") Name string) : Animal(Name) {
}
";
        var asm = CompileToAssembly(Source, nameof(PrimaryCtorParameter_WithBaseInitializer_UserAttribute_RoundTripsThroughReflection));
        var dog = asm.GetTypes().Single(t => t.Name == "Dog");
        var ctor = dog.GetConstructors().Single(c => c.GetParameters().Length == 1);
        var param = ctor.GetParameters()[0];
        Assert.Equal("Name", param.Name);

        var attrs = param.GetCustomAttributes(true);
        Assert.Single(attrs);
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name);
        var textProp = attrs[0].GetType().GetField("Text") ?? (MemberInfo)attrs[0].GetType().GetProperty("Text");
        var textValue = textProp switch
        {
            FieldInfo f => f.GetValue(attrs[0]),
            PropertyInfo p => p.GetValue(attrs[0]),
            _ => null,
        };
        Assert.Equal("derived", textValue);
    }

    [Fact]
    public void DelegateInvokeParameter_UserAttribute_RoundTripsThroughReflection()
    {
        // Named delegates are bound before user struct/class declarations in
        // the same compilation (ADR-0059 / issue #255 declaration ordering),
        // so a delegate-parameter attribute type must come from an already
        //-compiled reference assembly here rather than a same-file
        // `class NoteAttribute(...)`, which would not yet be resolvable when
        // the delegate's parameters are bound.
        const string Source = @"package Issue2006Delegate
import System
import GSharp.Core.Tests.Fixtures

type IntPredicate = delegate func(@ImportedDefault a int32) bool
";
        var asm = CompileToAssembly(Source, nameof(DelegateInvokeParameter_UserAttribute_RoundTripsThroughReflection));
        var del = asm.GetTypes().Single(t => t.Name == "IntPredicate");
        var invoke = del.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(invoke);
        var param = invoke!.GetParameters()[0];
        Assert.Equal("a", param.Name);

        var attrs = param.GetCustomAttributes(true);
        Assert.Single(attrs);
        Assert.Equal("ImportedDefaultAttribute", attrs[0].GetType().Name);
    }

    private static Assembly CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var fixturePath = typeof(ImportedGreeter).Assembly.Location;
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(ReferenceResolver.WithReferences(new[] { fixturePath }), tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        return loadContext.LoadFromStream(peStream);
    }
}
