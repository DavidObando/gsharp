// <copyright file="Issue3223OverridePropertyFinalFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3223: a three-level property override chain
/// (<c>Base.open prop</c> → <c>Mid.override prop</c> → <c>Deriv.override prop</c>)
/// emitted <c>Mid</c>'s computed accessor as <c>Final</c>, so the loader
/// rejected <c>Deriv</c>'s implicit override of it
/// (<c>TypeLoadException: "Declaration referenced in a method implementation
/// cannot be a final method"</c>) — the type never loaded, regardless of any
/// <c>base[Base]</c> qualifier in the body. The binder's override rule accepts
/// a base property that is <c>IsVirtual || IsOverride</c> (property overrides
/// are re-overridable), so the accessor symbols of an <c>override prop</c>
/// (and <c>override event</c>) are now open and their MethodDefs carry
/// <c>Virtual</c> without <c>Final</c>. The assembly-load-and-run tests are
/// the sharp witness (they died with the TypeLoadException pre-fix); the
/// metadata test pins the flag contract itself.
/// </summary>
public class Issue3223OverridePropertyFinalFlagTests
{
    private const string ThreeLevelPropertySource = @"
open class Base {
    open prop RenderSize int64 {
        get { return 10L }
    }
}

open class Mid() : Base {
    override prop RenderSize int64 {
        get { return 99L }
    }
}

open class Deriv() : Mid {
    override prop RenderSize int64 {
        get { return base[Base].RenderSize + base.RenderSize }
    }
}

var d = Deriv()
d.RenderSize
";

    [Fact]
    public void ThreeLevelOverrideChain_WithBracketedBase_LoadsAndReturns109()
    {
        // The issue's exact repro: the emitted assembly must LOAD (this line
        // threw TypeLoadException pre-fix) and `base[Base].RenderSize` must
        // reach the grandparent slot non-virtually: 10 + 99 = 109.
        var result = EmittedOracle.Evaluate(ThreeLevelPropertySource);
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(109L, result.Value);
    }

    [Fact]
    public void OverridePropertyAccessor_EmitsVirtualWithoutFinalOrNewSlot()
    {
        // The metadata contract: an override accessor reuses the base virtual
        // slot — Virtual, no NewSlot (it is the same slot), and no Final (the
        // binder lets any override property be overridden again).
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(ThreeLevelPropertySource));
        var compilation = new Compilation(tree);
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join("; ", emitResult.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();

        var midGetter = FindMethod(md, "Mid", "get_RenderSize");
        Assert.True((midGetter & MethodAttributes.Virtual) != 0, "Mid.get_RenderSize must be Virtual");
        Assert.True((midGetter & MethodAttributes.NewSlot) == 0, "Mid.get_RenderSize must reuse Base's slot (no NewSlot)");
        Assert.True((midGetter & MethodAttributes.Final) == 0, "Mid.get_RenderSize must not be Final — Deriv overrides it");

        var derivGetter = FindMethod(md, "Deriv", "get_RenderSize");
        Assert.True((derivGetter & MethodAttributes.Virtual) != 0, "Deriv.get_RenderSize must be Virtual");
        Assert.True((derivGetter & MethodAttributes.NewSlot) == 0, "Deriv.get_RenderSize must reuse the inherited slot (no NewSlot)");
        Assert.True((derivGetter & MethodAttributes.Final) == 0, "Deriv.get_RenderSize must not be Final — override props stay overridable");
    }

    [Fact]
    public void ThreeLevelOverrideChain_PlainBaseAccess_LoadsAndDispatches()
    {
        // Control without the bracketed qualifier — the pre-fix failure was
        // independent of `base[Base]`; any further-overridden override
        // accessor produced the unloadable Final declaration.
        var result = EmittedOracle.Evaluate(@"
open class Base {
    open prop Tag int64 {
        get { return 1L }
    }
}

open class Mid() : Base {
    override prop Tag int64 {
        get { return 20L }
    }
}

open class Deriv() : Mid {
    override prop Tag int64 {
        get { return base.Tag + 300L }
    }
}

var d = Deriv()
d.Tag
");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);

        // base.Tag dispatches non-virtually to Mid (20) + 300.
        Assert.Equal(320L, result.Value);
    }

    [Fact]
    public void ThreeLevelOverrideEventChain_LoadsAndDispatchesToLeafAccessor()
    {
        // The event-accessor twin of the same root cause: computed accessors
        // of an `override event` were stamped Final too, so a grandchild
        // override produced the identical TypeLoadException.
        var result = EmittedOracle.Evaluate(@"
import System

open class Base {
    open event Changed () -> void {
        add { Console.Write(""BA"") }
        remove { }
    }
}

open class Mid() : Base {
    override event Changed () -> void {
        add { Console.Write(""MA"") }
        remove { }
    }
}

open class Deriv() : Mid {
    override event Changed () -> void {
        add { Console.Write(""DA"") }
        remove { }
    }
}

var d = Deriv()
d.Changed += func() {}
0
");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);

        // Virtual dispatch through the loaded chain lands on Deriv's add.
        Assert.Equal("DA", result.Output);
    }

    private static MethodAttributes FindMethod(MetadataReader md, string typeName, string methodName)
    {
        var typeDef = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(t => md.GetString(t.Name) == typeName);
        var method = typeDef.GetMethods()
            .Select(md.GetMethodDefinition)
            .Single(m => md.GetString(m.Name) == methodName);
        return method.Attributes;
    }
}
