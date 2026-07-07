// <copyright file="Issue2210ImportedBaseUnqualifiedCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2210: an unqualified (implicit-<c>this</c>) call to a method
/// inherited from an IMPORTED (metadata) base class must resolve, mirroring
/// the existing behavior for a method inherited from a G#-defined base class.
/// Two historic defects are covered here:
/// <list type="bullet">
///   <item>The implicit-<c>this</c> call path (and the qualified
///   <c>this.Method(...)</c> path it shares logic with) only consulted the
///   enclosing type's OWN <c>ImportedBaseType</c>, rather than walking the
///   transitive G#-defined base-class chain (issue #1582's
///   <c>GetInheritedClrBaseType</c>), so a metadata base reached through one
///   or more intermediate G# classes was invisible.</item>
///   <item>Only <c>public</c> inherited CLR instance methods were considered
///   (<c>protected</c> / <c>protected internal</c> members — like
///   CommunityToolkit.Mvvm's <c>ObservableObject.OnPropertyChanged</c> — were
///   never surfaced, unlike inherited protected fields, which issue #1582
///   already covered).</item>
/// </list>
/// Note: the issue's literal repro used <c>System.Text.StringBuilder</c>, but
/// that type is <c>sealed</c> on the current target framework (so it cannot
/// legally be a G# base class at all); <c>System.Exception</c> is used here
/// instead as a representative non-sealed BCL base, matching the convention
/// already used by <see cref="Issue1582MetadataBaseInheritedMemberTests"/>.
/// </summary>
public class Issue2210ImportedBaseUnqualifiedCallTests
{
    [Fact]
    public void PublicMethod_InheritedFromImportedBase_UnqualifiedCall_Binds()
    {
        // System.Exception.GetBaseException() is public; MyE inherits it
        // directly from the imported base.
        const string source = """
            package T
            import System
            class MyE : Exception { func Add() { GetBaseException() } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ProtectedMethod_InheritedFromImportedBase_UnqualifiedCall_Binds()
    {
        // System.ComponentModel.Component declares protected `Dispose(bool)`.
        const string source = """
            package T
            import System.ComponentModel
            class MyComp : Component { func Cleanup() { Dispose(false) } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PublicMethod_InheritedFromImportedBase_TwoLevelsUp_UnqualifiedCall_Binds()
    {
        // MyE directly extends Exception (imported). MyGrandE is a G# class
        // extending MyE; GetBaseException is inherited transitively through a
        // mixed G#/imported chain.
        const string source = """
            package T
            import System
            open class MyE : Exception { }
            class MyGrandE : MyE { func Add() { GetBaseException() } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ProtectedMethod_InheritedFromImportedBase_TwoLevelsUp_UnqualifiedCall_Binds()
    {
        // Same as above but for a PROTECTED member, proving both defects
        // (chain-walk depth + protected accessibility) compose correctly.
        const string source = """
            package T
            import System.ComponentModel
            open class MyComp : Component { }
            class MyGrandComp : MyComp { func Cleanup() { Dispose(false) } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void OwnMethod_ShadowsImportedBaseMethod_ResolvesToOwnMethod()
    {
        // Own-class method named the same as an imported-base member must
        // still win (no ambiguity/regression from walking the imported base).
        // Both overloads share the same signature/return type, so this must
        // inspect the BOUND call's resolved symbol — asserting only
        // Assert.Empty(diagnostics) would pass even if the inherited (wrong)
        // method won.
        const string source = """
            package T
            import System
            class MyE : Exception {
                func GetBaseException() Exception { return this }
                func Add() { GetBaseException() }
            }
            """;
        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics);

        var call = FindInstanceCall(compilation, "GetBaseException");
        Assert.IsType<BoundUserInstanceCallExpression>(call);
    }

    [Fact]
    public void ProtectedMethod_InheritedFromImportedBase_QualifiedCallFromUnrelatedClass_ReportsGS0379()
    {
        // Issue #2218 rubber-duck review: `TryBindInheritedClrInstanceCall`
        // unions in `protected`/`protected internal` inherited CLR methods so
        // implicit-`this`/`this.` calls resolve (issue #2210), but this
        // helper is also reached from the general qualified-accessor path,
        // which handles ANY `receiver.Method(...)` call. Without an
        // accessibility gate, `Dispose(bool)` (protected on
        // System.ComponentModel.Component) became callable through an
        // arbitrary receiver from completely unrelated code — an
        // accessibility leak. This must report the same GS0379 diagnostic G#
        // already uses for a protected member accessed from outside its
        // declaring/derived type.
        const string source = """
            package T
            import System.ComponentModel
            class MyComp : Component { }
            class Other { func F(c MyComp) { c.Dispose(false) } }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0379");
    }

    [Fact]
    public void ProtectedMethod_InheritedFromImportedBase_ExplicitThisQualifiedCall_Binds()
    {
        // The explicit `this.Method(...)` form (not just the implicit-`this`
        // form already covered above) must keep resolving to the protected
        // inherited member from WITHIN the derived class — no false-positive
        // GS0379 from the accessibility-leak fix.
        const string source = """
            package T
            import System.ComponentModel
            class MyComp : Component { func Cleanup() { this.Dispose(false) } }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenuinelyAbsentMethod_ThroughImportedBase_ReportsGS0130()
    {
        const string source = """
            package T
            import System
            class MyE : Exception { func Add() { NoSuchMethod() } }
            """;
        Assert.Contains(Bind(source), d => d.Id == "GS0130");
    }

    private static Compilation Compile(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return new Compilation(tree);
    }

    private static BoundExpression FindInstanceCall(Compilation compilation, string methodName)
    {
        var collector = new InstanceCallCollector(methodName);
        foreach (var body in compilation.BoundProgram.Functions.Values)
        {
            collector.Visit(body);
        }

        return collector.Collected.FirstOrDefault();
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var compilation = Compile(source);

        // BoundProgram fully binds function bodies (where member access is
        // resolved), surfacing body-level diagnostics such as GS0130 —
        // GlobalScope.Diagnostics only covers declaration-level binding.
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }

    private sealed class InstanceCallCollector : BoundTreeWalker
    {
        private readonly string methodName;

        public InstanceCallCollector(string methodName)
        {
            this.methodName = methodName;
        }

        public List<BoundExpression> Collected { get; } = new();

        public override void VisitExpression(BoundExpression node)
        {
            switch (node)
            {
                case BoundUserInstanceCallExpression userCall when userCall.Method.Name == methodName:
                    Collected.Add(userCall);
                    break;
                case BoundImportedInstanceCallExpression importedCall when importedCall.Method.Name == methodName:
                    Collected.Add(importedCall);
                    break;
            }

            base.VisitExpression(node);
        }
    }
}
