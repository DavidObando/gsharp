// <copyright file="Issue2293DefaultInterfacePropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2293: a class that relies on an interface's default (arrow/block
/// bodied) PROPERTY implementation — i.e. does not re-declare the property
/// itself — was wrongly reported as not implementing the interface (GS0187).
/// Default-bodied interface FUNCTIONS were already accepted (ADR-0085 / issue
/// #726); the gap was specific to default-bodied interface PROPERTIES.
/// <para>
/// Root cause: <c>VerifyInterfaceImplementations</c>'s property-satisfaction
/// loop (<c>DeclarationBinder.cs</c>) only asked "does the class provide a
/// member for this property?" (<c>TypeMemberModel.TryGetProperty</c> /
/// primary-constructor-parameter fallback) and reported GS0187 whenever it
/// did not — it never asked whether the INTERFACE PROPERTY ITSELF already
/// had a default body. Separately, only static-virtual interface properties
/// ever got their accessor bodies bound/emitted at all
/// (<c>Binder.cs</c>'s default-body loop skipped non-static properties, and
/// <c>MemberDefEmitter.EmitInterfacePropertyAccessors</c> only routed the
/// real-body path through <c>IsStatic</c>), so even suppressing the
/// diagnostic without that plumbing would have produced an unloadable type.
/// </para>
/// <para>
/// The fix generalizes the default-interface-member machinery that already
/// existed for static-virtual properties to ordinary instance properties too
/// (mirroring how instance default methods already work): accessor
/// <see cref="Core.CodeAnalysis.Symbols.FunctionSymbol"/>s are created for
/// every interface property (not just static ones), a body-bearing accessor
/// is bound and emitted as a non-abstract virtual slot, and the
/// completeness check accepts an interface property as satisfied when every
/// accessor it requires (getter/setter) has a default body — exactly as a
/// default interface method needs no override. An accessor with NO default
/// body still requires the implementer to provide it.
/// </para>
/// </summary>
public class Issue2293DefaultInterfacePropertyTests
{
    [Fact]
    public void ClassRelyingOnDefaultInterfaceProperty_NoDiagnostics()
    {
        // The exact issue repro: neither NeedsTimedRefresh (a default arrow
        // property) nor OnActivated (a default block-bodied method) is
        // re-declared by the implementing class.
        const string source = """
            package Test
            interface ITabScreen {
                prop NeedsTimedRefresh bool -> false
                func OnActivated() { }
            }
            class LibraryScreen : ITabScreen {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ClassRelyingOnDefaultInterfaceMethod_StillCompiles()
    {
        // Guard: default-bodied interface METHODS (already working before
        // this fix) must keep working when combined with a default property
        // on the same interface.
        const string source = """
            package Test
            interface IGreeter {
                func Greet() string { return "hi" }
            }
            class SilentGreeter : IGreeter {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void InterfacePropertyWithNoDefaultBody_StillRequiresImplementation()
    {
        // A property without a default body (bare get/set requirement) is
        // NOT satisfied automatically — omitting it must still report GS0187.
        const string source = """
            package Test
            interface ITabScreen {
                prop Title string { get; }
            }
            class MissingTitleScreen : ITabScreen {
            }
            """;

        var gs0187 = Bind(source).Where(d => d.Id == "GS0187").ToList();
        Assert.Single(gs0187);
    }

    [Fact]
    public void GetOnlyDefaultInterfaceProperty_SatisfiedWithoutOverride_NoDiagnostics()
    {
        const string source = """
            package Test
            interface IFlag {
                prop Enabled bool -> true
            }
            class DefaultFlag : IFlag {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GetSetDefaultInterfaceProperty_SatisfiedWithoutOverride_NoDiagnostics()
    {
        // A default property with BOTH a get and set accessor body is fully
        // satisfied by the interface's own implementation.
        const string source = """
            package Test
            interface ICounter {
                prop Count int32 {
                    get { return 0 }
                    set { }
                }
            }
            class DefaultCounter : ICounter {
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PartiallyDefaultedProperty_MissingSetterBody_StillReportsGS0187()
    {
        // Only the getter has a default body; the setter is abstract (no
        // body) — the implementer must still supply the property (and,
        // implicitly, the setter) to satisfy the contract.
        const string source = """
            package Test
            interface IPartial {
                prop Value int32 {
                    get { return 0 }
                    set;
                }
            }
            class MissingSetterImpl : IPartial {
            }
            """;

        var gs0187 = Bind(source).Where(d => d.Id == "GS0187").ToList();
        Assert.Single(gs0187);
    }

    [Fact]
    public void ClassOverridingDefaultInterfaceProperty_NoDiagnostics()
    {
        // A class MAY still re-declare the property to override the default
        // — that must keep compiling with no diagnostics either.
        const string source = """
            package Test
            interface ITabScreen {
                prop NeedsTimedRefresh bool -> false
            }
            class RefreshingScreen : ITabScreen {
                prop NeedsTimedRefresh bool -> true
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void EmittedType_ImplementsInterface_AndDispatchesDefaultPropertyThroughIt()
    {
        // The binder no longer reports GS0187, but the emitted assembly must
        // also be loadable and functionally correct: the interface's own
        // get_NeedsTimedRefresh must be a real (non-abstract) accessor the
        // implementing type inherits — dispatching through the interface
        // reference must observe the interface's default value.
        const string source = """
            package Test
            interface ITabScreen {
                prop NeedsTimedRefresh bool -> false
            }
            class LibraryScreen : ITabScreen {
            }
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("Issue2293_EmitDispatch", isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            var libraryScreen = asm.GetTypes().First(t => t.Name == "LibraryScreen");
            var iTabScreen = asm.GetTypes().First(t => t.Name == "ITabScreen");
            Assert.True(iTabScreen.IsAssignableFrom(libraryScreen), "LibraryScreen must implement ITabScreen");

            var instance = Activator.CreateInstance(libraryScreen);

            var getter = iTabScreen.GetMethod("get_NeedsTimedRefresh");
            Assert.NotNull(getter);
            var viaInterface = getter.Invoke(instance, null);
            Assert.Equal(false, viaInterface);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
