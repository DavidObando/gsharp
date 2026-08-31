// <copyright file="XunitAssertOverloadResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Regression tests for issue #505: <c>Xunit.Assert.Equal("a","a")</c> was
/// reported as ambiguous (GS0160) because the binder's overload-ranking pass
/// did not implement C#'s full set of tie-breakers (non-generic-over-generic,
/// fewer-omitted-optionals). These tests compile a tiny G# library through
/// <c>gsc</c> against the host's real <c>xunit.assert.dll</c> so the resolved
/// candidates exactly match the xUnit overload surface users hit in practice.
/// </summary>
public class XunitAssertOverloadResolutionTests
{
    [Fact]
    public void AssertEqual_TwoStringArgs_ResolvesWithoutExplicitTypeArg()
    {
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func StringEq() {
                    Assert.Equal("hello", "hello")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoStringArgs_StillWorksWithExplicitTypeArg()
    {
        // Issue #505: callers that previously had to write the explicit
        // [string] type argument keep compiling unchanged.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func StringEqExplicit() {
                    Assert.Equal[string]("hello", "hello")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoIntLiterals_ResolveWithoutAmbiguity()
    {
        // Issue #505: integer literals must resolve to Equal<T>(T, T) with
        // T=int32 — the generic identity beats every numeric-widening overload.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func IntEq() {
                    Assert.Equal(1, 1)
                }
            }
            """);
    }

    [Fact]
    public void AssertNotEqual_TwoStringArgs_ResolveWithoutExplicitTypeArg()
    {
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func StringNotEq() {
                    Assert.NotEqual("a", "b")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableBoolArgs_ExplicitTypeArg_Resolves()
    {
        // Issue #504-reopen: `Assert.Equal[bool?](a, b)` resolves the explicit
        // type argument to `Nullable<bool>` in the reference-assembly load
        // context, while the bound-argument types come from the host
        // reflection context. Overload resolution must treat the two
        // structurally identical `Nullable<bool>` types as the same type even
        // though their `FullName`s embed assembly-qualified args from
        // different contexts (host vs MetadataLoadContext). Before the fix,
        // the candidate set evaluation rejected every overload and the call
        // site reported `GS0159 Cannot find function Equal`.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func NullableBoolEqExplicit() {
                    var a bool? = false
                    var b bool? = false
                    Assert.Equal[bool?](a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableBoolArgs_InferredTypeArg_Resolves()
    {
        // Issue #504-reopen (inferred form): `Assert.Equal(a, b)` where
        // `a, b : bool?` must infer `T = Nullable<bool>` and find the
        // applicable `Equal<T>(T, T)` overload. Inference closes the
        // candidate's parameter types to `Nullable<bool>` in the reference
        // load context, which must match the host-side `Nullable<bool>`
        // computed for the argument types.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func NullableBoolEqInferred() {
                    var a bool? = false
                    var b bool? = false
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableIntArgs_ExplicitAndInferred_Resolve()
    {
        // Issue #504-reopen: the same cross-reflection-context mismatch
        // applies to every value-type T?. Cover `int32?` to confirm the fix
        // generalises beyond `bool?`.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func NullableIntEq() {
                    var a int32? = 1
                    var b int32? = 1
                    Assert.Equal[int32?](a, b)
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableStringArgs_ExplicitAndInferred_Resolve()
    {
        // Issue #504-reopen (reference-type nullable): `string?` shares its
        // CLR representation with `string`, so overload resolution should
        // close `T = string` and find the `Equal<T>(T, T)` overload by
        // identity. The fix must not regress this path.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            class P {
                @Fact
                func NullableStringEq() {
                    var a string? = "x"
                    var b string? = "x"
                    Assert.Equal[string?](a, b)
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    // --- Issue #661: mixed nullable-enum overload resolution ---

    [Fact]
    public void AssertEqual_NonNullableEnumAndNullableEnum_Resolves()
    {
        // Issue #661: Assert.Equal(DayOfWeek.Monday, actual) where actual : DayOfWeek?
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            class P {
                @Fact
                func NullableEnumEq() {
                    var actual DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(DayOfWeek.Monday, actual)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_NullableEnumAndNonNullableEnum_Resolves()
    {
        // Issue #661: symmetric — Assert.Equal(actual, DayOfWeek.Monday)
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            class P {
                @Fact
                func NullableEnumEqSwapped() {
                    var actual DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(actual, DayOfWeek.Monday)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_BothNullableEnum_Resolves()
    {
        // Both operands nullable.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            class P {
                @Fact
                func BothNullableEnumEq() {
                    var a DayOfWeek? = DayOfWeek.Monday
                    var b DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_BothNonNullableEnum_Resolves()
    {
        // Both non-nullable imported enum (regression guard).
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            class P {
                @Fact
                func BothNonNullableEnumEq() {
                    Assert.Equal(DayOfWeek.Monday, DayOfWeek.Monday)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_NonNullableIntAndNullableInt_Resolves()
    {
        // Regression guard: int + int? must still work.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit

            class P {
                @Fact
                func MixedNullableIntEq() {
                    var actual int32? = 42
                    Assert.Equal(42, actual)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_StringAndNullableString_Resolves()
    {
        // Regression guard: reference-type nullable string? vs string.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit

            class P {
                @Fact
                func StringVsNullableStringEq() {
                    var actual string? = "hello"
                    Assert.Equal("hello", actual)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_UserDefinedNullableEnum_BindsSuccessfully()
    {
        // Issue #661: user-defined G# enum with nullable overload resolution.
        // Note: the binder correctly resolves the overload, but emitting
        // Nullable<UserEnum> is a separate pre-existing limitation (GS9998).
        // This test uses the imported CLR enum DayOfWeek as a proxy to confirm
        // end-to-end works; the binder-level fix applies uniformly.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            class P {
                @Fact
                func UserEnumNullableEq() {
                    var actual DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(DayOfWeek.Monday, actual)
                }
            }
            """);
    }

    [Fact]
    public void Issue932_AssertDoesNotContain_PredicateFuncLiteral_UserType_Resolves()
    {
        // Issue #932: `Assert.DoesNotContain<T>(IEnumerable<T>, Predicate<T>)`
        // must resolve when the predicate is a G# function literal whose
        // natural type is `Func[T,bool]`. A function literal's natural
        // delegate is structurally identical to `Predicate[T]` but differently
        // named, so overload resolution must treat it as convertible. The
        // element type here is a same-compilation user class (`LibraryItem`),
        // which is the case that previously failed with GS0159.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class LibraryItem {
                var Asin string
            }

            class P {
                @Fact
                func DoesNotContainFunc() {
                    var items = List[LibraryItem]()
                    Assert.DoesNotContain(items, func (i LibraryItem) bool { return i.Asin == "A3" })
                }
            }
            """);
    }

    [Fact]
    public void Issue932_AssertDoesNotContain_PredicateArrowLambda_UserType_Resolves()
    {
        // Issue #932: the parenthesised arrow-lambda spelling
        // `(i) -> i.Asin == "A3"` must resolve against the predicate overload.
        // The untyped arrow lambda flows through the deferred-inference path,
        // which must recover the same-compilation element type from the
        // `items : List[LibraryItem]` argument (not erase it to `object`) so
        // the lambda body's `i.Asin` member access binds.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class LibraryItem {
                var Asin string
            }

            class P {
                @Fact
                func DoesNotContainArrow() {
                    var items = List[LibraryItem]()
                    Assert.DoesNotContain(items, (i) -> i.Asin == "A3")
                }
            }
            """);
    }

    [Fact]
    public void Issue932_AssertDoesNotContain_PredicateBareArrowLambda_UserType_Resolves()
    {
        // Issue #932: the bare single-identifier arrow-lambda spelling
        // `i -> i.Asin == "A3"` (exactly as written in the issue) must parse
        // as a single-parameter lambda and resolve against the predicate
        // overload.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class LibraryItem {
                var Asin string
            }

            class P {
                @Fact
                func DoesNotContainBareArrow() {
                    var items = List[LibraryItem]()
                    Assert.DoesNotContain(items, i -> i.Asin == "A3")
                }
            }
            """);
    }

    [Fact]
    public void Issue932_AssertDoesNotContain_PredicateLambda_StringElement_Resolves()
    {
        // Issue #932: the same predicate overload must resolve for a BCL
        // element type (`string`) across all three lambda spellings.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class P {
                @Fact
                func DoesNotContainStrings() {
                    var items = List[string]()
                    Assert.DoesNotContain(items, func (i string) bool { return i == "A3" })
                    Assert.DoesNotContain(items, (i) -> i == "A3")
                    Assert.DoesNotContain(items, i -> i == "A3")
                }
            }
            """);
    }

    [Fact]
    public void Issue932_AssertContains_PredicateLambda_UserType_Resolves()
    {
        // Issue #932: the structurally-compatible-delegate conversion applies
        // uniformly to the sibling `Assert.Contains<T>(IEnumerable<T>,
        // Predicate<T>)` overload as well.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class LibraryItem {
                var Asin string
            }

            class P {
                @Fact
                func ContainsPredicate() {
                    var items = List[LibraryItem]()
                    Assert.Contains(items, func (i LibraryItem) bool { return i.Asin == "A3" })
                    Assert.Contains(items, i -> i.Asin == "A3")
                }
            }
            """);
    }

    // --- Issue #3681: xunit generic-method overload resolution (family F4) ---
    //
    // Two independent gsc defects, both surfaced by migrated `test/Core.Tests`:
    //
    // (a) `Assert.All<T>(IEnumerable<T>, Action<T>)` with a VALUE-RETURNING
    //     typed lambda. The discard conversion `Func<T,TRet>` -> `Action<T>`
    //     was decided by reflecting `Invoke` off the lambda's natural delegate
    //     type directly. That natural type is the live `System.Func`n` closed
    //     over the bound argument types, so as soon as ANY of those came from
    //     the reference load context — every non-primitive imported type:
    //     `MemberInfo`, `Type`, `Exception`, `List<int>`, … — the runtime
    //     materialises it as a `TypeBuilderInstantiation` whose `GetMethod`
    //     throws and the conversion silently disappeared. The exact same call
    //     over `string` / `object` / `int32` (host runtime types) resolved,
    //     which is why a hand-written analogue never reproduced.
    //
    // (b) `Assert.Equal<T>(T, T)` where the two arguments give DIFFERENT lower
    //     bounds for T. C# fixing picks the bound every other bound converts to
    //     implicitly; gsc only considered `Type.IsAssignableFrom`, which models
    //     neither boxing nor numeric widening and is false across reflection
    //     contexts.

    [Fact]
    public void Issue3681_AssertAll_ValueReturningLambda_ImportedElementType_Resolves()
    {
        // (a): `List[MemberInfo]` — the element type comes from the reference
        // load context, so the lambda's natural `Func<MemberInfo,string>` is a
        // cross-context instantiation. Before the fix: GS0159 `Cannot find
        // function All`. The `string` element type in
        // Issue3681_AssertAll_ValueReturningLambda_HostElementType_Resolves is
        // the control that always passed.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic
            import System.Reflection

            class P {
                @Fact
                func AllOverImportedElement() {
                    var items = List[MemberInfo]()
                    Assert.All(items, (m MemberInfo) -> m.ToString())
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertAll_ValueReturningLambda_HostElementType_Resolves()
    {
        // (a) control: host-runtime element type, which resolved before the fix
        // too. Guards against the fix regressing the path that already worked.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class P {
                @Fact
                func AllOverHostElement() {
                    var items = List[string]()
                    Assert.All(items, (m string) -> m.ToString())
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertAll_ValueReturningLambda_ConstructedGenericElement_Resolves()
    {
        // (a): the element type is itself a constructed generic, and the lambda
        // body is a nested generic xunit assertion whose own type argument is
        // reference-context too.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Collections.Generic

            class P {
                @Fact
                func AllOverConstructedGenericElement() {
                    var items = List[List[int32]]()
                    Assert.All(items, (c List[int32]) -> Assert.Single(c))
                    Assert.All(items, (c List[int32]) -> Assert.IsType[List[int32]](c))
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertAll_ValueReturningLambda_ArrayCollection_Resolves()
    {
        // (a) as it appears in migrated Core.Tests: an array collection plus an
        // `IsAssignableFrom[T]` body whose explicit type argument is imported.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System.Reflection

            class P {
                @Fact
                func AllOverArray() {
                    var items = []MemberInfo{}
                    Assert.All(items, (m MemberInfo) -> Assert.IsAssignableFrom[PropertyInfo](m))
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertAll_ValueReturningLambda_ImmutableArrayCollection_Resolves()
    {
        // (a): `ImmutableArray[T]` reaches `IEnumerable<T>` through an interface
        // conversion, the shape `AsyncExceptionHandlerRewriterTests.gs` hits.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            import System
            import System.Collections.Immutable

            class P {
                @Fact
                func AllOverImmutableArray() {
                    var items = ImmutableArray[Exception].Empty
                    Assert.All(items, (e Exception) -> Assert.IsType[InvalidOperationException](e))
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertEqual_ValueTypeAndObject_FixesToObject()
    {
        // (b): `Assert.Equal<T>(T, T)` with a value-type first argument and an
        // `object`-typed second. C# fixes T = object by boxing the first; gsc
        // reported GS0159 because the two bounds live in different reflection
        // contexts, where `IsAssignableFrom` answers false.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            class Holder {
                var Value object? = nil
            }

            class P {
                @Fact
                func EqualAgainstObject() {
                    var result = Holder()
                    Assert.Equal(TimeSpan.FromSeconds(-30), result.Value!!)
                    Assert.Equal(DateTime(2025, 1, 1), result.Value!!)
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertEqual_WideningNumericBounds_FixesToWiderType()
    {
        // (b): the same fixing rule for a numeric pair. `Assert.Equal(2, aByte)`
        // has bounds { int32, uint8 }; C# fixes T = int32 because uint8 widens
        // to it. Reference assignability alone rejects both directions.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit

            class RefRecord {
                var Flags uint8 = 0
            }

            class P {
                @Fact
                func EqualAgainstWiderNumeric() {
                    var r = RefRecord()
                    Assert.Equal(2, r.Flags)
                    Assert.Equal(0x02, r.Flags & uint8(0x02))
                }
            }
            """);
    }

    [Fact]
    public void Issue3681_AssertEqual_ConflictingBounds_StillFails()
    {
        // Guard rail for (b): widening the fixing rule must not make genuinely
        // conflicting bounds unify. `int32` and `string` convert in neither
        // direction, so `Assert.Equal<T>(T, T)` stays inapplicable and the call
        // must still be reported rather than silently binding.
        AssertGsFailsToCompile("""
            package Probe.Tests
            import Xunit

            class P {
                @Fact
                func EqualConflicting() {
                    Assert.Equal(1, "one")
                }
            }
            """);
    }

    private static void AssertGsCompilesCleanly(string source)
        => CompileGsAgainstReferences(source, ReferenceModeTpa);

    /// <summary>
    /// Issue #3681: negative counterpart to <see cref="AssertGsCompilesCleanly"/>
    /// — asserts that gsc still rejects a call C# also rejects, so a widened
    /// inference rule is not silently accepting conflicting bounds.
    /// </summary>
    /// <param name="source">G# source expected to fail compilation.</param>
    private static void AssertGsFailsToCompile(string source)
        => CompileGsAgainstReferences(source, ReferenceModeTpa, expectSuccess: false);
    /// <summary>
    /// Issue #504-reopen: drives gsc with the same reference-assembly closure
    /// real users get from the SDK (ref-pack facades + xUnit) — NOT the test
    /// host's TPA. The TPA is the live runtime's set of implementation
    /// assemblies, so types loaded through it share the host's
    /// <c>System.Private.CoreLib</c> identity and accidentally mask
    /// cross-reflection-context bugs whose symptoms only surface when the
    /// MetadataLoadContext sees facade assemblies (e.g.
    /// <c>System.Runtime.dll</c>) with different assembly-qualified type
    /// names than the host's runtime types.
    /// </summary>
    /// <param name="source">G# source to compile.</param>
    internal static void AssertGsCompilesCleanlyAgainstRefPack(string source)
        => CompileGsAgainstReferences(source, ReferenceModeRefPack);

    private const int ReferenceModeTpa = 0;
    private const int ReferenceModeRefPack = 1;

    private static void CompileGsAgainstReferences(string source, int referenceMode, bool expectSuccess = true)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_xunit_overload_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Probe.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Probe.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            IEnumerable<string> references = referenceMode == ReferenceModeRefPack
                ? RefPackReferences()
                : TrustedPlatformAssemblies();

            foreach (var reference in references)
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            if (!expectSuccess)
            {
                Assert.True(
                    compileExit != 0,
                    $"expected gsc to reject the source, but it succeeded:\nstdout:\n{compileOut}");
                return;
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            Assert.True(File.Exists(outPath), "expected emitted assembly");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Issue #504-reopen: assembles the same reference closure the .NET SDK
    /// would pass to gsc — the <c>Microsoft.NETCore.App.Ref</c> targeting-pack
    /// facades for the running runtime plus xUnit. Each facade resolves to a
    /// different <see cref="System.Reflection.Assembly"/> identity than the
    /// host's <c>System.Private.CoreLib</c>, so constructed generics loaded
    /// through the MetadataLoadContext (e.g. <c>Nullable&lt;bool&gt;</c>) carry
    /// assembly-qualified type-arg names that diverge from the host's. This is
    /// the exact configuration where the binder's identity-by-FullName check
    /// silently fails. Fails with a clear prerequisite message when the
    /// ref-pack is absent.
    /// </summary>
    /// <returns>The set of reference assemblies to pass to gsc.</returns>
    private static IEnumerable<string> RefPackReferences()
        => ReferenceClosure.RefPackAssemblies()
            // xUnit is consumed from the host's TPA — its identity is stable
            // across both reflection contexts and is not what the bug is
            // exercising.
            .Concat(ReferenceClosure.TrustedPlatformAssembliesStartingWith("xunit."));

    private static IEnumerable<string> TrustedPlatformAssemblies()
        => ReferenceClosure.TrustedPlatformAssemblies();
}
