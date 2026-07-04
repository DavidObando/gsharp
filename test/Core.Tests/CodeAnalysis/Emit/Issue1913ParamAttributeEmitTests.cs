// <copyright file="Issue1913ParamAttributeEmitTests.cs" company="GSharp">
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
/// Issue #1913 follow-up (code-review bugs B1/B2): the original fix wired
/// parameter annotations from the binder onto <c>ParameterSymbol</c> for
/// constructors and interface methods, but three <c>TypeDefEmitter</c> emit
/// paths — <c>EmitClassConstructorWithBody</c>, <c>EmitAbstractMethod</c>,
/// and <c>EmitStaticVirtualMethod</c> — minted Parameter rows via
/// <c>AddRefKindAwareParameterRows</c> and never called
/// <c>EmitUserAttributes</c> on them, so the attribute silently never
/// reached the emitted metadata even though the binder attached it
/// correctly. These tests read the compiled assembly's real Parameter
/// metadata via reflection (<see cref="ParameterInfo.GetCustomAttributes(bool)"/>)
/// — the same empirical technique that caught the regression — rather than
/// just asserting the binder-level symbol, which is what let this slip
/// through undetected the first time.
/// </summary>
public class Issue1913ParamAttributeEmitTests
{
    private const string NoteAttributeDecl = @"
class NoteAttribute(Text string) : Attribute {
}
";

    [Fact]
    public void ConstructorParameter_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue1913Ctor
import System
" + NoteAttributeDecl + @"

class Box {
    var Z int32 = 0
    init(@Note(""c"") z int32) {
        Z = z
    }
}
";
        var asm = CompileToAssembly(Source, nameof(ConstructorParameter_UserAttribute_RoundTripsThroughReflection));
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
        Assert.Equal("c", textValue);
    }

    [Fact]
    public void InterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue1913Iface
import System
" + NoteAttributeDecl + @"

interface IWork {
    func Do(@Note(""iface"") a int32) int32;
}

class Worker : IWork {
    func Do(a int32) int32 {
        return a
    }
}
";
        var asm = CompileToAssembly(Source, nameof(InterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection));
        var iface = asm.GetTypes().Single(t => t.Name == "IWork");
        var method = iface.GetMethod("Do", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(method);
        var param = method!.GetParameters()[0];
        Assert.Equal("a", param.Name);

        var attrs = param.GetCustomAttributes(true);
        Assert.Single(attrs);
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name);
    }

    [Fact]
    public void StaticVirtualInterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection()
    {
        const string Source = @"package Issue1913SharedIface
import System
" + NoteAttributeDecl + @"

interface IAdd {
    shared {
        func AddOne(@Note(""shared"") a int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func AddOne(a int32) int32 {
            return a + 1
        }
    }
}
";
        var asm = CompileToAssembly(Source, nameof(StaticVirtualInterfaceMethodParameter_UserAttribute_RoundTripsThroughReflection));
        var iface = asm.GetTypes().Single(t => t.Name == "IAdd");
        var method = iface.GetMethod("AddOne", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(method);
        var param = method!.GetParameters()[0];
        Assert.Equal("a", param.Name);

        var attrs = param.GetCustomAttributes(true);
        Assert.Single(attrs);
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name);
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
