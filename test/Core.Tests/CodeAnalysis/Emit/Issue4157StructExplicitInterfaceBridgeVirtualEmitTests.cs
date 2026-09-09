// <copyright file="Issue4157StructExplicitInterfaceBridgeVirtualEmitTests.cs" company="GSharp">
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
/// Issue #4157: <see cref="GSharp.Core.CodeAnalysis.Emit.MethodInfoHelpers.RequiresVirtualOnValueType"/>
/// checked a PROPERTY accessor's explicit-interface clause but never a plain
/// METHOD's own explicit binding to an interface slot, so a value-type
/// (<c>struct</c>) covariant-return interface bridge (issue #985 — a
/// non-generic <c>IEnumerable.GetEnumerator()</c> bridge alongside a public
/// generic <c>GetEnumerator() IEnumerator[T]</c>) fell through to
/// <c>MethodImplicitlyImplementsInterface</c>, which by its own doc comment
/// only detects an IMPLICIT same-name/same-signature match — never an
/// explicit one. The bridge method still got a correct <c>MethodImpl</c> row
/// (the <c>.override</c>), but was emitted WITHOUT the CLR <c>virtual</c> bit,
/// which ECMA-335 requires of any method bound to an interface slot. The
/// resulting type failed to load the moment it was used:
/// <c>TypeLoadException: "...must be virtual to implement a method on an
/// interface or super type."</c> — a defect this project's <c>ilverify</c>
/// gate does not catch (see the corroborating dotnet/runtime issue filed
/// against ILVerify's interface-implementation check). 117 of 165 (70%) of
/// <c>test/Core.Tests</c>' first test-parity failures were this one root
/// cause, hitting synthesized wrapper types (<c>ImmutableArrayOfDiagnostic</c>
/// and friends) that implement <c>IReadOnlyCollection[T]</c> and so carry the
/// same non-generic/generic <c>GetEnumerator</c> bridge pair as a value type
/// (this <c>struct</c> repro reduces the same shape independent of that
/// corpus fixture). Reference-type (<c>class</c>) receivers were never
/// affected — <see cref="GSharp.Core.CodeAnalysis.Emit.FunctionEmitter"/>
/// always stamps <c>virtual</c> for a non-value-type receiver regardless of
/// <c>RequiresVirtualOnValueType</c>'s answer, which is why the existing
/// class-shaped #985 emit test never caught this: the defect is
/// value-type-only.
/// </summary>
public class Issue4157StructExplicitInterfaceBridgeVirtualEmitTests
{
    private const string StructBridgeSource = """
        package Issue4157Repro
        import System
        import System.Collections
        import System.Collections.Generic

        struct Bag : IEnumerable[int32] {
            private let _items List[int32] = List[int32]()
            func Add(value int32) { _items.Add(value) }
            func GetEnumerator() IEnumerator[int32] { return _items.GetEnumerator() }
            private func GetEnumerator() IEnumerator { return GetEnumerator() }
        }
        """;

    [Fact]
    public void StructCovariantBridgeMethod_EmitsVirtualNewSlotFinal()
    {
        // The metadata contract that was silently violated pre-fix: BOTH
        // GetEnumerator overloads on a value-type (struct) receiver — the
        // public generic one AND the private non-generic bridge bound via
        // MethodImpl to System.Collections.IEnumerable.GetEnumerator — must
        // carry Virtual (with NewSlot | Final, matching the C#-conventional
        // explicit-interface-implementation shape: neither overrides
        // anything, and both are effectively sealed). Pre-fix, the bridge
        // method's attributes were bare `Private, HideBySig` — no Virtual,
        // no NewSlot, no Final — even though its MethodImpl row correctly
        // bound it to the interface slot.
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(StructBridgeSource));
        var compilation = new Compilation(tree);
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join("; ", emitResult.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();

        var typeDef = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(t => md.GetString(t.Name) == "Bag");

        var getEnumeratorMethods = typeDef.GetMethods()
            .Select(md.GetMethodDefinition)
            .Where(m => md.GetString(m.Name) == "GetEnumerator")
            .ToList();

        Assert.Equal(2, getEnumeratorMethods.Count);

        foreach (var method in getEnumeratorMethods)
        {
            Assert.True(
                (method.Attributes & MethodAttributes.Virtual) != 0,
                "every GetEnumerator overload bound to an interface slot must be emitted Virtual, "
                    + $"but found {method.Attributes}");
            Assert.True(
                (method.Attributes & MethodAttributes.NewSlot) != 0,
                $"expected NewSlot (neither overload overrides an inherited slot), found {method.Attributes}");
            Assert.True(
                (method.Attributes & MethodAttributes.Final) != 0,
                $"expected Final (neither overload is declared open/override), found {method.Attributes}");
        }
    }

    [Fact]
    public void StructCovariantBridge_LoadsAndEnumeratesThroughNonGenericInterface()
    {
        // The sharp witness: pre-fix, the CLR refused to LOAD the struct the
        // moment it was boxed/used through IEnumerable — the emitted
        // GetEnumerator() with the missing Virtual bit is exactly the shape
        // that trips System.TypeLoadException at class-load time. Enumerating
        // through the non-generic IEnumerable bridge is the path that must
        // not throw.
        var result = EmittedOracle.Evaluate(StructBridgeSource + """

            var b = Bag{}
            b.Add(1)
            b.Add(2)
            b.Add(3)
            var seq IEnumerable = b
            var e IEnumerator = seq.GetEnumerator()
            var sum = 0
            while e.MoveNext() {
                sum = sum + (e.Current as int32?)!!
            }
            sum
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(6, result.Value);
    }

    /// <summary>
    /// Review finding on PR #4174: every existing explicit-clause (ADR-0149)
    /// emit test uses a CLASS receiver, and
    /// <see cref="GSharp.Core.CodeAnalysis.Emit.FunctionEmitter"/>
    /// (<c>!receiverIsValueType || ...</c>) stamps <c>Virtual</c> on a class
    /// method UNCONDITIONALLY, before <c>RequiresVirtualOnValueType</c> is
    /// ever consulted — so no existing test exercises this function on a
    /// STRUCT receiver with an explicit-interface-clause method at all. This
    /// closes that gap.
    /// <para>
    /// It does NOT isolate the <c>HasExplicitInterfaceClause</c> operand from
    /// <c>MethodImplicitlyImplementsInterface</c>, and — checked directly,
    /// not assumed — no G# program currently can: an explicit-clause method's
    /// FunctionSymbol keeps the plain interface-member name (only the
    /// metadata name is mangled, in <c>ExplicitInterfaceMetadataNaming</c>),
    /// so <c>MethodSignaturesMatch</c> finds it by name+signature alone,
    /// against ANY of the struct's declared interfaces — it does not check
    /// which specific interface slot the clause targets. Verified by
    /// temporarily deleting the <c>HasExplicitInterfaceClause</c> operand
    /// from the production fix and rebuilding: this fixture, AND the
    /// disambiguating two-interface/same-signature shape
    /// (<c>struct W : IFoo, IBaz { private func (IFoo) Bar()...;
    /// private func (IBaz) Bar()...; }</c>) that ADR-0149 exists for, both
    /// still emitted <c>Virtual</c> — because both interfaces' <c>Bar</c>
    /// methods share one signature, so the implicit-match loop finds a hit
    /// against EITHER declared interface regardless of which one a given
    /// method's clause actually names. The operand is real defensive code —
    /// removing it is not proven safe by this repo's current binder rules,
    /// which could change — but no scenario constructible today makes it
    /// load-bearing, so no test here can honestly claim to isolate it. What
    /// these tests DO prove: a struct with an explicit-clause method emits
    /// correctly and loads through the interface, which had zero coverage
    /// before this PR.
    /// </para>
    /// </summary>
    private const string StructExplicitClauseSource = """
        package Issue4174Repro
        import System

        interface IPoker {
            func Poke() int32;
        }

        struct Widget : IPoker {
            private var _n int32 = 0
            func Bump() int32 {
                _n = _n + 1
                return _n
            }
            private func (IPoker) Poke() int32 { return Bump() }
        }
        """;

    [Fact]
    public void StructExplicitClauseMethod_EmitsVirtualNewSlotFinal()
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(StructExplicitClauseSource));
        var compilation = new Compilation(tree);
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join("; ", emitResult.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var md = peReader.GetMetadataReader();

        var typeDef = md.TypeDefinitions
            .Select(md.GetTypeDefinition)
            .Single(t => md.GetString(t.Name) == "Widget");

        // ADR-0149: an explicit-interface-clause method's CLR metadata name is
        // mangled ("Issue4174Repro.IPoker.Poke" -- package-qualified, via
        // ExplicitInterfaceMetadataNaming) to stay collision-free; the plain
        // source name "Poke" is never emitted. Confirmed by dumping this
        // fixture's actual emitted method names rather than assumed.
        var poke = typeDef.GetMethods()
            .Select(md.GetMethodDefinition)
            .Single(m => md.GetString(m.Name) == "Issue4174Repro.IPoker.Poke");

        Assert.True(
            (poke.Attributes & MethodAttributes.Virtual) != 0,
            "an explicit-interface-clause method on a struct must be emitted Virtual, "
                + $"but found {poke.Attributes}");
        Assert.True(
            (poke.Attributes & MethodAttributes.NewSlot) != 0,
            $"expected NewSlot, found {poke.Attributes}");
        Assert.True(
            (poke.Attributes & MethodAttributes.Final) != 0,
            $"expected Final, found {poke.Attributes}");
    }

    [Fact]
    public void StructExplicitClauseMethod_LoadsAndRunsThroughTheInterface()
    {
        var result = EmittedOracle.Evaluate(StructExplicitClauseSource + """

            var w = Widget{}
            var p IPoker = w
            var a = p.Poke()
            var b = p.Poke()
            a + b
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }
}
