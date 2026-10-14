// <copyright file="Issue2293DefaultInterfacePropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2293: a class that relies on an interface's default (arrow/block
/// bodied) PROPERTY implementation — i.e. does not re-declare the property
/// itself — was wrongly reported as not implementing the interface (GS0187).
/// Default-bodied interface FUNCTIONS were already accepted (ADR-0085 / issue
/// #726); the gap was specific to default-bodied interface PROPERTIES.
///
/// Root cause: `VerifyInterfaceImplementations`'s property-satisfaction
/// loop (`DeclarationBinder.cs`) only asked "does the class provide a
/// member for this property?" (`TypeMemberModel.TryGetProperty` /
/// primary-constructor-parameter fallback) and reported GS0187 whenever it
/// did not — it never asked whether the INTERFACE PROPERTY ITSELF already
/// had a default body. Separately, only static-virtual interface properties
/// ever got their accessor bodies bound/emitted at all
/// (`Binder.cs`'s default-body loop skipped non-static properties, and
/// `MemberDefEmitter.EmitInterfacePropertyAccessors` only routed the
/// real-body path through `IsStatic`), so even suppressing the
/// diagnostic without that plumbing would have produced an unloadable type.
///
/// The fix generalizes the default-interface-member machinery that already
/// existed for static-virtual properties to ordinary instance properties too
/// (mirroring how instance default methods already work): accessor
/// (cref:Core.CodeAnalysis.Symbols.FunctionSymbol)s are created for
/// every interface property (not just static ones), a body-bearing accessor
/// is bound and emitted as a non-abstract virtual slot, and the
/// completeness check accepts an interface property as satisfied when every
/// accessor it requires (getter/setter) has a default body — exactly as a
/// default interface method needs no override. An accessor with NO default
/// body still requires the implementer to provide it.
open class Issue2293DefaultInterfacePropertyTests {
    @Fact
    func ClassRelyingOnDefaultInterfaceProperty_NoDiagnostics() {
        // The exact issue repro: neither NeedsTimedRefresh (a default arrow
        // property) nor OnActivated (a default block-bodied method) is
        // re-declared by the implementing class.
        const source = `package Test
interface ITabScreen {
    prop NeedsTimedRefresh bool -> false
    func OnActivated() { }
}
class LibraryScreen : ITabScreen {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ClassRelyingOnDefaultInterfaceMethod_StillCompiles() {
        // Guard: default-bodied interface METHODS (already working before
        // this fix) must keep working when combined with a default property
        // on the same interface.
        const source = `package Test
interface IGreeter {
    func Greet() string { return "hi" }
}
class SilentGreeter : IGreeter {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func InterfacePropertyWithNoDefaultBody_StillRequiresImplementation() {
        // A property without a default body (bare get/set requirement) is
        // NOT satisfied automatically — omitting it must still report GS0187.
        const source = `package Test
interface ITabScreen {
    prop Title string { get; }
}
class MissingTitleScreen : ITabScreen {
}`
        let gs0187 = Bind(source).Where((d Diagnostic) -> d.Id == "GS0187").ToList()
        Assert.Single(gs0187)
    }

    @Fact
    func GetOnlyDefaultInterfaceProperty_SatisfiedWithoutOverride_NoDiagnostics() {
        const source = `package Test
interface IFlag {
    prop Enabled bool -> true
}
class DefaultFlag : IFlag {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GetSetDefaultInterfaceProperty_SatisfiedWithoutOverride_NoDiagnostics() {
        // A default property with BOTH a get and set accessor body is fully
        // satisfied by the interface's own implementation.
        const source = `package Test
interface ICounter {
    prop Count int32 {
        get { return 0 }
        set { }
    }
}
class DefaultCounter : ICounter {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func PartiallyDefaultedProperty_MissingSetterBody_StillReportsGS0187() {
        // Only the getter has a default body; the setter is abstract (no
        // body) — the implementer must still supply the property (and,
        // implicitly, the setter) to satisfy the contract.
        const source = `package Test
interface IPartial {
    prop Value int32 {
        get { return 0 }
        set;
    }
}
class MissingSetterImpl : IPartial {
}`
        let gs0187 = Bind(source).Where((d Diagnostic) -> d.Id == "GS0187").ToList()
        Assert.Single(gs0187)
    }

    @Fact
    func ClassOverridingDefaultInterfaceProperty_NoDiagnostics() {
        // A class MAY still re-declare the property to override the default
        // — that must keep compiling with no diagnostics either.
        const source = `package Test
interface ITabScreen {
    prop NeedsTimedRefresh bool -> false
}
class RefreshingScreen : ITabScreen {
    prop NeedsTimedRefresh bool -> true
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func EmittedType_ImplementsInterface_AndDispatchesDefaultPropertyThroughIt() {
        // The binder no longer reports GS0187, but the emitted assembly must
        // also be loadable and functionally correct: the interface's own
        // get_NeedsTimedRefresh must be a real (non-abstract) accessor the
        // implementing type inherits — dispatching through the interface
        // reference must observe the interface's default value.
        const source = `package Test
interface ITabScreen {
    prop NeedsTimedRefresh bool -> false
}
class LibraryScreen : ITabScreen {
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("Issue2293_EmitDispatch", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let libraryScreen = asm.GetTypes().First((t Type) -> t.Name == "LibraryScreen")
            let iTabScreen = asm.GetTypes().First((t Type) -> t.Name == "ITabScreen")
            Assert.True(iTabScreen.IsAssignableFrom(libraryScreen), "LibraryScreen must implement ITabScreen")
            let instance object? = Activator.CreateInstance(libraryScreen)
            let getter MethodInfo? = iTabScreen.GetMethod("get_NeedsTimedRefresh")
            Assert.NotNull(getter)
            let viaInterface object? = getter!!.Invoke(instance, nil)
            Assert.Equal(false, viaInterface)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
