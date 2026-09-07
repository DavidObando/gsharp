// <copyright file="Issue4043DependentTypeParameterConstraintTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4043: a type parameter constrained by ANOTHER type parameter — C#'s
/// <c>where TDerived : TBase</c>, spelled <c>[TBase, TDerived TBase]</c>.
/// </summary>
/// <remarks>
/// <para><b>The repro is a bind-time rejection, not a parse error.</b>
/// Re-measured on <c>origin/main</c> @ <c>3e5103de</c> with a locally built
/// <c>gsc</c>: the parser already accepts the spelling and
/// <c>ResolveInterfaceConstraint</c> then reports
/// <c>GS0153: Type 'TBase' cannot be used as a type-parameter constraint
/// because it is neither an interface nor a class.</c> The resolver walked a
/// user-interface branch, an imported-CLR-interface branch, a user-class branch
/// and an imported-class branch, and had no branch for a
/// <c>TypeParameterSymbol</c>, so a perfectly resolved <c>TBase</c> fell off
/// the end into the error. All three placements failed identically, which is
/// why they are one theory here rather than three tests.</para>
/// <para><b>Why the bound gets its own symbol slot.</b> Roughly forty consumers
/// read <c>TypeParameterSymbol.ClassConstraint != null</c> as "this parameter is
/// a reference type" — <c>nil</c> acceptance, boxing decisions, <c>callvirt</c>
/// without a <c>constrained.</c> prefix. A dependent bound proves nothing of the
/// sort: <c>TBase</c> may itself be unconstrained, so <c>TDerived</c> can be
/// instantiated with a struct. Reusing that slot would have admitted <c>nil</c>
/// at a value-type slot, which is exactly the #4027 unverifiable-<c>ldnull</c>
/// defect one release later. <c>TypeParameterBound</c> is therefore separate,
/// and the "does not propagate reference-ness" row below pins that decision.
/// </para>
/// <para><b>The metadata is measured, not assumed.</b>
/// <see cref="TheEmittedConstraintRowsNameTheOtherGenericParameter"/> reflects
/// over the emitted assembly and asserts the <c>GenericParamConstraint</c> row
/// resolves to a generic PARAMETER at the right position and of the right kind:
/// <c>VAR(0)</c> for a class's own list, <c>MVAR(0)</c> for a method's own list,
/// and <c>VAR(0)</c> for a method parameter bounded by its enclosing class's
/// parameter. That is the encoding <c>csc</c> emits for the same C# source. IL
/// verification alone would not have caught a dropped row.</para>
/// <para><b>The check needs the whole vector.</b> "Does TDerived's argument
/// satisfy TBase's bound" is unanswerable one position at a time, so
/// <c>Binder.SatisfiesConstraint</c> now takes the substitution map and the
/// generic type-clause path binds every argument before checking any — the
/// bounding parameter is not required to come first, and
/// <c>[TDerived TBase, TBase]</c> is legal C#.</para>
/// <para><b>Indeterminate accepts.</b> When either side of the relation still
/// mentions an unsubstituted type parameter there is no closed answer, and the
/// pre-#4043 behaviour (accept) is kept: a wrong "no" would be a GS0152 on a
/// legal program, and the CLR only loads an instantiation once it is closed.
/// The forwarding row in <see cref="SatisfyingShapes"/> is that case.</para>
/// <para><b>Cycles.</b> A chain of dependent bounds must be acyclic, and the
/// check has to be a post-pass: while the first parameter is being resolved the
/// second's bound is still empty, so <c>[A B, B A]</c> is invisible from inside
/// the resolution loop. Reported as the new <c>GS0581</c> (C# spells it
/// CS0454), and the offending bound is CLEARED as well as reported so no later
/// walk of the chain can fail to terminate.</para>
/// </remarks>
public class Issue4043DependentTypeParameterConstraintTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The three placements the issue reports, plus the shapes any fix must not
    /// break. Every row compiles, IL-verifies, runs, and prints.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> SatisfyingShapes()
    {
        // The issue's own repro shape: a generic METHOD whose second parameter
        // is bounded by its first.
        yield return new object[]
        {
            "a-generic-method-whose-parameter-bounds-its-sibling",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() string {
                        return "dependent"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[Base, Derived]())
            Console.WriteLine(Fixture.Dependent[Base, Base]())
            """,
            new[] { "dependent", "dependent" },
        };

        // THE GATE'S OWN SITE. `ConstraintFixture` in
        // `test/Core.Tests/CodeAnalysis/Binding/Issue3834GenericMethodClosureDiagnosticsTests.cs`
        // (landed by #4005) is the single compile error the self-migration gate
        // reported for `test/Core.Tests`, and cs2gs's translation of it is
        // faithful — `[TBase, TDerived TBase]` is the right G# spelling, so the
        // repair belongs in gsc and not in the translator. This row is that
        // fixture's three members, transcribed: the dependent bound, an
        // unconstrained identity beside it, and the MIXED case where one
        // parameter carries an ordinary class bound and its sibling carries
        // none. Two of the three bodies are empty in the original, which is why
        // the gate needs only declaration binding and emission.
        yield return new object[]
        {
            "the-self-migration-gates-own-constraint-fixture",
            """
            package P
            import System

            open class CrossContextBase {
            }

            class CrossContextDerived : CrossContextBase {
            }

            class ConstraintFixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() {
                    }

                    func Identity[T](value T) T {
                        return value
                    }

                    func Mixed[TErased, TConcrete CrossContextBase]() {
                    }
                }
            }

            ConstraintFixture.Dependent[CrossContextBase, CrossContextDerived]()
            ConstraintFixture.Mixed[string, CrossContextDerived]()
            Console.WriteLine(ConstraintFixture.Identity[string]("fixture"))
            """,
            new[] { "fixture" },
        };

        // A generic TYPE whose second parameter is bounded by its first.
        yield return new object[]
        {
            "a-generic-class-whose-parameter-bounds-its-sibling",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Pair[TBase, TDerived TBase] {
                public var Tag string
            }

            let p = Pair[Base, Derived]{Tag: "pair"}
            Console.WriteLine(p.Tag)
            """,
            new[] { "pair" },
        };

        // A generic METHOD parameter bounded by the ENCLOSING type's parameter.
        // The interesting metadata case: an MVAR-owned GenericParam whose
        // constraint is a VAR.
        yield return new object[]
        {
            "a-method-parameter-bounded-by-the-enclosing-types-parameter",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Box[T] {
                shared {
                    func Accept[U T](u U) string {
                        return "accepted"
                    }
                }
            }

            Console.WriteLine(Box[Base].Accept[Derived](Derived()))
            """,
            new[] { "accepted" },
        };

        // The bounding parameter need not come FIRST. C# accepts
        // `<TDerived, TBase> where TDerived : TBase`, so a single pass that
        // checked each argument as it bound it would ask about an argument it
        // had not read yet.
        yield return new object[]
        {
            "a-bound-that-names-a-later-parameter",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Backwards[TDerived TBase, TBase] {
                public var Tag string
            }

            let b = Backwards[Derived, Base]{Tag: "backwards"}
            Console.WriteLine(b.Tag)
            """,
            new[] { "backwards" },
        };

        // An INTERFACE at the bounding position: the relation is
        // implementation, not derivation.
        yield return new object[]
        {
            "a-bound-satisfied-by-implementing-an-interface",
            """
            package P
            import System

            interface IShape {
                func Area() int32;
            }

            class Square : IShape {
                public func Area() int32 {
                    return 4
                }
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase](d TDerived) string {
                        return "iface"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[IShape, Square](Square()))
            """,
            new[] { "iface" },
        };

        // REVIEW FINDING (#4068): a SAME-COMPILATION class that implements the
        // bound interface DIRECTLY. Such a symbol has no CLR type while
        // binding, so the reflective interface check returned false without
        // ever reading its declared interfaces and reported a GS0152 on a
        // legal program.
        yield return new object[]
        {
            "review-a-source-class-implementing-the-bounding-interface",
            """
            package P
            import System

            class D : IDisposable {
                public func Dispose() {
                }
            }

            class Fixture {
                shared {
                    func Take[TBase, TDerived TBase]() string {
                        return "took"
                    }
                }
            }

            Console.WriteLine(Fixture.Take[IDisposable, D]())
            """,
            new[] { "took" },
        };

        // REVIEW FINDING (#4068): the same shape one level removed — the source
        // class reaches the bound interface through a G#-declared interface
        // rather than by implementing it itself.
        yield return new object[]
        {
            "review-a-source-class-reaching-the-bound-through-a-declared-interface",
            """
            package P
            import System

            interface ICloser : IDisposable {
            }

            class C : ICloser {
                public func Dispose() {
                }
            }

            class Fixture {
                shared {
                    func Take[TBase, TDerived TBase]() string {
                        return "took"
                    }
                }
            }

            Console.WriteLine(Fixture.Take[IDisposable, C]())
            """,
            new[] { "took" },
        };

        // FORWARDING: the bound is still OPEN at the inner call, so the
        // relation has no closed answer and the instantiation is accepted. A
        // check that rejected here would break every generic that passes its
        // own parameters on.
        yield return new object[]
        {
            "a-forwarded-open-instantiation-is-accepted",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Fixture {
                shared {
                    func Inner[TBase, TDerived TBase]() string {
                        return "inner"
                    }

                    func Outer[X, Y X]() string {
                        return Inner[X, Y]()
                    }
                }
            }

            Console.WriteLine(Fixture.Outer[Base, Derived]())
            """,
            new[] { "inner" },
        };

        // Issue #4091: a type parameter's dependent bound can itself carry the
        // class constraint required by a constructed G# generic.
        yield return new object[]
        {
            "a-class-constraint-reached-through-a-dependent-bound",
            """
            package P
            import System

            open class SchemeOptions {
                public var Name string = ""
            }

            open class GsHandler[TOptions SchemeOptions] {
                public var Tag string = "g"
            }

            func f[U SchemeOptions, T U]() string {
                let x = GsHandler[T]{ Tag: "c" }
                return x.Tag
            }

            Console.WriteLine(f[SchemeOptions, SchemeOptions]())
            """,
            new[] { "c" },
        };

        // A dependent bound does NOT make the bounded parameter a reference
        // type, so a VALUE type is a legal argument when the bounding parameter
        // was given one. This is the shape that would have broken had the bound
        // been stuffed into `ClassConstraint`.
        yield return new object[]
        {
            "a-value-type-at-a-dependently-bounded-parameter",
            """
            package P
            import System

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase](d TDerived) string {
                        return "value"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[int32, int32](7))
            """,
            new[] { "value" },
        };

        // `object` at the bounding position is the universal bound — every
        // argument converts, value types included.
        yield return new object[]
        {
            "object-at-the-bounding-position-admits-anything",
            """
            package P
            import System

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase](d TDerived) string {
                        return "universal"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[object, string]("s"))
            """,
            new[] { "universal" },
        };
    }

    /// <summary>
    /// Every instantiation that VIOLATES a dependent bound. Before this change
    /// the DECLARATION did not bind at all (GS0153), so none of these could be
    /// reached; after it, each reports <c>GS0152</c> naming the bounding
    /// parameter — never a <c>TypeLoadException</c> at run time.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> ConstraintViolations()
    {
        yield return new object[]
        {
            "an-unrelated-class-at-a-dependently-bounded-method-parameter",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Unrelated {
                public var M int32
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() string {
                        return "dependent"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[Base, Unrelated]())
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "the-relation-the-wrong-way-round",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() string {
                        return "dependent"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[Derived, Base]())
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "an-unrelated-class-at-a-dependently-bounded-type-parameter",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Unrelated {
                public var M int32
            }

            class Pair[TBase, TDerived TBase] {
                public var Tag string
            }

            let p = Pair[Base, Unrelated]{Tag: "pair"}
            Console.WriteLine(p.Tag)
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "an-unrelated-class-at-a-parameter-bounded-by-the-enclosing-type",
            """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Unrelated {
                public var M int32
            }

            class Box[T] {
                shared {
                    func Accept[U T](u U) string {
                        return "accepted"
                    }
                }
            }

            Console.WriteLine(Box[Base].Accept[Unrelated](Unrelated()))
            """,
            "GS0152",
        };

        yield return new object[]
        {
            "a-type-that-does-not-implement-the-bounding-interface",
            """
            package P
            import System

            interface IShape {
                func Area() int32;
            }

            class NotAShape {
                public var N int32
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() string {
                        return "iface"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[IShape, NotAShape]())
            """,
            "GS0152",
        };
    }

    /// <summary>
    /// Every circular chain of dependent bounds. The cycle can only be seen
    /// once the whole list is resolved.
    /// </summary>
    /// <returns>Case name, G# source.</returns>
    public static IEnumerable<object[]> CircularConstraints()
    {
        yield return new object[]
        {
            "a-self-referential-bound",
            """
            package P
            import System

            class Selfy[T T] {
            }

            Console.WriteLine("x")
            """,
        };

        yield return new object[]
        {
            "a-two-parameter-cycle",
            """
            package P
            import System

            class Cyc[A B, B A] {
            }

            Console.WriteLine("x")
            """,
        };

        yield return new object[]
        {
            "a-three-parameter-cycle",
            """
            package P
            import System

            class Cyc3[A B, B C, C A] {
            }

            Console.WriteLine("x")
            """,
        };
    }

    /// <summary>
    /// Every satisfying shape compiles with no constraint diagnostic,
    /// IL-verifies, runs, and prints what it says it prints.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(SatisfyingShapes))]
    public void ADependentlyBoundedDeclaration_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4043_ok_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The reported defect, in its own words.
            Assert.DoesNotContain("GS0153", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS0581", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath);

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A violated dependent bound reports <c>GS0152</c> at compile time —
    /// exactly once — instead of emitting an instantiation the CLR refuses.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(ConstraintViolations))]
    public void AViolatedDependentBound_IsRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4043_neg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            // The bound must be BOUND, not rejected at the declaration.
            Assert.DoesNotContain("GS0153", appLog, StringComparison.Ordinal);

            // Issue #4032's CI follow-up, inherited: assert the COUNT, not the
            // presence. `Assert.Contains` is what let a duplicate-diagnostic
            // defect through a fixture in the previous batch — the binder probes
            // the same receiver through several entry points, and a per-call
            // report turns one violation into a count that is a function of how
            // many internal paths the binder happened to take.
            var occurrences = appLog.Split(expectedId, StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"'{name}' must report {expectedId} exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A circular chain of dependent bounds reports <c>GS0581</c> — once per
    /// cycle, not once per member of it — and does not hang the binder.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(CircularConstraints))]
    public void ACircularDependentBound_IsRefused(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4043_cyc_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);

            var occurrences = appLog.Split("GS0581", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"'{name}' must report GS0581 exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The emitted <c>GenericParamConstraint</c> rows point at the OTHER
    /// generic parameter, with the right kind and position: a class's own list
    /// encodes <c>VAR(0)</c>, a method's own list <c>MVAR(0)</c>, and a method
    /// parameter bounded by its enclosing class's parameter <c>VAR(0)</c>. This
    /// is the assertion IL verification cannot make — a dropped constraint row
    /// verifies perfectly well and is simply the wrong metadata.
    /// </summary>
    [Fact]
    public void TheEmittedConstraintRowsNameTheOtherGenericParameter()
    {
        const string Source = """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Derived : Base {
                public var M int32
            }

            class Pair[TBase, TDerived TBase] {
                public var Tag string
            }

            class Box[T] {
                shared {
                    func Accept[U T](u U) string {
                        return "accepted"
                    }
                }
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() string {
                        return "dependent"
                    }
                }
            }

            Console.WriteLine(Box[Base].Accept[Derived](Derived()))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4043_meta_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Meta.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");
            Assert.True(File.Exists(appPath), $"the fixture must compile. Log:\n{appLog}");

            var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
            var resolver = new PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(new[] { appPath }));
            using var mlc = new MetadataLoadContext(resolver, "System.Private.CoreLib");
            var asm = mlc.LoadFromAssemblyPath(appPath);

            var pair = asm.GetType("P.Pair`2")
                ?? throw new InvalidOperationException("P.Pair`2 not found");
            AssertBoundsGenericParameter(
                pair.GetGenericArguments()[1],
                expectedPosition: 0,
                expectedOnMethod: false,
                what: "Pair[TBase, TDerived TBase]");

            var box = asm.GetType("P.Box`1")
                ?? throw new InvalidOperationException("P.Box`1 not found");
            var accept = box.GetMethod("Accept", BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException("Box`1.Accept not found");
            AssertBoundsGenericParameter(
                accept.GetGenericArguments()[0],
                expectedPosition: 0,
                expectedOnMethod: false,
                what: "Box[T].Accept[U T]");

            var fixture = asm.GetType("P.Fixture")
                ?? throw new InvalidOperationException("P.Fixture not found");
            var dependent = fixture.GetMethod("Dependent", BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException("Fixture.Dependent not found");
            AssertBoundsGenericParameter(
                dependent.GetGenericArguments()[1],
                expectedPosition: 0,
                expectedOnMethod: true,
                what: "Fixture.Dependent[TBase, TDerived TBase]");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The <c>GS0152</c> text names the type argument, the bounded type
    /// PARAMETER, and the BOUNDING PARAMETER'S NAME — not whatever it happened
    /// to be substituted with at this call. That name is what the author wrote
    /// and stays stable across call sites, which is what C#'s CS0311 also
    /// names.
    /// </summary>
    [Fact]
    public void TheDiagnosticNamesTheArgumentTheParameterAndTheBoundingParameter()
    {
        const string Source = """
            package P
            import System

            open class Base {
                public var N int32
            }

            class Unrelated {
                public var M int32
            }

            class Fixture {
                shared {
                    func Dependent[TBase, TDerived TBase]() string {
                        return "dependent"
                    }
                }
            }

            Console.WriteLine(Fixture.Dependent[Base, Unrelated]())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4043_msg_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "Message.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.Contains("GS0152", appLog, StringComparison.Ordinal);
            Assert.Contains("'Unrelated'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TDerived'", appLog, StringComparison.Ordinal);
            Assert.Contains("'TBase'", appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Review finding (#4068): extension-overload identity compares a
    /// dependent bound POSITIONALLY, not by the bound parameter's NAME.
    /// </summary>
    /// <remarks>
    /// Folding <c>TypeParameterBound</c> into <c>ConstraintReferenceType</c>
    /// made <c>ExtensionTypeParameterConstraintsEqual</c> compare it by name.
    /// Interface and base-class bounds are named by stable TYPE names, but a
    /// type parameter's name is arbitrary, and the result was wrong in both
    /// directions — both measured before the repair:
    /// <list type="bullet">
    /// <item>two spellings of ONE overload differing only by a rename
    /// (<c>[A, B A]</c> vs <c>[X, Y X]</c>) were treated as two, so the
    /// duplicate went unreported;</item>
    /// <item>a bound on a type parameter named <c>Marker</c> and a bound on the
    /// CLASS <c>Marker</c> compared EQUAL, so two genuinely distinct overloads
    /// drew a false <c>GS0264</c>.</item>
    /// </list>
    /// Ordinal plus owner-kind identifies the bound parameter exactly, and is
    /// what the emitted <c>VAR</c>/<c>MVAR</c> encoding already keys on.
    /// </remarks>
    [Fact]
    public void ExtensionOverloadIdentityComparesTheBoundPositionally()
    {
        // Renaming the type parameters does not make a second overload.
        const string Renamed = """
            package P
            import System

            func (self string) Ext[A, B A](v B) string { return "first" }

            func (self string) Ext[X, Y X](v Y) string { return "second" }

            Console.WriteLine("compiled")
            """;

        // A DEPENDENT bound on a type parameter named `Marker` and a CLASS
        // bound on the class `Marker` are different constraints.
        const string Distinct = """
            package P
            import System

            open class Marker {
                public var N int32
            }

            func (self string) Ext2[Marker, U Marker](v U) string { return "dependent" }

            func (self string) Ext2[T, U Marker](v U) string { return "class" }

            Console.WriteLine("compiled")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4043_ident_").FullName;
        try
        {
            var renamedPath = Path.Combine(tempDir, "Renamed.dll");
            var renamedLog = Compile(tempDir, "Renamed.gs", Renamed, renamedPath, "/target:exe");
            Assert.False(
                File.Exists(renamedPath),
                $"a rename does not make a second overload; the duplicate must be reported. Log:\n{renamedLog}");
            var duplicates = renamedLog.Split("GS0264", StringSplitOptions.None).Length - 1;
            Assert.True(
                duplicates == 1,
                $"the renamed pair must report GS0264 exactly once, saw {duplicates}. Log:\n{renamedLog}");

            var distinctPath = Path.Combine(tempDir, "Distinct.dll");
            var distinctLog = Compile(tempDir, "Distinct.gs", Distinct, distinctPath, "/target:exe");
            Assert.DoesNotContain("GS0264", distinctLog, StringComparison.Ordinal);
            Assert.True(
                File.Exists(distinctPath),
                "a dependent bound and a class bound that merely share a name are distinct "
                    + $"overloads and must both be declarable. Log:\n{distinctLog}");

            IlVerifier.Verify(distinctPath);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The rejection GS0153 still exists for what it was actually meant for —
    /// a value type. Its message widened (a type parameter is now legal), and
    /// the branch must not have widened to admit a struct along the way.
    /// </summary>
    [Fact]
    public void AValueTypeConstraintIsStillRejected()
    {
        const string Source = """
            package P
            import System

            struct Point {
                public var X int32
            }

            class Fixture {
                shared {
                    func Bad[T Point]() string {
                        return "bad"
                    }
                }
            }

            Console.WriteLine("x")
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_4043_vt_").FullName;
        try
        {
            var appPath = Path.Combine(tempDir, "ValueType.dll");
            var appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe");

            Assert.False(File.Exists(appPath), $"a struct constraint must not compile. Log:\n{appLog}");
            var occurrences = appLog.Split("GS0153", StringSplitOptions.None).Length - 1;
            Assert.True(
                occurrences == 1,
                $"a struct constraint must report GS0153 exactly once, saw {occurrences}. Log:\n{appLog}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void AssertBoundsGenericParameter(
        Type typeParameter,
        int expectedPosition,
        bool expectedOnMethod,
        string what)
    {
        var constraints = typeParameter.GetGenericParameterConstraints();
        Assert.True(
            constraints.Length == 1,
            $"{what}: expected exactly one GenericParamConstraint row on '{typeParameter.Name}', saw "
                + $"{constraints.Length} ({string.Join(", ", constraints.Select(c => c.ToString()))}).");

        var constraint = constraints[0];
        Assert.True(
            constraint.IsGenericParameter,
            $"{what}: the constraint on '{typeParameter.Name}' must be a generic PARAMETER, saw '{constraint}'.");
        Assert.Equal(expectedPosition, constraint.GenericParameterPosition);
        Assert.Equal(expectedOnMethod, constraint.DeclaringMethod != null);
    }

    private static string[] SplitLines(string output)
        => output
            .Split('\n')
            .Select(line => line.TrimEnd('\r'))
            .Where(line => line.Length > 0)
            .ToArray();

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
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
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
