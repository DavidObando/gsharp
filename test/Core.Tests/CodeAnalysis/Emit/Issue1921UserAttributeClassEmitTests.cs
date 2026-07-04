// <copyright file="Issue1921UserAttributeClassEmitTests.cs" company="GSharp">
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
/// Issue #1921: a hand-written G# class explicitly deriving from
/// <c>System.Attribute</c> — <c>class NoteAttribute : Attribute { … }</c>, with
/// no <c>@Attribute</c> declaration sugar — used to be rejected with GS0200
/// ("Type 'NoteAttribute' is not an attribute class") even though it plainly
/// derives from <c>System.Attribute</c>. The root cause was
/// <c>DeclarationBinder.IsAttributeType</c> checking only the
/// <c>StructSymbol.IsAttributeClass</c> flag (set exclusively by the
/// <c>@Attribute</c> sugar path) or the type's own (still-null,
/// pre-emission) <c>ClrType</c>, never walking the symbol-level
/// <c>BaseClass</c>/<c>ImportedBaseType</c> chain a same-compilation class
/// actually has. Once GS0200 recognition was fixed
/// (<see cref="StructSymbol.DerivesFromSystemAttribute"/>), a second gap
/// surfaced: <c>CustomAttributeEncoder.EmitBoundAttribute</c> also keyed off
/// <c>ClrType</c> and silently dropped the attribute application from the
/// emitted metadata entirely. Both are exercised here end to end: the type
/// declares, the annotation applies, and the applied attribute — including
/// its constructor argument — round-trips through real
/// <see cref="System.Type.GetCustomAttributes(bool)"/> reflection on the
/// compiled assembly.
/// </summary>
public class Issue1921UserAttributeClassEmitTests
{
    [Fact]
    public void PlainColonAttributeBase_WithPrimaryCtorArg_AppliesAndRoundTripsThroughReflection()
    {
        const string Source = @"package Issue1921Plain
import System

class NoteAttribute(Text string) : Attribute {
}

@Note(""hello-world"")
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == ""NoteAttribute"" {
            var a NoteAttribute = attrs[i] as NoteAttribute
            Console.WriteLine(""Note:"" + a.Text)
        }
    }
}

run()
";

        var output = CompileAndRun(Source, nameof(PlainColonAttributeBase_WithPrimaryCtorArg_AppliesAndRoundTripsThroughReflection));
        Assert.Contains("Note:hello-world", output);
    }

    [Fact]
    public void FullyQualifiedSystemAttributeBase_ParameterlessMarker_AppliesAndRoundTrips()
    {
        const string Source = @"package Issue1921Qualified
import System

class MarkerAttribute : System.Attribute {
}

@Marker
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    var found bool = false
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == ""MarkerAttribute"" {
            found = true
        }
    }
    Console.WriteLine(""found="" + found.ToString())
}

run()
";

        var output = CompileAndRun(Source, nameof(FullyQualifiedSystemAttributeBase_ParameterlessMarker_AppliesAndRoundTrips));
        Assert.Contains("found=True", output);
    }

    [Fact]
    public void AttributeSugarClass_StillDerivesFromSystemAttribute_AndApplies()
    {
        // ADR-0047 §5's `@Attribute` sugar predates this issue and must keep
        // working unchanged alongside the newly recognized plain `: Attribute`
        // spelling fixed here.
        const string Source = @"package Issue1921Sugar
import System

@Attribute
class SugarAttribute {
}

@Sugar
class Widget {
}

func run() {
    var t Type = typeof(Widget)
    var attrs = t.GetCustomAttributes(true)
    var found bool = false
    for var i int32 = 0; i < attrs.Length; i += 1 {
        if attrs[i].GetType().Name == ""SugarAttribute"" {
            found = true
        }
    }
    Console.WriteLine(""found="" + found.ToString())
}

run()
";

        var output = CompileAndRun(Source, nameof(AttributeSugarClass_StillDerivesFromSystemAttribute_AndApplies));
        Assert.Contains("found=True", output);
    }

    private static string CompileAndRun(string source, string contextName)
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
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = System.Console.Out;
            var captured = new StringWriter();
            System.Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                System.Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
