// <copyright file="Issue3223OverridePropertyFinalFlagTests.cs" company="GSharp">
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
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3223: a three-level property override chain
/// (`Base.open prop` → `Mid.override prop` → `Deriv.override prop`)
/// emitted `Mid`'s computed accessor as `Final`, so the loader
/// rejected `Deriv`'s implicit override of it
/// (`TypeLoadException: "Declaration referenced in a method implementation
/// cannot be a final method"`) — the type never loaded, regardless of any
/// `base[Base]` qualifier in the body. The binder's override rule accepts
/// a base property that is `IsVirtual || IsOverride` (property overrides
/// are re-overridable), so the accessor symbols of an `override prop`
/// (and `override event`) are now open and their MethodDefs carry
/// `Virtual` without `Final`. The assembly-load-and-run tests are
/// the sharp witness (they died with the TypeLoadException pre-fix); the
/// metadata test pins the flag contract itself.
open class Issue3223OverridePropertyFinalFlagTests {
    @Fact
    func ThreeLevelOverrideChain_WithBracketedBase_LoadsAndReturns109() {
        // The issue's exact repro: the emitted assembly must LOAD (this line
        // threw TypeLoadException pre-fix) and `base[Base].RenderSize` must
        // reach the grandparent slot non-virtually: 10 + 99 = 109.
        let result = EmittedOracle.Evaluate(ThreeLevelPropertySource)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(109L, result.Value)
    }

    @Fact
    func OverridePropertyAccessor_EmitsVirtualWithoutFinalOrNewSlot() {
        // The metadata contract: an override accessor reuses the base virtual
        // slot — Virtual, no NewSlot (it is the same slot), and no Final (the
        // binder lets any override property be overridden again).
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(ThreeLevelPropertySource))
        let compilation = Compilation(tree)
        let emitResult = compilation.Emit(peStream)
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join(
                "; ",
                emitResult.Diagnostics.Select((d Diagnostic) -> d.Message)
            )
        )
        peStream.Position = 0
        using let peReader = PEReader(peStream, PEStreamOptions.LeaveOpen)
        let md = peReader.GetMetadataReader()
        let midGetter = FindMethod(md, "Mid", "get_RenderSize")
        Assert.True((midGetter & MethodAttributes.Virtual) != 0, "Mid.get_RenderSize must be Virtual")
        Assert.True(
            (midGetter & MethodAttributes.NewSlot) == 0,
            "Mid.get_RenderSize must reuse Base's slot (no NewSlot)"
        )
        Assert.True(
            (midGetter & MethodAttributes.Final) == 0,
            "Mid.get_RenderSize must not be Final — Deriv overrides it"
        )
        let derivGetter = FindMethod(md, "Deriv", "get_RenderSize")
        Assert.True((derivGetter & MethodAttributes.Virtual) != 0, "Deriv.get_RenderSize must be Virtual")
        Assert.True(
            (derivGetter & MethodAttributes.NewSlot) == 0,
            "Deriv.get_RenderSize must reuse the inherited slot (no NewSlot)"
        )
        Assert.True(
            (derivGetter & MethodAttributes.Final) == 0,
            "Deriv.get_RenderSize must not be Final — override props stay overridable"
        )
    }

    @Fact
    func ThreeLevelOverrideChain_PlainBaseAccess_LoadsAndDispatches() {
        // Control without the bracketed qualifier — the pre-fix failure was
        // independent of `base[Base]`; any further-overridden override
        // accessor produced the unloadable Final declaration.
        let result = EmittedOracle.Evaluate(`
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
`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        // base.Tag dispatches non-virtually to Mid (20) + 300.
        Assert.Equal(320L, result.Value)
    }

    @Fact
    func ThreeLevelOverrideEventChain_LoadsAndDispatchesToLeafAccessor() {
        // The event-accessor twin of the same root cause: computed accessors
        // of an `override event` were stamped Final too, so a grandchild
        // override produced the identical TypeLoadException.
        let result = EmittedOracle.Evaluate(`
import System

open class Base {
    open event Changed () -> void {
        add { Console.Write("BA") }
        remove { }
    }
}

open class Mid() : Base {
    override event Changed () -> void {
        add { Console.Write("MA") }
        remove { }
    }
}

open class Deriv() : Mid {
    override event Changed () -> void {
        add { Console.Write("DA") }
        remove { }
    }
}

var d = Deriv()
d.Changed += func() {}
0
`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        // Virtual dispatch through the loaded chain lands on Deriv's add.
        Assert.Equal("DA", result.Output)
    }

    shared {
        private const ThreeLevelPropertySource string = `
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
`

        private func FindMethod(md MetadataReader, typeName string, methodName string) MethodAttributes {
            let typeDef = md
                .TypeDefinitions
                .Select(md.GetTypeDefinition)
                .Single((t TypeDefinition) -> md.GetString(t.Name) == typeName)
            let method = typeDef
                .GetMethods()
                .Select(md.GetMethodDefinition)
                .Single((m MethodDefinition) -> md.GetString(m.Name) == methodName)
            return method.Attributes
        }
    }
}
